// Behaviour of each bundled browser plugin, exercised directly.
const Event = require('@bugsnag/core/event')

function makeLogger () {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

function makeClient (overrides: any = {}) {
  const events: any[] = []
  return Object.assign({
    _config: {
      autoDetectErrors: true,
      enabledErrorTypes: { unhandledExceptions: true, unhandledRejections: true },
      reportUnhandledPromiseRejectionsAsHandled: false,
      releaseStage: 'production'
    },
    _logger: makeLogger(),
    Event,
    _notify: (event: any, cb?: any) => { events.push(event); if (cb) cb(event) },
    events
  }, overrides)
}

describe('plugin-window-onerror', () => {
  const makePlugin = require('@bugsnag/plugin-window-onerror')

  it('captures a modern uncaught exception', () => {
    const win: any = {}
    const client = makeClient()
    makePlugin(win, 'window onerror').load(client)
    win.onerror('msg', 'http://x/a.js', 1, 2, new Error('boom'))
    expect(client.events).toHaveLength(1)
    expect(client.events[0].severity).toBe('error')
    expect(client.events[0]._handledState.unhandled).toBe(true)
  })

  it('captures jQuery-style synthetic events', () => {
    const win: any = {}
    const client = makeClient()
    makePlugin(win, 'window onerror').load(client)
    win.onerror({ type: 'click', message: 'clicked' }, { extra: 1 })
    expect(client.events).toHaveLength(1)
    expect(client.events[0].errors[0].errorClass).toBe('Event: click')
    expect(client.events[0].getMetadata('window onerror')).toBeDefined()
  })

  it('captures legacy events with no error object', () => {
    const win: any = {}
    const client = makeClient()
    makePlugin(win, 'window onerror').load(client)
    win.onerror('legacy msg', 'http://x/a.js', 3, 4)
    expect(client.events).toHaveLength(1)
    expect(client.events[0].errors[0].errorMessage).toBe('legacy msg')
  })

  it('uses a synthetic event detail as the message when there is no message', () => {
    const win: any = {}
    const client = makeClient()
    makePlugin(win).load(client)
    win.onerror({ detail: 'detailed' }, { extra: 1 })
    expect(client.events[0].errors[0].errorMessage).toBe('detailed')
  })

  it('uses a generic name and empty message for a synthetic event with no type or message', () => {
    const win: any = {}
    const client = makeClient()
    makePlugin(win).load(client)
    win.onerror({}, { extra: 1 })
    expect(client.events[0].errors[0].errorClass).toBe('Error')
    expect(client.events[0].errors[0].errorMessage).toBe('')
  })

  it('ignores cross-domain script errors', () => {
    const win: any = {}
    const client = makeClient()
    makePlugin(win, 'window onerror').load(client)
    win.onerror('Script error.', '', 0, 0)
    expect(client.events).toHaveLength(0)
    expect(client._logger.warn).toHaveBeenCalled()
  })

  it('decorates a frame using window.event.errorCharacter', () => {
    const win: any = {}
    const client = makeClient()
    makePlugin(win, 'window onerror').load(client)
    ;(window as any).event = { errorCharacter: 7 }
    try {
      const err: any = new Error('boom')
      // a stack line with no column so decorateStack fills it from window.event
      err.stack = 'Error: boom\n    at foo (http://x/a.js:3)'
      win.onerror('boom', 'http://x/a.js', 3, undefined, err)
      expect(client.events[0].errors[0].stacktrace[0].columnNumber).toBe(7)
    } finally {
      delete (window as any).event
    }
  })

  it('calls and tolerates a previous onerror handler', () => {
    const win: any = { onerror: () => { throw new Error('prev') } }
    const client = makeClient()
    makePlugin(win, 'window onerror').load(client)
    expect(() => win.onerror('msg', 'u', 1, 1, new Error('boom'))).not.toThrow()
  })

  it('does nothing when autoDetectErrors or the error type is disabled', () => {
    const win: any = {}
    const client = makeClient({ _config: { autoDetectErrors: false, enabledErrorTypes: { unhandledExceptions: true } } })
    makePlugin(win, 'window onerror').load(client)
    expect(win.onerror).toBeUndefined()

    const win2: any = {}
    const client2 = makeClient({ _config: { autoDetectErrors: true, enabledErrorTypes: { unhandledExceptions: false } } })
    makePlugin(win2, 'window onerror').load(client2)
    expect(win2.onerror).toBeUndefined()
  })

  describe('stack decoration', () => {
    function fakeClient (stack: any[]) {
      const event: any = { errors: [{ stacktrace: stack }], addMetadata: jest.fn(), originalError: null }
      return {
        _config: { autoDetectErrors: true, enabledErrorTypes: { unhandledExceptions: true } },
        _logger: makeLogger(),
        Event: { create: jest.fn(() => event) },
        _notify: jest.fn(),
        event
      }
    }

    it('creates a frame when there is none and fills in file, line and column', () => {
      const client: any = fakeClient([])
      const win: any = {}
      makePlugin(win).load(client)
      win.onerror('msg', 'http://x/a.js', 5, 6, new Error('boom'))
      expect(client.event.errors[0].stacktrace[0]).toStrictEqual({ file: 'http://x/a.js', lineNumber: 5, columnNumber: 6 })
    })

    it('ignores a non-string url and non-numeric positions', () => {
      const client: any = fakeClient([])
      const win: any = {}
      makePlugin(win).load(client)
      win.onerror('msg', { not: 'a string' }, 'x', 'y', new Error('boom'))
      expect(client.event.errors[0].stacktrace[0]).toStrictEqual({})
    })

    it('leaves an already-populated frame untouched', () => {
      const client: any = fakeClient([{ file: 'f', lineNumber: 1, columnNumber: 2 }])
      const win: any = {}
      makePlugin(win).load(client)
      win.onerror('msg', 'http://x/a.js', 5, 6, new Error('boom'))
      expect(client.event.errors[0].stacktrace[0]).toStrictEqual({ file: 'f', lineNumber: 1, columnNumber: 2 })
    })

    it('uses window.event.errorCharacter when charNo is absent', () => {
      const client: any = fakeClient([])
      const win: any = {}
      makePlugin(win).load(client)
      ;(window as any).event = { errorCharacter: 9 }
      try {
        win.onerror('msg', undefined, undefined, undefined, new Error('boom'))
      } finally {
        delete (window as any).event
      }
      expect(client.event.errors[0].stacktrace[0]).toStrictEqual({ columnNumber: 9 })
    })

    it('ignores a non-numeric window.event.errorCharacter', () => {
      const client: any = fakeClient([])
      const win: any = {}
      makePlugin(win).load(client)
      ;(window as any).event = { errorCharacter: 'nope' }
      try {
        win.onerror('msg', undefined, undefined, undefined, new Error('boom'))
      } finally {
        delete (window as any).event
      }
      expect(client.event.errors[0].stacktrace[0]).toStrictEqual({})
    })
  })
})

describe('plugin-window-unhandled-rejection', () => {
  const makePlugin = require('@bugsnag/plugin-window-unhandled-rejection')

  it('captures rejections via addEventListener', () => {
    let listener: any
    const win: any = { addEventListener: (type: string, fn: any) => { listener = fn }, removeEventListener: jest.fn() }
    const client = makeClient()
    makePlugin(win).load(client)
    listener({ reason: new Error('rejected') })
    expect(client.events).toHaveLength(1)
    expect(client.events[0]._handledState.severityReason.type).toBe('unhandledPromiseRejection')
  })

  it('handles Bluebird-style rejection details', () => {
    let listener: any
    const win: any = { addEventListener: (type: string, fn: any) => { listener = fn }, removeEventListener: jest.fn() }
    const client = makeClient()
    makePlugin(win).load(client)
    listener({ detail: { reason: new Error('bluebird') } })
    expect(client.events[0].errors[0].errorMessage).toBe('bluebird')
  })

  it('honours reportUnhandledPromiseRejectionsAsHandled', () => {
    let listener: any
    const win: any = { addEventListener: (type: string, fn: any) => { listener = fn }, removeEventListener: jest.fn() }
    const client = makeClient({ _config: { autoDetectErrors: true, enabledErrorTypes: { unhandledRejections: true }, reportUnhandledPromiseRejectionsAsHandled: true } })
    makePlugin(win).load(client)
    listener({ reason: new Error('r') })
    expect(client.events[0]._handledState.unhandled).toBe(false)
  })

  it('fixes a Bluebird stacktrace by dropping the spurious frame and trimming methods', () => {
    let listener: any
    const win: any = { addEventListener: (type: string, fn: any) => { listener = fn }, removeEventListener: jest.fn() }
    const reason: any = new Error('bluebird')
    const frames = [
      { file: reason.toString() },
      { file: 'http://x/a.js', method: '   padded' }
    ]
    const event: any = { errors: [{ stacktrace: frames }], originalError: reason, addMetadata: jest.fn() }
    const client = makeClient({ Event: { create: jest.fn(() => event) } })
    makePlugin(win).load(client)
    listener({ detail: { reason } })
    expect(frames[0].file).toBe(reason.toString())
    expect(frames[1].method).toBe('padded')
  })

  it('adds metadata for an error reason without a stack', () => {
    let listener: any
    const win: any = { addEventListener: (type: string, fn: any) => { listener = fn }, removeEventListener: jest.fn() }
    const client = makeClient()
    makePlugin(win).load(client)
    const err: any = new Error('no stack')
    delete err.stack
    listener({ reason: err })
    expect(client.events[0].getMetadata('unhandledRejection handler')).toBeDefined()
  })

  it('falls back to onunhandledrejection when addEventListener is missing', () => {
    const win: any = {}
    const client = makeClient()
    makePlugin(win).load(client)
    win.onunhandledrejection(new Error('legacy'), Promise.resolve())
    expect(client.events).toHaveLength(1)
  })

  it('can be destroyed', () => {
    const removeEventListener = jest.fn()
    const win: any = { addEventListener: jest.fn(), removeEventListener }
    const plugin = makePlugin(win)
    plugin.load(makeClient())
    plugin.destroy(win)
    expect(removeEventListener).toHaveBeenCalled()

    const win2: any = {}
    const plugin2 = makePlugin(win2)
    plugin2.load(makeClient())
    plugin2.destroy(win2)
    expect(win2.onunhandledrejection).toBeNull()
  })

  it('destroy defaults its window and is a no-op once already destroyed', () => {
    const plugin = makePlugin({ addEventListener: jest.fn(), removeEventListener: jest.fn() })
    plugin.load(makeClient())
    plugin.destroy()
    expect(() => plugin.destroy()).not.toThrow()
  })

  it('does not define destroy in production builds', () => {
    const original = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      jest.resetModules()
      const prodPlugin = require('@bugsnag/plugin-window-unhandled-rejection')
      expect(prodPlugin({}).destroy).toBeUndefined()
    } finally {
      process.env.NODE_ENV = original
    }
  })

  it('does nothing when disabled', () => {
    const win: any = { addEventListener: jest.fn() }
    makePlugin(win).load(makeClient({ _config: { autoDetectErrors: false, enabledErrorTypes: { unhandledRejections: true } } }))
    expect(win.addEventListener).not.toHaveBeenCalled()
  })
})

