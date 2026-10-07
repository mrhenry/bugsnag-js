/*
 * @mrhenry/browser-mini
 *
 * A minimal, privacy-leaning Bugsnag error reporter for browsers.
 *
 * Clean-sheet, dependency-free ES module (ES3-compatible runtime). See SPEC.md.
 */

var MAX_EVENTS = 10
var MAX_DEPTH = 20
var MAX_EDGES = 25000
var MIN_DEPTH = 8

function noop () {}
function has (o, k) { return Object.prototype.hasOwnProperty.call(o, k) }
function isArray (o) { return Object.prototype.toString.call(o) === '[object Array]' }
function isFn (f) { return typeof f === 'function' }
function isString (s) { return typeof s === 'string' }
function isError (o) {
  return o instanceof Error || /^\[object (Error|(Dom)?Exception)\]$/.test(Object.prototype.toString.call(o))
}
function includes (a, x) {
  for (var i = 0; i < a.length; i++) if (a[i] === x) return true
  return false
}
function assign (t) {
  for (var i = 1; i < arguments.length; i++) {
    var s = arguments[i]
    if (!s) continue
    for (var k in s) if (has(s, k)) t[k] = s[k]
  }
  return t
}

/* safe JSON serialisation (with key redaction) */

function throwsMessage (e) { return '[Throws: ' + e.message + ']' }

function safeJson (data) {
  var seen = []
  var edges = 0

  function visit (obj, depth) {
    edges++
    if (depth > MAX_DEPTH || (depth > MIN_DEPTH && edges > MAX_EDGES)) return '...'
    if (obj === null || typeof obj !== 'object') return obj

    for (var i = 0; i < seen.length; i++) if (seen[i] === obj) return '[Circular]'
    seen.push(obj)

    var result
    if (isFn(obj.toJSON)) {
      try { result = visit(obj.toJSON(), depth) } catch (e) { result = throwsMessage(e) }
    } else if (isError(obj)) {
      result = visit({ name: obj.name, message: obj.message }, depth)
    } else if (isArray(obj)) {
      result = []
      for (var j = 0; j < obj.length; j++) result.push(visit(obj[j], depth + 1))
    } else {
      result = {}
      for (var k in obj) {
        if (!has(obj, k)) continue
        if (k.toLowerCase() === 'password') { result[k] = '[REDACTED]'; continue }
        var v
        try { v = obj[k] } catch (e) { result[k] = throwsMessage(e); continue }
        result[k] = visit(v, depth + 1)
      }
    }

    seen.pop()
    return result
  }

  return JSON.stringify(visit(data, 0))
}

/* metadata */

function addMetadata (state, section, keyOrObj, maybeVal) {
  if (!section) return
  if (keyOrObj === null) { delete state[section]; return }

  var updates
  if (typeof keyOrObj === 'object') updates = keyOrObj
  else if (isString(keyOrObj)) { updates = {}; updates[keyOrObj] = maybeVal }
  if (!updates) return
  if (/^(__proto__|constructor|prototype)$/.test(section)) return

  if (!state[section]) state[section] = {}
  state[section] = assign({}, state[section], updates)
}

/* stacktrace parsing */

function makeFrame (fn, file, line, col) {
  if (fn === undefined && file === undefined && line === undefined && col === undefined) return null
  var f = {
    file: file,
    method: /^global code$/i.test(fn) ? 'global code' : fn,
    lineNumber: line === undefined ? undefined : +line,
    columnNumber: col === undefined ? undefined : +col
  }
  if (f.lineNumber > -1 && !f.file && !f.method) f.file = 'global code'
  return f
}

