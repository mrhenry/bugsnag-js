/*
 * @mrhenry/browser-lite
 *
 * A minimal, privacy-leaning Bugsnag error reporter for browsers.
 *
 * This is a clean-sheet, dependency-free implementation written in ES3. It
 * bundles everything the notifier needs: configuration, the client, events,
 * automatic capture and XMLHttpRequest delivery.
 *
 * See SPEC.md for the full behaviour specification.
 */
(function () {
  'use strict'

  var name = 'Bugsnag JavaScript'
  var version = '__VERSION__'
  var url = 'https://github.com/bugsnag/bugsnag-js'

  function noop () {}

  /* -------------------------------------------------------------------------
   * ES3 helpers
   * ---------------------------------------------------------------------- */

  function assign (target) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i]
      if (!source) continue
      for (var key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key]
      }
    }
    return target
  }

  function keys (obj) {
    var result = []
    for (var prop in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, prop)) result.push(prop)
    }
    return result
  }

  function isArray (obj) {
    return Object.prototype.toString.call(obj) === '[object Array]'
  }

  function reduceArray (arr, fn, accum) {
    var val = accum
    for (var i = 0, len = arr.length; i < len; i++) val = fn(val, arr[i], i, arr)
    return val
  }

  function mapArray (arr, fn) {
    return reduceArray(arr, function (accum, item, i, a) {
      return accum.concat(fn(item, i, a))
    }, [])
  }

  function filterArray (arr, fn) {
    return reduceArray(arr, function (accum, item, i, a) {
      return fn(item, i, a) ? accum.concat(item) : accum
    }, [])
  }

  function includes (arr, x) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === x) return true
    return false
  }

  function trim (str) {
    return str.replace(/^\s+|\s+$/g, '')
  }

  function bind (fn, ctx) {
    var args = Array.prototype.slice.call(arguments, 2)
    return function () {
      return fn.apply(ctx, args.concat(Array.prototype.slice.call(arguments)))
    }
  }

  /* -------------------------------------------------------------------------
   * safe JSON serialisation (with key redaction)
   * ---------------------------------------------------------------------- */

  var MAX_DEPTH = 20
  var MAX_EDGES = 25000
  var MIN_PRESERVED_DEPTH = 8
  var REPLACEMENT_NODE = '...'

  function throwsMessage (err) {
    return '[Throws: ' + err.message + ']'
  }

  function find (haystack, needle) {
    for (var i = 0, len = haystack.length; i < len; i++) if (haystack[i] === needle) return true
    return false
  }

  function isDescendent (paths, path) {
    for (var i = 0, len = paths.length; i < len; i++) if (path.indexOf(paths[i]) === 0) return true
    return false
  }

  function shouldRedact (patterns, key) {
    for (var i = 0, len = patterns.length; i < len; i++) {
      if (typeof patterns[i] === 'string' && patterns[i].toLowerCase() === key.toLowerCase()) return true
      if (patterns[i] && typeof patterns[i].test === 'function' && patterns[i].test(key)) return true
    }
    return false
  }

  function safelyGetProp (obj, prop) {
    try {
      return obj[prop]
    } catch (err) {
      return throwsMessage(err)
    }
  }

  function prepareObjForSerialization (obj, redactedKeys, redactedPaths) {
    var seen = []
    var edges = 0

    function visit (obj, path) {
      function edgesExceeded () {
        return path.length > MIN_PRESERVED_DEPTH && edges > MAX_EDGES
      }

      edges++

      if (path.length > MAX_DEPTH) return REPLACEMENT_NODE
      if (edgesExceeded()) return REPLACEMENT_NODE
      if (obj === null || typeof obj !== 'object') return obj
      if (find(seen, obj)) return '[Circular]'

      seen.push(obj)

      if (typeof obj.toJSON === 'function') {
        try {
          edges--
          var fResult = visit(obj.toJSON(), path)
          seen.pop()
          return fResult
        } catch (err) {
          return throwsMessage(err)
        }
      }

      if (isError(obj)) {
        edges--
        var eResult = visit({ name: obj.name, message: obj.message }, path)
        seen.pop()
        return eResult
      }

      if (isArray(obj)) {
        var aResult = []
        for (var i = 0, len = obj.length; i < len; i++) {
          if (edgesExceeded()) {
            aResult.push(REPLACEMENT_NODE)
            break
          }
          aResult.push(visit(obj[i], path.concat('[]')))
        }
        seen.pop()
        return aResult
      }

      var result = {}
      try {
        for (var prop in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, prop)) continue
          if (isDescendent(redactedPaths, path.join('.')) && shouldRedact(redactedKeys, prop)) {
            result[prop] = '[REDACTED]'
            continue
          }
          if (edgesExceeded()) {
            result[prop] = REPLACEMENT_NODE
            break
          }
          result[prop] = visit(safelyGetProp(obj, prop), path.concat(prop))
        }
      } catch (e) {}
      seen.pop()
      return result
    }

    return visit(obj, [])
  }

  function safeJsonStringify (data, replacer, space, opts) {
    var redactedKeys = opts && opts.redactedKeys ? opts.redactedKeys : []
    var redactedPaths = opts && opts.redactedPaths ? opts.redactedPaths : []
    return JSON.stringify(prepareObjForSerialization(data, redactedKeys, redactedPaths), replacer, space)
  }

  /* -------------------------------------------------------------------------
   * metadata / feature flags
   * ---------------------------------------------------------------------- */

  var metadataDelegate = {
    add: function (state, section, keyOrObj, maybeVal) {
      if (!section) return

      var updates

      // addMetadata("section", null) -> clears section
      if (keyOrObj === null) return metadataDelegate.clear(state, section)

      if (typeof keyOrObj === 'object') updates = keyOrObj
      if (typeof keyOrObj === 'string') {
        updates = {}
        updates[keyOrObj] = maybeVal
      }

      if (!updates) return

      if (section === '__proto__' || section === 'constructor' || section === 'prototype') return

      if (!state[section]) state[section] = {}

      state[section] = assign({}, state[section], updates)
    },
    get: function (state, section, key) {
      if (typeof section !== 'string') return undefined
      if (!key) return state[section]
      if (state[section]) return state[section][key]
      return undefined
    },
    clear: function (state, section, key) {
      if (typeof section !== 'string') return

      if (!key) {
        delete state[section]
        return
      }

      if (section === '__proto__' || section === 'constructor' || section === 'prototype') return

      if (state[section]) delete state[section][key]
    }
  }

  /* -------------------------------------------------------------------------
   * validators
   * ---------------------------------------------------------------------- */

  function stringWithLength (value) {
    return typeof value === 'string' && !!value.length
  }

  function intRange (min, max) {
    if (min === undefined) min = 1
    if (max === undefined) max = Infinity
    return function (value) {
      return typeof value === 'number' && parseInt('' + value, 10) === value && value >= min && value <= max
    }
  }

  function listOfFunctions (value) {
    return typeof value === 'function' || (isArray(value) && filterArray(value, function (f) {
      return typeof f === 'function'
    }).length === value.length)
  }

  /* -------------------------------------------------------------------------
   * configuration schema
   * ---------------------------------------------------------------------- */

  function defaultErrorTypes () {
    return { unhandledExceptions: true, unhandledRejections: true }
  }

  var configSchema = {
    apiKey: {
      defaultValue: function () { return null },
      message: 'is required',
      validate: stringWithLength
    },
    appVersion: {
      defaultValue: function () { return undefined },
      message: 'should be a string',
      validate: function (value) { return value === undefined || stringWithLength(value) }
    },
    appType: {
      defaultValue: function () { return 'browser' },
      message: 'should be a string',
      validate: function (value) { return value === undefined || stringWithLength(value) }
    },
    autoDetectErrors: {
      defaultValue: function () { return true },
      message: 'should be true|false',
      validate: function (value) { return value === true || value === false }
    },
    enabledErrorTypes: {
      defaultValue: defaultErrorTypes,
      message: 'should be an object containing the flags { unhandledExceptions:true|false, unhandledRejections:true|false }',
      allowPartialObject: true,
      validate: function (value) {
        if (typeof value !== 'object' || !value) return false
        var providedKeys = keys(value)
        var defaultKeys = keys(defaultErrorTypes())
        if (filterArray(providedKeys, function (k) { return includes(defaultKeys, k) }).length < providedKeys.length) return false
        if (filterArray(keys(value), function (k) { return typeof value[k] !== 'boolean' }).length > 0) return false
        return true
      }
    },
    onError: {
      defaultValue: function () { return [] },
      message: 'should be a function or array of functions',
      validate: listOfFunctions
    },
    endpoints: {
      defaultValue: function (endpoints) {
        if (typeof endpoints === 'undefined') {
          return { notify: 'https://notify.bugsnag.com' }
        }
        return { notify: null }
      },
      message: 'should be an object containing the endpoint URL { notify }',
      validate: function (val) {
        return (val && typeof val === 'object') &&
          stringWithLength(val.notify) &&
          filterArray(keys(val), function (k) { return !includes(['notify'], k) }).length === 0
      }
    },
    enabledReleaseStages: {
      defaultValue: function () { return null },
      message: 'should be an array of strings',
      validate: function (value) {
        return value === null || (isArray(value) && filterArray(value, function (f) { return typeof f === 'string' }).length === value.length)
      }
    },
    releaseStage: {
      defaultValue: function () {
        if (/^localhost(:\d+)?$/.test(window.location.host)) return 'development'
        return 'production'
      },
      message: 'should be a string',
      validate: function (value) { return typeof value === 'string' && value.length }
    },
    context: {
      defaultValue: function () { return undefined },
      message: 'should be a string',
      validate: function (value) { return value === undefined || typeof value === 'string' }
    },
    metadata: {
      defaultValue: function () { return {} },
      message: 'should be an object',
      validate: function (value) { return typeof value === 'object' && value !== null }
    },
    logger: {
      defaultValue: function () {
        return (typeof console !== 'undefined' && typeof console.debug === 'function')
          ? getPrefixedConsole()
          : undefined
      },
      message: 'should be null or an object with methods { debug, info, warn, error }',
      validate: function (value) {
        return (!value) || (value && reduceArray(['debug', 'info', 'warn', 'error'], function (accum, method) {
          return accum && typeof value[method] === 'function'
        }, true))
      }
    },
    redactedKeys: {
      defaultValue: function () { return ['password'] },
      message: 'should be an array of strings|regexes',
      validate: function (value) {
        return isArray(value) && value.length === filterArray(value, function (s) {
          return typeof s === 'string' || (s && typeof s.test === 'function')
        }).length
      }
    },
    reportUnhandledPromiseRejectionsAsHandled: {
      defaultValue: function () { return false },
      message: 'should be true|false',
      validate: function (value) { return value === true || value === false }
    },
    maxEvents: {
      defaultValue: function () { return 10 },
      message: 'should be a positive integer <=100',
      validate: function (val) { return intRange(1, 100)(val) }
    }
  }

  function getPrefixedConsole () {
    var logger = {}
    var consoleLog = console.log
    var methods = ['debug', 'info', 'warn', 'error']
    for (var i = 0; i < methods.length; i++) {
      var method = methods[i]
      var consoleMethod = console[method]
      logger[method] = typeof consoleMethod === 'function'
        ? bind(consoleMethod, console, '[bugsnag]')
        : bind(consoleLog, console, '[bugsnag]')
    }
    return logger
  }

  /* -------------------------------------------------------------------------
   * stacktrace parsing
   * ---------------------------------------------------------------------- */

  function hasStack (err) {
    return !!err &&
      (!!err.stack || !!err.stacktrace || !!err['opera#sourceloc']) &&
      typeof (err.stack || err.stacktrace || err['opera#sourceloc']) === 'string' &&
      err.stack !== err.name + ': ' + err.message
  }

  function isError (o) {
    return o instanceof Error || /^\[object (Error|(Dom)?Exception)\]$/.test(Object.prototype.toString.call(o))
  }

  function makeFrame (functionName, fileName, lineNumber, columnNumber) {
    return {
      functionName: functionName,
      fileName: fileName,
      lineNumber: lineNumber === undefined ? undefined : +lineNumber,
      columnNumber: columnNumber === undefined ? undefined : +columnNumber
    }
  }

  function parseStackLine (raw) {
    var line = trim(raw)
    if (!line) return null

    // V8 / Chromium: "    at fn (file:line:col)" or "    at file:line:col"
    if (line.indexOf('at ') === 0) {
      var rest = line.slice(3)
      var m = rest.match(/^(.*?)\s*\((.*):(\d+):(\d+)\)$/)
      if (m) return makeFrame(m[1] || undefined, m[2], m[3], m[4])
      m = rest.match(/^(.*):(\d+):(\d+)$/)
      if (m) return makeFrame(undefined, m[1], m[2], m[3])
      return makeFrame(rest, undefined, undefined, undefined)
    }

    // Firefox / Safari: "fn@file:line:col"
    var at = line.indexOf('@')
    if (at !== -1) {
      var fn = line.slice(0, at)
      var loc = line.slice(at + 1)
      var lm = loc.match(/^(.*):(\d+):(\d+)$/)
      if (lm) return makeFrame(fn || undefined, lm[1], lm[2], lm[3])
      return makeFrame(fn || undefined, loc, undefined, undefined)
    }

    var bare = line.match(/^(.*):(\d+):(\d+)$/)
    if (bare) return makeFrame(undefined, bare[1], bare[2], bare[3])

    return null
  }

  function parseStack (error) {
    var stack = error.stack || error.stacktrace
    if (!stack || typeof stack !== 'string') return []
    var lines = stack.split('\n')
    var frames = []
    for (var i = 0; i < lines.length; i++) {
      var frame = parseStackLine(lines[i])
      if (frame) frames.push(frame)
    }
    return frames
  }

  function generateStack () {
    try {
      throw new Error()
    } catch (e) {
      return parseStack(e)
    }
  }

  function normaliseFunctionName (n) {
    return /^global code$/i.test(n) ? 'global code' : n
  }

  function formatStackframe (frame) {
    var f = {
      file: frame.fileName,
      method: normaliseFunctionName(frame.functionName),
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
      code: undefined,
      inProject: undefined
    }
    if (f.lineNumber > -1 && !f.file && !f.method) f.file = 'global code'
    return f
  }

  function defaultHandledState () {
    return {
      unhandled: false,
      severity: 'warning',
      severityReason: { type: 'handledException' }
    }
  }

  function ensureString (str) {
    return typeof str === 'string' ? str : ''
  }

  function createBugsnagError (errorClass, errorMessage, type, stacktrace) {
    return {
      errorClass: ensureString(errorClass),
      errorMessage: ensureString(errorMessage),
      type: type,
      stacktrace: reduceArray(stacktrace, function (accum, frame) {
        var f = formatStackframe(frame)
        try {
          if (JSON.stringify(f) === '{}') return accum
          return accum.concat(f)
        } catch (e) {
          return accum
        }
      }, [])
    }
  }

  function normaliseError (maybeError) {
    var error
    if (isError(maybeError)) {
      error = maybeError
    } else {
      var message
      try {
        message = String(maybeError)
      } catch (e) {
        message = '[unserialisable]'
      }
      error = new Error(message)
    }

    var internalFrames = 0

    if (!hasStack(error)) {
      try {
        throw error
      } catch (e) {
        if (hasStack(e)) {
          error = e
          internalFrames = 1
        }
      }
    }

    return [error, internalFrames]
  }

  /* -------------------------------------------------------------------------
   * Event
   * ---------------------------------------------------------------------- */

  function Event (errorClass, errorMessage, stacktrace, handledState, originalError) {
    if (stacktrace === undefined) stacktrace = []
    if (handledState === undefined) handledState = defaultHandledState()

    this.context = undefined
    this.originalError = originalError

    this._handledState = handledState
    this.severity = this._handledState.severity
    this.unhandled = this._handledState.unhandled

    this.app = {}
    this.device = {}
    this.request = {}

    this._metadata = {}

    this.errors = [
      createBugsnagError(errorClass, errorMessage, Event.__type, stacktrace)
    ]
  }

  Event.prototype.addMetadata = function (section, keyOrObj, maybeVal) {
    return metadataDelegate.add(this._metadata, section, keyOrObj, maybeVal)
  }

  Event.prototype.getMetadata = function (section, key) {
    return metadataDelegate.get(this._metadata, section, key)
  }

  Event.prototype.clearMetadata = function (section, key) {
    return metadataDelegate.clear(this._metadata, section, key)
  }

  Event.prototype.toJSON = function () {
    return {
      payloadVersion: '4',
      exceptions: mapArray(this.errors, function (er) { return assign({}, er, { message: er.errorMessage }) }),
      severity: this.severity,
      unhandled: this._handledState.unhandled,
      severityReason: this._handledState.severityReason,
      app: this.app,
      device: this.device,
      request: this.request,
      context: this.context,
      metaData: this._metadata
    }
  }

  Event.getStacktrace = function (error, errorFramesToSkip, backtraceFramesToSkip) {
    if (hasStack(error)) return parseStack(error).slice(errorFramesToSkip)
    return generateStack().slice(1 + backtraceFramesToSkip)
  }

  Event.create = function (maybeError, handledState, errorFramesToSkip) {
    if (errorFramesToSkip === undefined) errorFramesToSkip = 0

    var normalised = normaliseError(maybeError)
    var error = normalised[0]
    var internalFrames = normalised[1]

    var event
    try {
      var stacktrace = Event.getStacktrace(
        error,
        internalFrames > 0 ? 1 + internalFrames + errorFramesToSkip : 0,
        1 + errorFramesToSkip
      )
      event = new Event(error.name, error.message, stacktrace, handledState, maybeError)
    } catch (e) {
      event = new Event(error.name, error.message, [], handledState, maybeError)
    }

    return event
  }

  Event.__type = 'browserjs'

  /* -------------------------------------------------------------------------
   * callback runners
   * ---------------------------------------------------------------------- */

  function asyncEvery (arr, fn, cb) {
    var index = 0

    var next = function () {
      if (index >= arr.length) return cb(null, true)
      fn(arr[index], function (err, result) {
        if (err) return cb(err)
        if (result === false) return cb(null, false)
        index++
        next()
      })
    }

    next()
  }

  function runCallbacks (callbacks, event, onCallbackError, cb) {
    var runMaybeAsyncCallback = function (fn, cb) {
      if (typeof fn !== 'function') return cb(null)
      try {
        if (fn.length !== 2) {
          var ret = fn(event)
          if (ret && typeof ret.then === 'function') {
            return ret.then(
              function (val) { setTimeout(function () { cb(null, val) }) },
              function (err) {
                setTimeout(function () {
                  onCallbackError(err)
                  return cb(null, true)
                })
              }
            )
          }
          return cb(null, ret)
        }
        fn(event, function (err, result) {
          if (err) {
            onCallbackError(err)
            return cb(null)
          }
          cb(null, result)
        })
      } catch (e) {
        onCallbackError(e)
        cb(null)
      }
    }

    asyncEvery(callbacks, runMaybeAsyncCallback, cb)
  }

  /* -------------------------------------------------------------------------
   * Client
   * ---------------------------------------------------------------------- */

  function Client (configuration, notifier) {
    this._notifier = notifier

    this._config = {}

    this._delivery = { sendEvent: noop }
    this._logger = { debug: noop, info: noop, warn: noop, error: noop }

    this._metadata = {}
    this._context = undefined

    this._cbs = { e: [] }

    this.Client = Client
    this.Event = Event

    this._config = this._configure(configuration)

    this._depth = 1

    var self = this
    var notify = this.notify
    this.notify = function () {
      return notify.apply(self, arguments)
    }
  }

  Client.prototype._configure = function (opts) {
    var accum = reduceArray(keys(configSchema), function (accum, key) {
      var defaultValue = configSchema[key].defaultValue(opts[key])

      if (opts[key] !== undefined) {
        var valid = configSchema[key].validate(opts[key])
        if (!valid) {
          accum.errors[key] = configSchema[key].message
          accum.config[key] = defaultValue
        } else {
          if (configSchema[key].allowPartialObject) accum.config[key] = assign(defaultValue, opts[key])
          else accum.config[key] = opts[key]
        }
      } else {
        accum.config[key] = defaultValue
      }

      return accum
    }, { errors: {}, config: {} })

    var errors = accum.errors
    var config = accum.config

    if (!config.apiKey) throw new Error('No Bugsnag API Key set')
    if (!/^[0-9a-f]{32}$/i.test(config.apiKey)) errors.apiKey = 'should be a string of 32 hexadecimal characters'

    this._metadata = assign({}, config.metadata)
    this._context = config.context
    if (config.logger) this._logger = config.logger

    if (config.onError) this._cbs.e = this._cbs.e.concat(config.onError)

    if (keys(errors).length) {
      this._logger.warn(generateConfigErrorMessage(errors, opts))
    }

    return config
  }

  Client.prototype.addMetadata = function (section, keyOrObj, maybeVal) {
    return metadataDelegate.add(this._metadata, section, keyOrObj, maybeVal)
  }

  Client.prototype.getMetadata = function (section, key) {
    return metadataDelegate.get(this._metadata, section, key)
  }

  Client.prototype.clearMetadata = function (section, key) {
    return metadataDelegate.clear(this._metadata, section, key)
  }

  Client.prototype.getContext = function () { return this._context }
  Client.prototype.setContext = function (c) { this._context = c }

  Client.prototype._setDelivery = function (d) {
    this._delivery = d(this)
  }

  Client.prototype.addOnError = function (fn, front) {
    this._cbs.e[front ? 'unshift' : 'push'](fn)
  }

  Client.prototype.removeOnError = function (fn) {
    this._cbs.e = filterArray(this._cbs.e, function (f) { return f !== fn })
  }

  Client.prototype.notify = function (maybeError, onError, postReportCallback) {
    if (postReportCallback === undefined) postReportCallback = noop
    var event = Event.create(maybeError, undefined, this._depth + 1)
    this._notify(event, onError, postReportCallback)
  }

  Client.prototype._notify = function (event, onError, postReportCallback) {
    if (postReportCallback === undefined) postReportCallback = noop

    var self = this

    event.app = assign({}, event.app, {
      releaseStage: this._config.releaseStage,
      version: this._config.appVersion,
      type: this._config.appType
    })
    event.context = event.context || this._context
    event._metadata = assign({}, event._metadata, this._metadata)

    if (this._config.enabledReleaseStages !== null && !includes(this._config.enabledReleaseStages, this._config.releaseStage)) {
      this._logger.warn('Event not sent due to releaseStage/enabledReleaseStages configuration')
      return postReportCallback(null, event)
    }

    var originalSeverity = event.severity

    var onCallbackError = function (err) {
      self._logger.error('Error occurred in onError callback, continuing anyway…')
      self._logger.error(err)
    }

    var callbacks = [].concat(this._cbs.e).concat(onError)
    runCallbacks(callbacks, event, onCallbackError, function (callbackErr, shouldSend) {
      if (!shouldSend) {
        self._logger.debug('Event not sent due to onError callback')
        return postReportCallback(null, event)
      }

      if (originalSeverity !== event.severity) {
        event._handledState.severityReason = { type: 'userCallbackSetSeverity' }
      }

      if (event.unhandled !== event._handledState.unhandled) {
        event._handledState.severityReason.unhandledOverridden = true
        event._handledState.unhandled = event.unhandled
      }

      self._delivery.sendEvent({
        apiKey: self._config.apiKey,
        notifier: self._notifier,
        events: [event]
      }, function (err) { postReportCallback(err, event) })
    })
  }

  function stringifyConfigValue (val) {
    switch (typeof val) {
      case 'string':
      case 'number':
      case 'object':
        return JSON.stringify(val)
      default:
        return String(val)
    }
  }

  function generateConfigErrorMessage (errors, rawInput) {
    return new Error(
      'Invalid configuration\n' + mapArray(keys(errors), function (key) {
        return '  - ' + key + ' ' + errors[key] + ', got ' + stringifyConfigValue(rawInput[key])
      }).join('\n\n')
    )
  }

  /* -------------------------------------------------------------------------
   * automatic enrichment & capture
   * ---------------------------------------------------------------------- */

  function setupDevice (client, nav, win) {
    if (nav === undefined) nav = navigator
    if (win === undefined) win = window

    var device = {
      locale: nav.language,
      userAgent: nav.userAgent
    }

    if (win && win.screen && win.screen.orientation && win.screen.orientation.type) {
      device.orientation = win.screen.orientation.type
    } else if (win && win.document) {
      device.orientation =
        win.document.documentElement.clientWidth > win.document.documentElement.clientHeight
          ? 'landscape'
          : 'portrait'
    }

    if (win && typeof win.innerWidth === 'number') device.windowWidth = win.innerWidth
    if (win && typeof win.innerHeight === 'number') device.windowHeight = win.innerHeight

    client.addOnError(function (event) {
      event.device = assign({}, event.device, device, { time: new Date() })
    }, true)
  }

  function setupContext (client, win) {
    if (win === undefined) win = window

    client.addOnError(function (event) {
      if (event.context !== undefined) return
      event.context = win.location.pathname
    }, true)
  }

  function setupRequest (client, win) {
    if (win === undefined) win = window

    client.addOnError(function (event) {
      if (event.request && event.request.url) return
      event.request = assign({}, event.request, { url: win.location.href })
    }, true)
  }

  function setupThrottle (client) {
    var n = 0

    client.addOnError(function () {
      if (n >= client._config.maxEvents) {
        client._logger.warn('Cancelling event send due to maxEvents limit of ' + client._config.maxEvents + ' being reached')
        return false
      }
      n++
    })

    client.resetEventCount = function () { n = 0 }
  }

  function stripQueryString (str) {
    return typeof str === 'string'
      ? str.replace(/\?.*$/, '').replace(/#.*$/, '')
      : str
  }

  function setupStripQueryString (client) {
    client.addOnError(function (event) {
      var allFrames = reduceArray(event.errors, function (accum, er) { return accum.concat(er.stacktrace) }, [])
      for (var i = 0; i < allFrames.length; i++) {
        allFrames[i].file = stripQueryString(allFrames[i].file)
      }
    })
  }

  function isActualNumber (n) {
    return typeof n === 'number' && String.call(n) !== 'NaN'
  }

  function decorateStack (stack, url, lineNo, charNo) {
    if (!stack[0]) stack.push({})
    var culprit = stack[0]
    if (!culprit.file && typeof url === 'string') culprit.file = url
    if (!culprit.lineNumber && isActualNumber(lineNo)) culprit.lineNumber = lineNo
    if (!culprit.columnNumber) {
      if (isActualNumber(charNo)) {
        culprit.columnNumber = charNo
      } else if (window.event && isActualNumber(window.event.errorCharacter)) {
        culprit.columnNumber = window.event.errorCharacter
      }
    }
  }

  function setupWindowOnerror (client, win) {
    if (win === undefined) win = window

    if (!client._config.autoDetectErrors) return
    if (!client._config.enabledErrorTypes.unhandledExceptions) return

    var prevOnError = win.onerror

    function onerror (message, url, lineNo, charNo, error) {
      if (lineNo === 0 && /Script error\.?/.test(message)) {
        client._logger.warn('Ignoring cross-domain or eval script error. See docs: https://tinyurl.com/yy3rn63z')
      } else {
        var handledState = { severity: 'error', unhandled: true, severityReason: { type: 'unhandledException' } }
        var event = client.Event.create(error || message, handledState, 1)
        decorateStack(event.errors[0].stacktrace, url, lineNo, charNo)
        client._notify(event)
      }

      try { prevOnError.apply(this, arguments) } catch (e) {}
    }

    win.onerror = onerror
  }

  function setupUnhandledRejection (client, win) {
    if (win === undefined) win = window

    if (!client._config.autoDetectErrors || !client._config.enabledErrorTypes.unhandledRejections) return

    var listener = function (evt) {
      var error = evt.reason
      var unhandled = !client._config.reportUnhandledPromiseRejectionsAsHandled

      var event = client.Event.create(error, {
        severity: 'error',
        unhandled: unhandled,
        severityReason: { type: 'unhandledPromiseRejection' }
      }, 1)

      client._notify(event, function (event) {
        if (isError(error) && !error.stack) {
          var section = {}
          section[Object.prototype.toString.call(error)] = {
            name: error.name,
            message: error.message,
            code: error.code
          }
          event.addMetadata('unhandledRejection handler', section)
        }
      })
    }

    win.addEventListener('unhandledrejection', listener)
  }

  /* -------------------------------------------------------------------------
   * delivery
   * ---------------------------------------------------------------------- */

  var EVENT_REDACTION_PATHS = [
    'events.[].metaData',
    'events.[].request'
  ]

  function jsonPayloadEvent (event, redactedKeys) {
    var payload = safeJsonStringify(event, null, null, { redactedPaths: EVENT_REDACTION_PATHS, redactedKeys: redactedKeys })
    if (payload.length > 1000000) {
      event.events[0]._metadata = {
        notifier: 'WARNING!\nSerialized payload was ' + (payload.length / 1000000) + 'MB (limit = 1MB)\nmetadata was removed'
      }
      payload = safeJsonStringify(event, null, null, { redactedPaths: EVENT_REDACTION_PATHS, redactedKeys: redactedKeys })
    }
    return payload
  }

  function xmlHttpRequestDelivery (client, win) {
    if (win === undefined) win = window

    return {
      sendEvent: function (event, cb) {
        if (cb === undefined) cb = function () {}

        try {
          var url = client._config.endpoints.notify
          if (url === null) {
            return cb(new Error('Event not sent due to incomplete endpoint configuration'))
          }

          var req = new win.XMLHttpRequest()
          var body = jsonPayloadEvent(event, client._config.redactedKeys)

          req.onreadystatechange = function () {
            if (req.readyState === win.XMLHttpRequest.DONE) {
              var status = req.status
              if (status === 0 || status >= 400) {
                var err = new Error('Request failed with status ' + status)
                client._logger.error('Event failed to send…', err)
                if (body.length > 1000000) {
                  client._logger.warn('Event oversized (' + (body.length / 1000000).toFixed(2) + ' MB)')
                }
                cb(err)
              } else {
                cb(null)
              }
            }
          }

          req.open('POST', url)
          req.setRequestHeader('Content-Type', 'application/json')
          req.setRequestHeader('Bugsnag-Api-Key', event.apiKey)
          req.setRequestHeader('Bugsnag-Payload-Version', '4')
          req.setRequestHeader('Bugsnag-Sent-At', (new Date()).toISOString())

          req.send(body)
        } catch (e) {
          client._logger.error(e)
        }
      }
    }
  }

  /* -------------------------------------------------------------------------
   * static API
   * ---------------------------------------------------------------------- */

  var Bugsnag = {
    _client: null,
    createClient: function (opts) {
      if (typeof opts === 'string') opts = { apiKey: opts }
      if (!opts) opts = {}

      var bugsnag = new Client(opts, { name: name, version: version, url: url })

      setupDevice(bugsnag)
      setupContext(bugsnag)
      setupRequest(bugsnag)
      setupThrottle(bugsnag)
      setupStripQueryString(bugsnag)
      setupWindowOnerror(bugsnag)
      setupUnhandledRejection(bugsnag)

      bugsnag._setDelivery(xmlHttpRequestDelivery)

      bugsnag._logger.debug('Loaded!')

      return bugsnag
    },
    start: function (opts) {
      if (Bugsnag._client) {
        Bugsnag._client._logger.warn('Bugsnag.start() was called more than once. Ignoring.')
        return Bugsnag._client
      }
      Bugsnag._client = Bugsnag.createClient(opts)
      return Bugsnag._client
    },
    isStarted: function () {
      return Bugsnag._client != null
    }
  }

  var staticMethods = ['resetEventCount'].concat(keys(Client.prototype))
  for (var si = 0; si < staticMethods.length; si++) {
    (function (m) {
      if (/^_/.test(m)) return
      Bugsnag[m] = function () {
        if (!Bugsnag._client) return console.log('Bugsnag.' + m + '() was called before Bugsnag.start()')
        Bugsnag._client._depth += 1
        var ret = Bugsnag._client[m].apply(Bugsnag._client, arguments)
        Bugsnag._client._depth -= 1
        return ret
      }
    })(staticMethods[si])
  }

  module.exports = Bugsnag
  module.exports.default = Bugsnag
})()