describe('plugin-console-breadcrumbs', () => {
  const plugin = require('@bugsnag/plugin-console-breadcrumbs')

  const realConsole = { log: console.log, debug: console.debug, info: console.info, warn: console.warn, error: console.error }
  afterEach(() => Object.assign(console, realConsole))

  it('leaves log breadcrumbs and restores console on destroy', () => {
    const leaveBreadcrumb = jest.fn()
    const client = { _config: { releaseStage: 'production' }, _isBreadcrumbTypeEnabled: () => true, leaveBreadcrumb }
    plugin.load(client)
    console.log('hello', { a: 1 })
    expect(leaveBreadcrumb).toHaveBeenCalledWith('Console output', { '[0]': 'hello', '[1]': '{"a":1}', severity: 'log' }, 'log')
    plugin.destroy()
    expect(console.log).toBe(realConsole.log)
  })

  it('stringifies null-prototype objects safely', () => {
    const leaveBreadcrumb = jest.fn()
    const client = { _config: { releaseStage: 'production' }, _isBreadcrumbTypeEnabled: () => true, leaveBreadcrumb }
    plugin.load(client)
    console.log(Object.create(null))
    expect(leaveBreadcrumb.mock.calls[0][1]['[0]']).toBe('[Unknown value]')
    plugin.destroy()
  })

  it('does not wrap console in development or when log breadcrumbs are disabled', () => {
    const dev = { _config: { releaseStage: 'development' }, _isBreadcrumbTypeEnabled: () => true, leaveBreadcrumb: jest.fn() }
    plugin.load(dev)
    expect(console.log).toBe(realConsole.log)

    const noLog = { _config: { releaseStage: 'production' }, _isBreadcrumbTypeEnabled: () => false, leaveBreadcrumb: jest.fn() }
    plugin.load(noLog)
    expect(console.log).toBe(realConsole.log)
  })

  it('destroying twice is safe', () => {
    const leaveBreadcrumb = jest.fn()
    const client = { _config: { releaseStage: 'production' }, _isBreadcrumbTypeEnabled: () => true, leaveBreadcrumb }
    plugin.load(client)
    plugin.destroy()
    plugin.destroy()
    expect(console.log).toBe(realConsole.log)
  })

  it('does not define destroy in production builds', () => {
    const original = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      jest.resetModules()
      const prodPlugin = require('@bugsnag/plugin-console-breadcrumbs')
      expect(prodPlugin.destroy).toBeUndefined()
    } finally {
      process.env.NODE_ENV = original
    }
  })
})