function parseStackLine (raw) {
  var line = raw.replace(/^\s+|\s+$/g, '')
  if (!line) return null
  var m

  // V8 / Chromium: "    at fn (file:line:col)" or "    at file:line:col"
  if (line.indexOf('at ') === 0) {
    var rest = line.slice(3)
    m = rest.match(/^(.*?)\s*\((.*):(\d+):(\d+)\)$/)
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
    m = loc.match(/^(.*):(\d+):(\d+)$/)
    if (m) return makeFrame(fn || undefined, m[1], m[2], m[3])
    return makeFrame(fn || undefined, loc, undefined, undefined)
  }

  m = line.match(/^(.*):(\d+):(\d+)$/)
  return m ? makeFrame(undefined, m[1], m[2], m[3]) : null
}

function normaliseError (maybeError) {
  if (isError(maybeError)) return maybeError
  try {
    return new Error(String(maybeError))
  } catch (e) {
    return new Error('[unserialisable]')
  }
}

/* Event */

function Event (errorClass, errorMessage, stacktrace, handledState) {
  if (handledState === undefined) {
    handledState = { unhandled: false, severity: 'warning', severityReason: { type: 'handledException' } }
  }

  this._handledState = handledState
  this.severity = handledState.severity
  this.unhandled = handledState.unhandled
  this._metadata = {}
  this.errors = [{
    errorClass: errorClass,
    errorMessage: errorMessage,
    type: 'browserjs',
    stacktrace: stacktrace
  }]
}

Event.prototype.addMetadata = function (section, keyOrObj, maybeVal) {
  return addMetadata(this._metadata, section, keyOrObj, maybeVal)
}

