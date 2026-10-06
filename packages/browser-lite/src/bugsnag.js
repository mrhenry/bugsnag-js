/*
 * @mrhenry/browser-lite
 *
 * A minimal, privacy-leaning Bugsnag error reporter for browsers.
 *
 * This is a clean-sheet, dependency-free implementation written in ES3. It
 * bundles everything the notifier needs: configuration, the client, events,
 * breadcrumbs, the browser plugins and XMLHttpRequest delivery.
 *
 * See SPEC.md for the full behaviour specification.
 */
(function () {
  'use strict'

  var name = 'Bugsnag JavaScript'
  var version = '__VERSION__'
  var url = 'https://github.com/bugsnag/bugsnag-js'

  var SECONDARY_ENDPOINT_API_KEY_PREFIX = '00000'
  var SECONDARY_NOTIFY_ENDPOINT = 'https://notify.bugsnag.smartbear.com'
  var SECONDARY_SESSIONS_ENDPOINT = 'https://sessions.bugsnag.smartbear.com'

  var BREADCRUMB_TYPES = ['navigation', 'request', 'process', 'log', 'user', 'state', 'error', 'manual']

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

  function indexOf (arr, x) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === x) return i
    return -1
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

  function isErrorObject (o) {
    return o instanceof Error || /^\[object (Error|(Dom)?Exception)\]$/.test(Object.prototype.toString.call(o))
  }

  function throwsMessage (err) {
    return '[Throws: ' + (err ? err.message : '?') + ']'
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

      if (isErrorObject(obj)) {
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

  var featureFlagDelegate = {
    add: function (existingFeatures, existingFeatureKeys, name, variant) {
      if (typeof name !== 'string') return

      if (variant === undefined) {
        variant = null
      } else if (variant !== null && typeof variant !== 'string') {
        variant = safeJsonStringify(variant, null, null, {})
      }

      var existingIndex = existingFeatureKeys[name]
      if (typeof existingIndex === 'number') {
        existingFeatures[existingIndex] = { name: name, variant: variant }
        return
      }

      existingFeatures.push({ name: name, variant: variant })
      existingFeatureKeys[name] = existingFeatures.length - 1
    },
    merge: function (existingFeatures, newFeatures, existingFeatureKeys) {
      if (!isArray(newFeatures)) return

      for (var i = 0; i < newFeatures.length; ++i) {
        var feature = newFeatures[i]
        if (feature === null || typeof feature !== 'object') continue
        featureFlagDelegate.add(existingFeatures, existingFeatureKeys, feature.name, feature.variant)
      }

      return existingFeatures
    },
    toEventApi: function (featureFlags) {
      return mapArray(filterArray(featureFlags, Boolean), function (feature) {
        var flag = { featureFlag: feature.name }
        if (typeof feature.variant === 'string') flag.variant = feature.variant
        return flag
      })
    },
    clear: function (features, featuresIndex, name) {
      var existingIndex = featuresIndex[name]
      if (typeof existingIndex === 'number') {
        features[existingIndex] = null
        delete featuresIndex[name]
      }
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

  var schema = {
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
      defaultValue: function () { return undefined },
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
    onSession: {
      defaultValue: function () { return [] },
      message: 'should be a function or array of functions',
      validate: listOfFunctions
    },
    onBreadcrumb: {
      defaultValue: function () { return [] },
      message: 'should be a function or array of functions',
      validate: listOfFunctions
    },
    endpoints: {
      defaultValue: function (endpoints) {
        if (typeof endpoints === 'undefined') {
          return { notify: 'https://notify.bugsnag.com', sessions: 'https://sessions.bugsnag.com' }
        }
        return { notify: null, sessions: null }
      },
      message: 'should be an object containing endpoint URLs { notify, sessions }',
      validate: function (val) {
        return (val && typeof val === 'object') &&
          stringWithLength(val.notify) && stringWithLength(val.sessions) &&
          filterArray(keys(val), function (k) { return !includes(['notify', 'sessions'], k) }).length === 0
      }
    },
    autoTrackSessions: {
      defaultValue: function () { return true },
      message: 'should be true|false',
      validate: function (val) { return val === true || val === false }
    },
    enabledReleaseStages: {
      defaultValue: function () { return null },
      message: 'should be an array of strings',
      validate: function (value) {
        return value === null || (isArray(value) && filterArray(value, function (f) { return typeof f === 'string' }).length === value.length)
      }
    },
    releaseStage: {
      defaultValue: function () { return 'production' },
      message: 'should be a string',
      validate: function (value) { return typeof value === 'string' && value.length }
    },
    maxBreadcrumbs: {
      defaultValue: function () { return 25 },
      message: 'should be a number <=100',
      validate: function (value) { return intRange(0, 100)(value) }
    },
    enabledBreadcrumbTypes: {
      defaultValue: function () { return BREADCRUMB_TYPES },
      message: 'should be null or a list of available breadcrumb types (' + BREADCRUMB_TYPES.join(',') + ')',
      validate: function (value) {
        return value === null || (isArray(value) && reduceArray(value, function (accum, maybeType) {
          if (accum === false) return accum
          return includes(BREADCRUMB_TYPES, maybeType)
        }, true))
      }
    },
    context: {
      defaultValue: function () { return undefined },
      message: 'should be a string',
      validate: function (value) { return value === undefined || typeof value === 'string' }
    },
    user: {
      defaultValue: function () { return {} },
      message: 'should be an object with { id, email, name } properties',
      validate: function (value) {
        return (value === null) || (value && reduceArray(keys(value), function (accum, key) {
          return accum && includes(['id', 'email', 'name'], key)
        }, true))
      }
    },
    metadata: {
      defaultValue: function () { return {} },
      message: 'should be an object',
      validate: function (value) { return typeof value === 'object' && value !== null }
    },
    logger: {
      defaultValue: function () { return undefined },
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
    plugins: {
      defaultValue: function () { return [] },
      message: 'should be an array of plugin objects',
      validate: function (value) {
        return isArray(value) && value.length === filterArray(value, function (p) {
          return p && typeof p === 'object' && typeof p.load === 'function'
        }).length
      }
    },
    featureFlags: {
      defaultValue: function () { return [] },
      message: 'should be an array of objects that have a "name" property',
      validate: function (value) {
        return isArray(value) && value.length === filterArray(value, function (feature) {
          return feature && typeof feature === 'object' && typeof feature.name === 'string'
        }).length
      }
    },
    reportUnhandledPromiseRejectionsAsHandled: {
      defaultValue: function () { return false },
      message: 'should be true|false',
      validate: function (value) { return value === true || value === false }
    },
    sendPayloadChecksums: {
      defaultValue: function () { return false },
      message: 'should be true|false',
      validate: function (value) { return value === true || value === false }
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

  // browser-lite overrides
  schema.releaseStage = assign({}, schema.releaseStage, {
    defaultValue: function () {
      if (/^localhost(:\d+)?$/.test(window.location.host)) return 'development'
      return 'production'
    }
  })

  schema.appType = assign({}, schema.appType, {
    defaultValue: function () { return 'browser' }
  })

  schema.logger = assign({}, schema.logger, {
    defaultValue: function () {
      return (typeof console !== 'undefined' && typeof console.debug === 'function')
        ? getPrefixedConsole()
        : undefined
    }
  })

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

  function getCauseStack (error) {
    if (error.cause) return [error].concat(getCauseStack(error.cause))
    return [error]
  }

  function makeSerialisable (err) {
    if (err === null) return 'null'
    if (err === undefined) return 'undefined'
    return err
  }

  function hasNecessaryFields (error) {
    return (typeof error.name === 'string' || typeof error.errorClass === 'string') &&
      (typeof error.message === 'string' || typeof error.errorMessage === 'string')
  }

  function normaliseError (maybeError, tolerateNonErrors, component, logger) {
    var error
    var internalFrames = 0

    var createAndLogInputError = function (reason) {
      var verb = (component === 'error cause' ? 'was' : 'received')
      if (logger) logger.warn(component + ' ' + verb + ' a non-error: "' + reason + '"')
      var err = new Error(component + ' ' + verb + ' a non-error. See "' + component + '" tab for more detail.')
      err.name = 'InvalidError'
      return err
    }

    if (!tolerateNonErrors) {
      if (isError(maybeError)) {
        error = maybeError
      } else {
        error = createAndLogInputError(typeof maybeError)
        internalFrames += 2
      }
    } else {
      switch (typeof maybeError) {
        case 'string':
        case 'number':
        case 'boolean':
          error = new Error(String(maybeError))
          internalFrames += 1
          break
        case 'function':
          error = createAndLogInputError('function')
          internalFrames += 2
          break
        case 'object':
          if (maybeError !== null && isError(maybeError)) {
            error = maybeError
          } else if (maybeError !== null && hasNecessaryFields(maybeError)) {
            error = new Error(maybeError.message || maybeError.errorMessage)
            error.name = maybeError.name || maybeError.errorClass
            internalFrames += 1
          } else {
            error = createAndLogInputError(maybeError === null ? 'null' : 'unsupported object')
            internalFrames += 2
          }
          break
        default:
          error = createAndLogInputError('nothing')
          internalFrames += 2
      }
    }

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
   * Breadcrumb / Session
   * ---------------------------------------------------------------------- */

  function Breadcrumb (message, metadata, type, timestamp) {
    this.type = type
    this.message = message
    this.metadata = metadata
    this.timestamp = timestamp || new Date()
  }

  Breadcrumb.prototype.toJSON = function () {
    return {
      type: this.type,
      name: this.message,
      timestamp: this.timestamp,
      metaData: this.metadata
    }
  }

  function cuid () {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0
      var v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  function Session () {
    this.id = cuid()
    this.startedAt = new Date()
    this._handled = 0
    this._unhandled = 0
    this._user = {}
    this.app = {}
    this.device = {}
  }

  Session.prototype.getUser = function () { return this._user }
  Session.prototype.setUser = function (id, email, name) { this._user = { id: id, email: email, name: name } }
  Session.prototype.toJSON = function () {
    return {
      id: this.id,
      startedAt: this.startedAt,
      events: { handled: this._handled, unhandled: this._unhandled }
    }
  }
  Session.prototype._track = function (event) {
    this[event._handledState.unhandled ? '_unhandled' : '_handled'] += 1
  }

  /* -------------------------------------------------------------------------
   * Event
   * ---------------------------------------------------------------------- */

  function Event (errorClass, errorMessage, stacktrace, handledState, originalError) {
    if (stacktrace === undefined) stacktrace = []
    if (handledState === undefined) handledState = defaultHandledState()

    this.apiKey = undefined
    this.context = undefined
    this.groupingHash = undefined
    this.originalError = originalError

    this._handledState = handledState
    this.severity = this._handledState.severity
    this.unhandled = this._handledState.unhandled

    this.app = {}
    this.device = {}
    this.request = {}
    this.response = {}

    this.breadcrumbs = []
    this.threads = []

    this._metadata = {}
    this._features = []
    this._featuresIndex = {}
    this._user = {}
    this._session = undefined
    this._correlation = undefined
    this._groupingDiscriminator = undefined

    this.errors = [
      createBugsnagError(errorClass, errorMessage, Event.__type, stacktrace)
    ]
  }

  Event.prototype.addMetadata = function (section, keyOrObj, maybeVal) {
    return metadataDelegate.add(this._metadata, section, keyOrObj, maybeVal)
  }

  Event.prototype.setTraceCorrelation = function (traceId, spanId) {
    if (typeof traceId === 'string') {
      this._correlation = { traceId: traceId }
      if (typeof spanId === 'string') this._correlation.spanId = spanId
    }
  }

  Event.prototype.getGroupingDiscriminator = function () { return this._groupingDiscriminator }

  Event.prototype.setGroupingDiscriminator = function (value) {
    var previousValue = this._groupingDiscriminator
    if (typeof value === 'string' || value === null || value === undefined) this._groupingDiscriminator = value
    return previousValue
  }

  Event.prototype.getMetadata = function (section, key) {
    return metadataDelegate.get(this._metadata, section, key)
  }

  Event.prototype.clearMetadata = function (section, key) {
    return metadataDelegate.clear(this._metadata, section, key)
  }

  Event.prototype.addFeatureFlag = function (name, variant) {
    if (variant === undefined) variant = null
    featureFlagDelegate.add(this._features, this._featuresIndex, name, variant)
  }

  Event.prototype.addFeatureFlags = function (featureFlags) {
    featureFlagDelegate.merge(this._features, featureFlags, this._featuresIndex)
  }

  Event.prototype.getFeatureFlags = function () {
    return featureFlagDelegate.toEventApi(this._features)
  }

  Event.prototype.clearFeatureFlag = function (name) {
    featureFlagDelegate.clear(this._features, this._featuresIndex, name)
  }

  Event.prototype.clearFeatureFlags = function () {
    this._features = []
    this._featuresIndex = {}
  }

  Event.prototype.getUser = function () { return this._user }
  Event.prototype.setUser = function (id, email, name) { this._user = { id: id, email: email, name: name } }

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
      response: this.response,
      breadcrumbs: this.breadcrumbs,
      context: this.context,
      groupingHash: this.groupingHash,
      groupingDiscriminator: this._groupingDiscriminator,
      metaData: this._metadata,
      user: this._user,
      session: this._session,
      featureFlags: this.getFeatureFlags(),
      correlation: this._correlation
    }
  }

  Event.getStacktrace = function (error, errorFramesToSkip, backtraceFramesToSkip) {
    if (hasStack(error)) return parseStack(error).slice(errorFramesToSkip)
    try {
      return filterArray(generateStack(), function (frame) {
        return (frame.functionName || '').indexOf('StackGenerator$$') === -1
      }).slice(1 + backtraceFramesToSkip)
    } catch (e) {
      return []
    }
  }

  Event.create = function (maybeError, tolerateNonErrors, handledState, component, errorFramesToSkip, logger) {
    if (errorFramesToSkip === undefined) errorFramesToSkip = 0

    var normalised = normaliseError(maybeError, tolerateNonErrors, component, logger)
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

    if (error.name === 'InvalidError') {
      event.addMetadata('' + component, 'non-error parameter', makeSerialisable(maybeError))
    }

    if (error.cause) {
      var causes = getCauseStack(error).slice(1)
      var normalisedCauses = mapArray(causes, function (cause) {
        var stacktrace = (isError(cause) && hasStack(cause)) ? parseStack(cause) : []
        var normalisedCause = normaliseError(cause, true, 'error cause', logger)[0]
        if (normalisedCause.name === 'InvalidError') event.addMetadata('error cause', makeSerialisable(cause))
        return createBugsnagError(normalisedCause.name, normalisedCause.message, Event.__type, stacktrace)
      })
      for (var ci = 0; ci < normalisedCauses.length; ci++) event.errors.push(normalisedCauses[ci])
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

  function runSyncCallbacks (callbacks, callbackArg, callbackType, logger) {
    var ignore = false
    var cbs = callbacks.slice()
    while (!ignore) {
      if (!cbs.length) break
      try {
        ignore = cbs.pop()(callbackArg) === false
      } catch (e) {
        logger.error('Error occurred in ' + callbackType + ' callback, continuing anyway…')
        logger.error(e)
      }
    }
    return ignore
  }

  /* -------------------------------------------------------------------------
   * Client
   * ---------------------------------------------------------------------- */

  function Client (configuration, schema, internalPlugins, notifier) {
    if (internalPlugins === undefined) internalPlugins = []

    this._notifier = notifier

    this._config = {}
    this._schema = schema

    this._delivery = { sendSession: noop, sendEvent: noop }
    this._logger = { debug: noop, info: noop, warn: noop, error: noop }

    this._plugins = {}

    this._breadcrumbs = []
    this._session = null
    this._metadata = {}
    this._featuresIndex = {}
    this._features = []
    this._context = undefined
    this._user = {}
    this._groupingDiscriminator = undefined

    this._cbs = { e: [], s: [], sp: [], b: [] }

    this.Client = Client
    this.Event = Event
    this.Breadcrumb = Breadcrumb
    this.Session = Session

    this._config = this._configure(configuration, internalPlugins)

    var plugins = internalPlugins.concat(this._config.plugins)
    for (var i = 0; i < plugins.length; i++) {
      if (plugins[i]) this._loadPlugin(plugins[i])
    }

    this._depth = 1

    var self = this
    var notify = this.notify
    this.notify = function () {
      return notify.apply(self, arguments)
    }
  }

  Client.prototype._configure = function (opts, internalPlugins) {
    var schema = reduceArray(internalPlugins || [], function (s, plugin) {
      if (plugin && plugin.configSchema) return assign({}, s, plugin.configSchema)
      return s
    }, this._schema)

    // sendPayloadChecksums is true by default unless custom endpoints are specified
    if (!opts.endpoints) {
      opts.sendPayloadChecksums = 'sendPayloadChecksums' in opts ? opts.sendPayloadChecksums : true
    }

    var accum = reduceArray(keys(schema), function (accum, key) {
      var defaultValue = schema[key].defaultValue(opts[key])

      if (opts[key] !== undefined) {
        var valid = schema[key].validate(opts[key])
        if (!valid) {
          accum.errors[key] = schema[key].message
          accum.config[key] = defaultValue
        } else {
          if (schema[key].allowPartialObject) accum.config[key] = assign(defaultValue, opts[key])
          else accum.config[key] = opts[key]
        }
      } else {
        accum.config[key] = defaultValue
      }

      return accum
    }, { errors: {}, config: {} })

    var errors = accum.errors
    var config = accum.config

    if (schema.apiKey) {
      if (!config.apiKey) throw new Error('No Bugsnag API Key set')
      if (!/^[0-9a-f]{32}$/i.test(config.apiKey)) errors.apiKey = 'should be a string of 32 hexadecimal characters'

      if (opts.endpoints === undefined && config.apiKey.indexOf(SECONDARY_ENDPOINT_API_KEY_PREFIX) === 0) {
        config.endpoints = {
          notify: SECONDARY_NOTIFY_ENDPOINT,
          sessions: SECONDARY_SESSIONS_ENDPOINT
        }
      }
    }

    this._metadata = assign({}, config.metadata)
    featureFlagDelegate.merge(this._features, config.featureFlags, this._featuresIndex)
    this._user = assign({}, config.user)
    this._context = config.context
    if (config.logger) this._logger = config.logger

    if (config.onError) this._cbs.e = this._cbs.e.concat(config.onError)
    if (config.onBreadcrumb) this._cbs.b = this._cbs.b.concat(config.onBreadcrumb)
    if (config.onSession) this._cbs.s = this._cbs.s.concat(config.onSession)

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

  Client.prototype.addFeatureFlag = function (featureName, variant) {
    if (variant === undefined) variant = null
    featureFlagDelegate.add(this._features, this._featuresIndex, featureName, variant)
  }

  Client.prototype.addFeatureFlags = function (featureFlags) {
    featureFlagDelegate.merge(this._features, featureFlags, this._featuresIndex)
  }

  Client.prototype.clearFeatureFlag = function (featureName) {
    featureFlagDelegate.clear(this._features, this._featuresIndex, featureName)
  }

  Client.prototype.clearFeatureFlags = function () {
    this._features = []
    this._featuresIndex = {}
  }

  Client.prototype.getContext = function () { return this._context }
  Client.prototype.setContext = function (c) { this._context = c }

  Client.prototype.getGroupingDiscriminator = function () { return this._groupingDiscriminator }

  Client.prototype.setGroupingDiscriminator = function (value) {
    var previousValue = this._groupingDiscriminator
    if (typeof value === 'string' || value === null || value === undefined) this._groupingDiscriminator = value
    return previousValue
  }

  Client.prototype.getUser = function () { return this._user }
  Client.prototype.setUser = function (id, email, name) { this._user = { id: id, email: email, name: name } }

  Client.prototype._loadPlugin = function (plugin) {
    var result = plugin.load(this)
    if (plugin.name) this._plugins['~' + plugin.name + '~'] = result
  }

  Client.prototype.getPlugin = function (pluginName) {
    return this._plugins['~' + pluginName + '~']
  }

  Client.prototype._setDelivery = function (d) {
    this._delivery = d(this)
  }

  Client.prototype.startSession = function () {
    var session = new Session()

    session.app.releaseStage = this._config.releaseStage
    session.app.version = this._config.appVersion
    session.app.type = this._config.appType

    session._user = assign({}, this._user)

    var ignore = runSyncCallbacks(this._cbs.s, session, 'onSession', this._logger)

    if (ignore) {
      this._logger.debug('Session not started due to onSession callback')
      return this
    }

    return this._sessionDelegate.startSession(this, session)
  }

  Client.prototype.addOnError = function (fn, front) {
    this._cbs.e[front ? 'unshift' : 'push'](fn)
  }

  Client.prototype.removeOnError = function (fn) {
    this._cbs.e = filterArray(this._cbs.e, function (f) { return f !== fn })
  }

  Client.prototype._addOnSessionPayload = function (fn) {
    this._cbs.sp.push(fn)
  }

  Client.prototype.addOnSession = function (fn) {
    this._cbs.s.push(fn)
  }

  Client.prototype.removeOnSession = function (fn) {
    this._cbs.s = filterArray(this._cbs.s, function (f) { return f !== fn })
  }

  Client.prototype.addOnBreadcrumb = function (fn, front) {
    this._cbs.b[front ? 'unshift' : 'push'](fn)
  }

  Client.prototype.removeOnBreadcrumb = function (fn) {
    this._cbs.b = filterArray(this._cbs.b, function (f) { return f !== fn })
  }

  Client.prototype.pauseSession = function () {
    return this._sessionDelegate.pauseSession(this)
  }

  Client.prototype.resumeSession = function () {
    return this._sessionDelegate.resumeSession(this)
  }

  Client.prototype.leaveBreadcrumb = function (message, metadata, type) {
    message = typeof message === 'string' ? message : ''
    type = (typeof type === 'string' && includes(BREADCRUMB_TYPES, type)) ? type : 'manual'
    metadata = typeof metadata === 'object' && metadata !== null ? metadata : {}

    if (!message) return

    var crumb = new Breadcrumb(message, metadata, type)

    var ignore = runSyncCallbacks(this._cbs.b, crumb, 'onBreadcrumb', this._logger)

    if (ignore) {
      this._logger.debug('Breadcrumb not attached due to onBreadcrumb callback')
      return
    }

    this._breadcrumbs.push(crumb)
    if (this._breadcrumbs.length > this._config.maxBreadcrumbs) {
      this._breadcrumbs = this._breadcrumbs.slice(this._breadcrumbs.length - this._config.maxBreadcrumbs)
    }
  }

  Client.prototype._isBreadcrumbTypeEnabled = function (type) {
    var types = this._config.enabledBreadcrumbTypes
    return types === null || includes(types, type)
  }

  Client.prototype.notify = function (maybeError, onError, postReportCallback) {
    if (postReportCallback === undefined) postReportCallback = noop
    var event = Event.create(maybeError, true, undefined, 'notify()', this._depth + 1, this._logger)
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
    event._user = assign({}, event._user, this._user)
    event.breadcrumbs = this._breadcrumbs.slice()
    event.setGroupingDiscriminator(this._groupingDiscriminator)
    featureFlagDelegate.merge(event._features, this._features, event._featuresIndex)

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
    runCallbacks(callbacks, event, onCallbackError, function (err, shouldSend) {
      if (err) onCallbackError(err)

      if (!shouldSend) {
        self._logger.debug('Event not sent due to onError callback')
        return postReportCallback(null, event)
      }

      if (self._isBreadcrumbTypeEnabled('error')) {
        Client.prototype.leaveBreadcrumb.call(self, event.errors[0].errorClass, {
          errorClass: event.errors[0].errorClass,
          errorMessage: event.errors[0].errorMessage,
          severity: event.severity
        }, 'error')
      }

      if (originalSeverity !== event.severity) {
        event._handledState.severityReason = { type: 'userCallbackSetSeverity' }
      }

      if (event.unhandled !== event._handledState.unhandled) {
        event._handledState.severityReason.unhandledOverridden = true
        event._handledState.unhandled = event.unhandled
      }

      if (self._session) {
        self._session._track(event)
        event._session = self._session
      }

      self._delivery.sendEvent({
        apiKey: event.apiKey || self._config.apiKey,
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
   * plugins
   * ---------------------------------------------------------------------- */

  function devicePlugin (nav, win) {
    if (nav === undefined) nav = navigator
    if (win === undefined) win = window

    return {
      load: function (client) {
        var device = {
          locale: nav.browserLanguage || nav.systemLanguage || nav.userLanguage || nav.language,
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
    }
  }

  function contextPlugin (win) {
    if (win === undefined) win = window

    return {
      load: function (client) {
        client.addOnError(function (event) {
          if (event.context !== undefined) return
          event.context = win.location.pathname
        }, true)
      }
    }
  }

  function requestPlugin (win) {
    if (win === undefined) win = window

    return {
      load: function (client) {
        client.addOnError(function (event) {
          if (event.request && event.request.url) return
          event.request = assign({}, event.request, { url: win.location.href })
        }, true)
      }
    }
  }

  var throttlePlugin = {
    load: function (client) {
      var n = 0

      client.addOnError(function (event) {
        if (n >= client._config.maxEvents) {
          client._logger.warn('Cancelling event send due to maxEvents per session limit of ' + client._config.maxEvents + ' being reached')
          return false
        }
        n++
      })

      client.resetEventCount = function () { n = 0 }
    },
    configSchema: {
      maxEvents: {
        defaultValue: function () { return 10 },
        message: 'should be a positive integer <=100',
        validate: function (val) { return intRange(1, 100)(val) }
      }
    }
  }

  function stripQueryString (str) {
    return typeof str === 'string'
      ? str.replace(/\?.*$/, '').replace(/#.*$/, '')
      : str
  }

  var stripQueryStringPlugin = {
    load: function (client) {
      client.addOnError(function (event) {
        var allFrames = reduceArray(event.errors, function (accum, er) { return accum.concat(er.stacktrace) }, [])
        for (var i = 0; i < allFrames.length; i++) {
          allFrames[i].file = stripQueryString(allFrames[i].file)
        }
      })
    }
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

  function windowOnerrorPlugin (win, component) {
    if (win === undefined) win = window
    if (component === undefined) component = 'window onerror'

    return {
      load: function (client) {
        if (!client._config.autoDetectErrors) return
        if (!client._config.enabledErrorTypes.unhandledExceptions) return

        var prevOnError = win.onerror

        function onerror (messageOrEvent, url, lineNo, charNo, error) {
          if (lineNo === 0 && /Script error\.?/.test(messageOrEvent)) {
            client._logger.warn('Ignoring cross-domain or eval script error. See docs: https://tinyurl.com/yy3rn63z')
          } else {
            var handledState = { severity: 'error', unhandled: true, severityReason: { type: 'unhandledException' } }
            var event

            if (error) {
              event = client.Event.create(error, true, handledState, component, 1)
              decorateStack(event.errors[0].stacktrace, url, lineNo, charNo)
            } else if (
              (typeof messageOrEvent === 'object' && messageOrEvent !== null) &&
              (!url || typeof url !== 'string') &&
              !lineNo && !charNo && !error
            ) {
              var errName = messageOrEvent.type ? 'Event: ' + messageOrEvent.type : 'Error'
              var errMessage = messageOrEvent.message || messageOrEvent.detail || ''
              event = client.Event.create({ name: errName, message: errMessage }, true, handledState, component, 1)
              event.originalError = messageOrEvent
              event.addMetadata(component, { event: messageOrEvent, extraParameters: url })
            } else {
              event = client.Event.create(messageOrEvent, true, handledState, component, 1)
              decorateStack(event.errors[0].stacktrace, url, lineNo, charNo)
            }

            client._notify(event)
          }

          try { prevOnError.apply(this, arguments) } catch (e) {}
        }

        win.onerror = onerror
      }
    }
  }

  function fixBluebirdStacktrace (error) {
    return function (frame) {
      if (frame.file === error.toString()) return
      if (frame.method) frame.method = frame.method.replace(/^\s+/, '')
    }
  }

  function unhandledRejectionPlugin (win) {
    if (win === undefined) win = window

    var listener

    var plugin = {
      load: function (client) {
        if (!client._config.autoDetectErrors || !client._config.enabledErrorTypes.unhandledRejections) return

        listener = function (evt) {
          var error = evt.reason
          var isBluebird = false

          try {
            if (evt.detail && evt.detail.reason) {
              error = evt.detail.reason
              isBluebird = true
            }
          } catch (e) {}

          var unhandled = !client._config.reportUnhandledPromiseRejectionsAsHandled

          var event = client.Event.create(error, false, {
            severity: 'error',
            unhandled: unhandled,
            severityReason: { type: 'unhandledPromiseRejection' }
          }, 'unhandledrejection handler', 1, client._logger)

          if (isBluebird) mapArray(event.errors[0].stacktrace, fixBluebirdStacktrace(error))

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

        if ('addEventListener' in win) {
          win.addEventListener('unhandledrejection', listener)
        } else {
          win.onunhandledrejection = function (reason, promise) {
            listener({ detail: { reason: reason, promise: promise } })
          }
        }
      }
    }

    if (process.env.NODE_ENV !== 'production') {
      plugin.destroy = function (w) {
        if (w === undefined) w = window
        if (listener) {
          if ('addEventListener' in w) {
            w.removeEventListener('unhandledrejection', listener)
          } else {
            w.onunhandledrejection = null
          }
        }
        listener = null
      }
    }

    return plugin
  }

  var consoleBreadcrumbsPlugin = {
    load: function (client) {
      var isDev = /^(local-)?dev(elopment)?$/.test(client._config.releaseStage)

      if (isDev || !client._isBreadcrumbTypeEnabled('log')) return

      var methods = filterArray(['log', 'debug', 'info', 'warn', 'error'], function (method) {
        return typeof console !== 'undefined' && typeof console[method] === 'function'
      })

      for (var i = 0; i < methods.length; i++) {
        (function (method) {
          var original = console[method]
          console[method] = function () {
            var args = arguments
            var metadata = { severity: method.indexOf('group') === 0 ? 'log' : method }
            for (var j = 0; j < args.length; j++) {
              var arg = args[j]
              var stringified = '[Unknown value]'
              try { stringified = String(arg) } catch (e) {}
              if (stringified === '[object Object]') {
                try { stringified = JSON.stringify(arg) } catch (e) {}
              }
              metadata['[' + j + ']'] = stringified
            }
            client.leaveBreadcrumb('Console output', metadata, 'log')
            original.apply(console, args)
          }
          console[method]._restore = function () { console[method] = original }
        })(methods[i])
      }
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    consoleBreadcrumbsPlugin.destroy = function () {
      var methods = ['log', 'debug', 'info', 'warn', 'error']
      for (var i = 0; i < methods.length; i++) {
        if (console[methods[i]] && typeof console[methods[i]]._restore === 'function') {
          console[methods[i]]._restore()
        }
      }
    }
  }

  /* -------------------------------------------------------------------------
   * delivery
   * ---------------------------------------------------------------------- */

  var EVENT_REDACTION_PATHS = [
    'events.[].metaData',
    'events.[].breadcrumbs.[].metaData',
    'events.[].request',
    'events.[].response'
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

  function toHex (buffer) {
    var bytes = new Uint8Array(buffer)
    var hex = ''
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i].toString(16)
      hex += b.length === 1 ? '0' + b : b
    }
    return hex
  }

  function getIntegrityHeaderValue (win, requestBody) {
    if (win.isSecureContext && win.crypto && win.crypto.subtle && win.crypto.subtle.digest && typeof TextEncoder === 'function') {
      var msgUint8 = new TextEncoder().encode(requestBody)
      return win.crypto.subtle.digest('SHA-1', msgUint8).then(function (hashBuffer) {
        return 'sha1 ' + toHex(hashBuffer)
      })
    }
    return Promise.resolve()
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
          req.setRequestHeader('Bugsnag-Api-Key', event.apiKey || client._config.apiKey)
          req.setRequestHeader('Bugsnag-Payload-Version', '4')
          req.setRequestHeader('Bugsnag-Sent-At', (new Date()).toISOString())

          if (client._config.sendPayloadChecksums && typeof Promise !== 'undefined' && Promise.toString().indexOf('[native code]') !== -1) {
            getIntegrityHeaderValue(win, body).then(function (integrity) {
              if (integrity) req.setRequestHeader('Bugsnag-Integrity', integrity)
              req.send(body)
            }).catch(function (err) {
              client._logger.error(err)
              req.send(body)
            })
          } else {
            req.send(body)
          }
        } catch (e) {
          client._logger.error(e)
        }
      },
      sendSession: function (session, cb) {
        if (cb === undefined) cb = function () {}
        cb(new Error('Session not sent due to incomplete endpoint configuration'))
      }
    }
  }

  /* -------------------------------------------------------------------------
   * static API
   * ---------------------------------------------------------------------- */

  var UNSUPPORTED_METHODS = ['startSession', 'pauseSession', 'resumeSession']

  var Bugsnag = {
    _client: null,
    createClient: function (opts) {
      if (typeof opts === 'string') opts = { apiKey: opts }
      if (!opts) opts = {}

      var internalPlugins = [
        devicePlugin(),
        contextPlugin(),
        requestPlugin(),
        throttlePlugin,
        stripQueryStringPlugin,
        windowOnerrorPlugin(),
        unhandledRejectionPlugin(),
        consoleBreadcrumbsPlugin
      ]

      var bugsnag = new Client(opts, schema, internalPlugins, { name: name, version: version, url: url })

      bugsnag._setDelivery(xmlHttpRequestDelivery)

      bugsnag._logger.debug('Loaded!')
      bugsnag.leaveBreadcrumb('Bugsnag loaded', {}, 'state')

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
      if (indexOf(UNSUPPORTED_METHODS, m) !== -1) return
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
  module.exports._device = devicePlugin
  module.exports._strip = stripQueryString
  module.exports.config = schema
})()