describe('plugin-browser-request', () => {
  it('sets the request url only when not already present', () => {
    const callbacks: any[] = []
    const client: any = { addOnError: (fn: any) => callbacks.push(fn) }
    const win: any = { location: { href: 'http://example.com/page' } }
    require('@bugsnag/plugin-browser-request')(win).load(client)
    const event: any = {}
    callbacks.forEach(cb => cb(event))
    expect(event.request.url).toBe('http://example.com/page')

    const existing: any = { request: { url: 'http://other' } }
    callbacks.forEach(cb => cb(existing))
    expect(existing.request.url).toBe('http://other')
  })
})

describe('plugin-strip-query-string', () => {
  it('only strips strings', () => {
    const { _strip } = require('@bugsnag/plugin-strip-query-string')
    expect(_strip('http://x/y.js?a=1#b')).toBe('http://x/y.js')
    expect(_strip(123)).toBe(123)
    expect(_strip(undefined)).toBeUndefined()
  })

  it('strips query strings from every stack frame', () => {
    const callbacks: any[] = []
    const client: any = { addOnError: (fn: any) => callbacks.push(fn) }
    require('@bugsnag/plugin-strip-query-string').load(client)
    const event: any = { errors: [{ stacktrace: [{ file: 'http://x/a.js?v=1#h' }, { file: 'http://x/b.js' }] }] }
    callbacks.forEach(cb => cb(event))
    expect(event.errors[0].stacktrace[0].file).toBe('http://x/a.js')
    expect(event.errors[0].stacktrace[1].file).toBe('http://x/b.js')
  })
})