Event.prototype.toJSON = function () {
  var exceptions = []
  for (var i = 0; i < this.errors.length; i++) {
    var e = this.errors[i]
    exceptions.push(assign({}, e, { message: e.errorMessage }))
  }
  return {
    payloadVersion: '4',
    exceptions: exceptions,
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
  var stack = error.stack
  var frames = []
  if (isString(stack) && stack !== error.name + ': ' + error.message) {
    var lines = stack.split('\n')
    for (var i = 0; i < lines.length; i++) {
      var frame = parseStackLine(lines[i])
      if (frame) frames.push(frame)
    }
  }
  return new Event(error.name, error.message, frames, handledState)
}

/* callback runner */

function runCallbacks (callbacks, event, logger) {
  for (var i = 0; i < callbacks.length; i++) {
    var fn = callbacks[i]
    if (!isFn(fn)) continue
    try {
      if (fn(event) === false) return false
    } catch (e) {
      logger.error('Error occurred in onError callback, continuing anyway…')
      logger.error(e)
    }
  }
  return true
}

/* configuration */

function getLogger () {
  var logger = {}
    var methods = ['debug', 'warn', 'error']
  for (var i = 0; i < methods.length; i++) {
    var m = methods[i]
    logger[m] = (function (m) {
      var fn = isFn(console[m]) ? console[m] : console.log
      return function () {
        fn.apply(console, ['[bugsnag]'].concat(Array.prototype.slice.call(arguments)))
      }
    })(m)
  }
  return logger
}

/* Client */

function Client (configuration, notifier) {
  this._notifier = notifier
  this._delivery = { sendEvent: noop }
  this._logger = getLogger()
  this._metadata = {}
  this._cbs = []
  this.Client = Client
  this.Event = Event
  this._config = this._configure(configuration)
}

Client.prototype._configure = function (opts) {
  if (!opts.apiKey) throw new Error('No Bugsnag API Key set')

  if (opts.onError) this._cbs = [].concat(opts.onError)

  return {
    apiKey: opts.apiKey,
    appType: opts.appType || 'browser',
    onError: opts.onError || [],
    enabledReleaseStages: opts.enabledReleaseStages || null,
    releaseStage: opts.releaseStage || 'development'
  }
}

Client.prototype.addMetadata = function (section, keyOrObj, maybeVal) {
  return addMetadata(this._metadata, section, keyOrObj, maybeVal)
}

Client.prototype.addOnError = function (fn, front) {
  this._cbs[front ? 'unshift' : 'push'](fn)
}

Client.prototype.notify = function (maybeError) {
  this._notify(Event.create(maybeError))
}

Client.prototype._notify = function (event) {
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

  if (!runCallbacks(this._cbs, event, this._logger)) {
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

  this._delivery.sendEvent({
    apiKey: this._config.apiKey,
    notifier: this._notifier,
    events: [event]
  })
}

/* automatic enrichment & capture */

function setupEnrichment (client) {
  var nav = window.navigator
  var device = { locale: nav.language, userAgent: nav.userAgent }

  if (window.screen && window.screen.orientation && window.screen.orientation.type) {
    device.orientation = window.screen.orientation.type
  } else if (window.document) {
    device.orientation =
      window.document.documentElement.clientWidth > window.document.documentElement.clientHeight
        ? 'landscape'
        : 'portrait'
  }

  if (typeof window.innerWidth === 'number') device.windowWidth = window.innerWidth
  if (typeof window.innerHeight === 'number') device.windowHeight = window.innerHeight

  client.addOnError(function (event) {
    event.device = assign({}, event.device, device, { time: new Date() })
    if (event.context === undefined) event.context = window.location.pathname
    if (!event.request || !event.request.url) {
      event.request = assign({}, event.request, { url: window.location.href })
    }
  }, true)
}

function setupThrottle (client) {
  var n = 0
  client.addOnError(function (event) {
    if (n >= MAX_EVENTS) {
      client._logger.warn('Cancelling event send due to maxEvents limit of ' + MAX_EVENTS + ' being reached')
      return false
    }
    n++
    for (var i = 0; i < event.errors.length; i++) {
      var frames = event.errors[i].stacktrace
      for (var j = 0; j < frames.length; j++) {
        if (isString(frames[j].file)) frames[j].file = frames[j].file.replace(/[?#].*$/, '')
      }
    }
  })
}

function decorateStack (stack, url, lineNo, charNo) {
  if (!stack[0]) stack.push({})
  var culprit = stack[0]
  if (!culprit.file && isString(url)) culprit.file = url
  if (!culprit.lineNumber && typeof lineNo === 'number' && !isNaN(lineNo)) culprit.lineNumber = lineNo
  if (!culprit.columnNumber && typeof charNo === 'number' && !isNaN(charNo)) culprit.columnNumber = charNo
}

function setupWindowOnerror (client) {
  var prevOnError = window.onerror

  window.onerror = function (message, url, lineNo, charNo, error) {
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
}

function setupUnhandledRejection (client) {
  window.addEventListener('unhandledrejection', function (evt) {
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
  })
}

/* delivery */

function xmlHttpRequestDelivery (client) {
  return {
    sendEvent: function (event) {
      try {
        var req = new window.XMLHttpRequest()
        var body = safeJson(event)
        if (body.length > 1000000) {
          event.events[0]._metadata = {
            notifier: 'WARNING!\nSerialized payload was ' + (body.length / 1000000) + 'MB (limit = 1MB)\nmetadata was removed'
          }
          body = safeJson(event)
        }

        req.onreadystatechange = function () {
          if (req.readyState === window.XMLHttpRequest.DONE) {
            var status = req.status
            if (status === 0 || status >= 400) {
              client._logger.error('Event failed to send…', new Error('Request failed with status ' + status))
            }
          }
        }

        req.open('POST', 'https://notify.bugsnag.com')
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

/* public API */

export function createClient (opts) {
  if (isString(opts)) opts = { apiKey: opts }
  if (!opts) opts = {}

  var client = new Client(opts, {
    name: 'Bugsnag JavaScript',
    version: '__VERSION__',
    url: 'https://github.com/bugsnag/bugsnag-js'
  })

  setupEnrichment(client)
  setupThrottle(client)
  setupWindowOnerror(client)
  setupUnhandledRejection(client)

  client._delivery = xmlHttpRequestDelivery(client)
  client._logger.debug('Loaded!')

  return client
}
