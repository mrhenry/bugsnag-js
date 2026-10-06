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

  var NOTIFY_ENDPOINT = 'https://notify.bugsnag.com'
  var MAX_EVENTS = 10
  var REDACTED_KEYS = ['password']

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
   * metadata
   * ---------------------------------------------------------------------- */

  function addMetadata (state, section, keyOrObj, maybeVal) {
    if (!section) return

    if (keyOrObj === null) {
      delete state[section]
      return
    }

    var updates
    if (typeof keyOrObj === 'object') updates = keyOrObj
    else if (typeof keyOrObj === 'string') {
      updates = {}
      updates[keyOrObj] = maybeVal
    }

    if (!updates) return

    if (section === '__proto__' || section === 'constructor' || section === 'prototype') return

    if (!state[section]) state[section] = {}

    state[section] = assign({}, state[section], updates)
  }

  /* -------------------------------------------------------------------------
   * validators
   * ---------------------------------------------------------------------- */

  function stringWithLength (value) {
    return typeof value === 'string' && !!value.length
  }

  function listOfFunctions (value) {
    return typeof value === 'function' || (isArray(value) && filterArray(value, function (f) {
      return typeof f === 'function'
    }).length === value.length)
  }

  /* -------------------------------------------------------------------------
   * configuration schema
   * ---------------------------------------------------------------------- */

  var configSchema = {
    apiKey: {
      defaultValue: function () { return null },
      message: 'is required',
      validate: stringWithLength
    },
    appType: {
      defaultValue: function () { return 'browser' },
      message: 'should be a string',
      validate: function (value) { return value === undefined || stringWithLength(value) }
    },
    onError: {
      defaultValue: function () { return [] },
      message: 'should be a function or array of functions',
      validate: listOfFunctions
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
    return !!err && typeof err.stack === 'string' && err.stack !== err.name + ': ' + err.message
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
    var stack = error.stack
    if (!stack || typeof stack !== 'string') return []
    var lines = stack.split('\n')
    var frames = []
    for (var i = 0; i < lines.length; i++) {
      var frame = parseStackLine(lines[i])
      if (frame) frames.push(frame)
    }
    return frames
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
    var frames = []
    for (var i = 0; i < stacktrace.length; i++) {
      var f = formatStackframe(stacktrace[i])
      if (f.file !== undefined || f.method !== undefined || f.lineNumber !== undefined || f.columnNumber !== undefined) {
        frames.push(f)
      }
    }
    return {
      errorClass: ensureString(errorClass),
      errorMessage: ensureString(errorMessage),
      type: type,
      stacktrace: frames
    }
  }

  function normaliseError (maybeError) {
    if (isError(maybeError)) return maybeError
    try {
      return new Error(String(maybeError))
    } catch (e) {
      return new Error('[unserialisable]')
    }
  }

  /* -------------------------------------------------------------------------
   * Event
   * ---------------------------------------------------------------------- */

  function Event (errorClass, errorMessage, stacktrace, handledState) {
    if (stacktrace === undefined) stacktrace = []
    if (handledState === undefined) handledState = defaultHandledState()

    this.context = undefined

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
    return addMetadata(this._metadata, section, keyOrObj, maybeVal)
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

  Event.create = function (maybeError, handledState) {
    var error = normaliseError(maybeError)
    return new Event(error.name, error.message, hasStack(error) ? parseStack(error) : [], handledState)
  }

  Event.__type = 'browserjs'

  /* -------------------------------------------------------------------------
   * callback runner
   * ---------------------------------------------------------------------- */

  function runCallbacks (callbacks, event, logger) {
    for (var i = 0; i < callbacks.length; i++) {
      var fn = callbacks[i]
      if (typeof fn !== 'function') continue
      try {
        if (fn(event) === false) return false
      } catch (e) {
        logger.error('Error occurred in onError callback, continuing anyway…')
        logger.error(e)
      }
    }
    return true
  }

  /* -------------------------------------------------------------------------
   * Client
   * ---------------------------------------------------------------------- */

  function Client (configuration, notifier) {
    this._notifier = notifier

    this._config = {}

    this._delivery = { sendEvent: noop }
    this._logger = typeof console !== 'undefined'
      ? getPrefixedConsole()
      : { debug: noop, info: noop, warn: noop, error: noop }

    this._metadata = {}

    this._cbs = { e: [] }

    this.Client = Client
    this.Event = Event

    this._config = this._configure(configuration)
  }

  Client.prototype._configure = function (opts) {
    var config = {}
    var errors = {}
    var schemaKeys = keys(configSchema)

    for (var i = 0; i < schemaKeys.length; i++) {
      var key = schemaKeys[i]
      var def = configSchema[key]
      var value = opts[key]

      if (value === undefined) {
        config[key] = def.defaultValue()
      } else if (def.validate(value)) {
        config[key] = value
      } else {
        errors[key] = def.message
        config[key] = def.defaultValue()
      }
    }

    if (!config.apiKey) throw new Error('No Bugsnag API Key set')
    if (!/^[0-9a-f]{32}$/i.test(config.apiKey)) errors.apiKey = 'should be a string of 32 hexadecimal characters'

    if (config.onError) this._cbs.e = [].concat(config.onError)

    if (keys(errors).length) {
      this._logger.warn(generateConfigErrorMessage(errors, opts))
    }

    return config
  }

  Client.prototype.addMetadata = function (section, keyOrObj, maybeVal) {
    return addMetadata(this._metadata, section, keyOrObj, maybeVal)
  }

  Client.prototype.addOnError = function (fn, front) {
    this._cbs.e[front ? 'unshift' : 'push'](fn)
  }

  Client.prototype.notify = function (maybeError) {
    this._notify(Event.create(maybeError, undefined))
  }

  Client.prototype._notify = function (event) {
    var self = this

    event.app = assign({}, event.app, {
      releaseStage: this._config.releaseStage,
      type: this._config.appType
    })
    event._metadata = assign({}, event._metadata, this._metadata)

    if (this._config.enabledReleaseStages !== null && !includes(this._config.enabledReleaseStages, this._config.releaseStage)) {
      this._logger.warn('Event not sent due to releaseStage/enabledReleaseStages configuration')
      return
    }

    var originalSeverity = event.severity

    if (!runCallbacks(this._cbs.e, event, this._logger)) {
      this._logger.debug('Event not sent due to onError callback')
      return
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
      if (n >= MAX_EVENTS) {
        client._logger.warn('Cancelling event send due to maxEvents limit of ' + MAX_EVENTS + ' being reached')
        return false
      }
      n++
    })
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
    if (!culprit.columnNumber && isActualNumber(charNo)) culprit.columnNumber = charNo
  }

  function setupWindowOnerror (client, win) {
    if (win === undefined) win = window

    var prevOnError = win.onerror

    function onerror (message, url, lineNo, charNo, error) {
      if (lineNo === 0 && /Script error\.?/.test(message)) {
        client._logger.warn('Ignoring cross-domain or eval script error. See docs: https://tinyurl.com/yy3rn63z')
      } else {
        var event = client.Event.create(error || message, {
          severity: 'error',
          unhandled: true,
          severityReason: { type: 'unhandledException' }
        })
        decorateStack(event.errors[0].stacktrace, url, lineNo, charNo)
        client._notify(event)
      }

      try { prevOnError.apply(this, arguments) } catch (e) {}
    }

    win.onerror = onerror
  }

  function setupUnhandledRejection (client, win) {
    if (win === undefined) win = window

    var listener = function (evt) {
      var error = evt.reason

      var event = client.Event.create(error, {
        severity: 'error',
        unhandled: true,
        severityReason: { type: 'unhandledPromiseRejection' }
      })

      if (isError(error) && !error.stack) {
        var section = {}
        section[Object.prototype.toString.call(error)] = {
          name: error.name,
          message: error.message,
          code: error.code
        }
        event.addMetadata('unhandledRejection handler', section)
      }

      client._notify(event)
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

  function jsonPayloadEvent (event) {
    var payload = safeJsonStringify(event, null, null, { redactedPaths: EVENT_REDACTION_PATHS, redactedKeys: REDACTED_KEYS })
    if (payload.length > 1000000) {
      event.events[0]._metadata = {
        notifier: 'WARNING!\nSerialized payload was ' + (payload.length / 1000000) + 'MB (limit = 1MB)\nmetadata was removed'
      }
      payload = safeJsonStringify(event, null, null, { redactedPaths: EVENT_REDACTION_PATHS, redactedKeys: REDACTED_KEYS })
    }
    return payload
  }

  function xmlHttpRequestDelivery (client, win) {
    if (win === undefined) win = window

    return {
      sendEvent: function (event) {
        try {
          var req = new win.XMLHttpRequest()
          var body = jsonPayloadEvent(event)

          req.onreadystatechange = function () {
            if (req.readyState === win.XMLHttpRequest.DONE) {
              var status = req.status
              if (status === 0 || status >= 400) {
                client._logger.error('Event failed to send…', new Error('Request failed with status ' + status))
              }
            }
          }

          req.open('POST', NOTIFY_ENDPOINT)
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

      bugsnag._delivery = xmlHttpRequestDelivery(bugsnag)

      bugsnag._logger.debug('Loaded!')

      return bugsnag
    }
  }

  module.exports = Bugsnag
  module.exports.default = Bugsnag
})()
