import { createClient, fireOnerror, firstEvent, start } from './helpers'

const realConsole = {
  log: console.log,
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error
}

function fireRejection (reason: any, detail?: any) {
  const evt: any = new window.Event('unhandledrejection')
  evt.reason = reason
  if (detail !== undefined) evt.detail = detail
  window.dispatchEvent(evt)
}

describe('plugins public API', () => {
  let rejectionListeners: any[] = []
  let originalAddEventListener: any

  beforeEach(() => {
    jest.resetModules()
    jest.spyOn(console, 'debug').mockImplementation(() => {})
    jest.spyOn(console, 'info').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    rejectionListeners = []
    originalAddEventListener = window.addEventListener
    window.addEventListener = ((type: string, fn: any, opts?: any) => {
      if (type === 'unhandledrejection') rejectionListeners.push(fn)
      return originalAddEventListener.call(window, type, fn, opts)
    }) as any
  })

  afterEach(() => {
    rejectionListeners.forEach(fn => window.removeEventListener('unhandledrejection', fn))
    window.addEventListener = originalAddEventListener
    ;(window as any).onerror = null
    Object.assign(console, realConsole)
  })

  describe('window.onerror', () => {
    it('captures a modern uncaught exception', () => {
      const { captured } = start()
      fireOnerror('boom', 'http://example.com/app.js', 12, 34, new Error('boom'))
      const event = firstEvent(captured)
      expect(event.severity).toBe('error')
      expect(event.unhandled).toBe(true)
      expect(event.severityReason).toStrictEqual({ type: 'unhandledException' })
      expect(event.exceptions[0].errorClass).toBe('Error')
      expect(event.exceptions[0].errorMessage).toBe('boom')
    })

    it('chains a previously installed window.onerror handler', () => {
      const previous = jest.fn()
      ;(window as any).onerror = previous
      const { captured } = start()
      fireOnerror('boom', 'http://example.com/app.js', 1, 1, new Error('boom'))
      expect(previous).toHaveBeenCalled()
      expect(captured).toHaveLength(1)
    })

    it('tolerates a previous handler that throws', () => {
      ;(window as any).onerror = () => { throw new Error('prev') }
      start()
      expect(() => fireOnerror('boom', 'http://x/a.js', 1, 1, new Error('boom'))).not.toThrow()
    })

    it('ignores cross-domain "Script error." events', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { captured } = start()
      fireOnerror('Script error.', '', 0, 0, undefined)
      expect(captured).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith('[bugsnag]', expect.stringContaining('Ignoring cross-domain or eval script error'))
    })

    it('captures legacy events with no error object', () => {
      const { captured } = start()
      fireOnerror('legacy msg', 'http://x/a.js', 3, 4)
      expect(firstEvent(captured).exceptions[0].errorMessage).toBe('legacy msg')
    })

    it('captures jQuery-style synthetic events and their metadata', () => {
      const { captured } = start()
      ;(window as any).onerror({ type: 'click', message: 'clicked' }, { extra: 1 })
      const event = firstEvent(captured)
      expect(event.exceptions[0].errorClass).toBe('Event: click')
      expect(event.metaData['window onerror']).toBeDefined()
    })

    it('uses a synthetic event detail as the message when there is no message', () => {
      const { captured } = start()
      ;(window as any).onerror({ detail: 'detailed' }, { extra: 1 })
      expect(firstEvent(captured).exceptions[0].errorMessage).toBe('detailed')
    })

    it('decorates a frame column from the charNo argument', () => {
      const { captured } = start()
      const err: any = new Error('boom')
      err.stack = 'Error: boom\n    at foo (http://x/a.js:3:0)'
      fireOnerror('boom', 'http://x/a.js', 3, 5, err)
      expect(firstEvent(captured).exceptions[0].stacktrace[0].columnNumber).toBe(5)
    })

    it('decorates a frame using window.event.errorCharacter', () => {
      const { captured } = start()
      const err: any = new Error('boom')
      err.stack = 'Error: boom\n    at foo (http://x/a.js:3:0)'
      ;(window as any).event = { errorCharacter: 7 }
      try {
        fireOnerror('boom', 'http://x/a.js', 3, undefined, err)
      } finally {
        delete (window as any).event
      }
      expect(firstEvent(captured).exceptions[0].stacktrace[0].columnNumber).toBe(7)
    })

    it('does nothing when autoDetectErrors is false', () => {
      const { captured } = start({ autoDetectErrors: false })
      expect(typeof (window as any).onerror).not.toBe('function')
      fireRejection(new Error('rejected'))
      expect(captured).toHaveLength(0)
    })

    it('honours enabledErrorTypes.unhandledExceptions', () => {
      const { captured } = start({ enabledErrorTypes: { unhandledExceptions: false } })
      expect(typeof (window as any).onerror).not.toBe('function')
      fireRejection(new Error('rejected'))
      expect(captured).toHaveLength(1)
    })
  })

  describe('unhandledrejection', () => {
    it('captures unhandled promise rejections', () => {
      const { captured } = start()
      fireRejection(new Error('rejected'))
      const event = firstEvent(captured)
      expect(event.severity).toBe('error')
      expect(event.unhandled).toBe(true)
      expect(event.severityReason).toStrictEqual({ type: 'unhandledPromiseRejection' })
      expect(event.exceptions[0].errorMessage).toBe('rejected')
    })

    it('reports unhandled rejections as handled when configured', () => {
      const { captured } = start({ reportUnhandledPromiseRejectionsAsHandled: true })
      fireRejection(new Error('rejected'))
      expect(firstEvent(captured).unhandled).toBe(false)
    })

    it('handles Bluebird-style rejection details', () => {
      const { captured } = start()
      fireRejection(undefined, { reason: new Error('bluebird') })
      expect(firstEvent(captured).exceptions[0].errorMessage).toBe('bluebird')
    })

    it('adds metadata for a non-error reason without a stack', () => {
      const { captured } = start()
      const err: any = new Error('no stack')
      delete err.stack
      fireRejection(err)
      expect(firstEvent(captured).metaData['unhandledRejection handler']).toBeDefined()
    })

    it('reports a non-error rejection reason as an invalid error', () => {
      const { captured } = start()
      fireRejection('a string reason')
      expect(firstEvent(captured).exceptions[0].errorClass).toBe('InvalidError')
    })

    it('does nothing when enabledErrorTypes.unhandledRejections is false', () => {
      const { captured } = start({ enabledErrorTypes: { unhandledRejections: false } })
      fireRejection(new Error('rejected'))
      expect(captured).toHaveLength(0)
    })
  })

  describe('console breadcrumbs', () => {
    it('captures console output as log breadcrumbs in production', () => {
      const { Bugsnag, captured } = start({ releaseStage: 'production' })
      console.log('hello', 'world')
      console.warn({ a: 1 })
      Bugsnag.notify(new Error('x'))
      const crumbs = firstEvent(captured).breadcrumbs.filter((b: any) => b.type === 'log')
      expect(crumbs).toHaveLength(2)
      expect(crumbs[0].name).toBe('Console output')
      expect(crumbs[0].metaData).toStrictEqual({ '[0]': 'hello', '[1]': 'world', severity: 'log' })
      expect(crumbs[1].metaData).toStrictEqual({ '[0]': '{"a":1}', severity: 'warn' })
    })

    it('stringifies null-prototype objects safely', () => {
      const { Bugsnag, captured } = start({ releaseStage: 'production' })
      console.log(Object.create(null))
      Bugsnag.notify(new Error('x'))
      const crumb = firstEvent(captured).breadcrumbs.filter((b: any) => b.type === 'log')[0]
      expect(crumb.metaData['[0]']).toBe('[Unknown value]')
    })

    it('does not capture console output in development', () => {
      const { Bugsnag, captured } = start({ releaseStage: 'development' })
      console.log('hello')
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).breadcrumbs.filter((b: any) => b.type === 'log')).toHaveLength(0)
    })

    it('does not capture console output when log breadcrumbs are disabled', () => {
      const { Bugsnag, captured } = start({ releaseStage: 'production', enabledBreadcrumbTypes: ['manual'] })
      console.log('hello')
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).breadcrumbs.filter((b: any) => b.type === 'log')).toHaveLength(0)
    })

    it('does not wrap console.group', () => {
      const realGroup = (console as any).group
      const group = jest.fn()
      ;(console as any).group = group
      try {
        const { Bugsnag, captured } = start({ releaseStage: 'production' })
        ;(console as any).group('hello', 'world')
        Bugsnag.notify(new Error('x'))
        expect(group).toHaveBeenCalledWith('hello', 'world')
        expect(firstEvent(captured).breadcrumbs.filter((b: any) => b.type === 'log')).toHaveLength(0)
      } finally {
        if (realGroup === undefined) delete (console as any).group
        else (console as any).group = realGroup
      }
    })
  })

  describe('context and request', () => {
    it('sets context to the current pathname', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).context).toBe(window.location.pathname)
    })

    it('sets request.url to the current href', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).request.url).toBe(window.location.href)
    })

    it('allows context to be overridden', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.setContext('custom-context')
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).context).toBe('custom-context')
    })

    it('keeps query strings on request.url', () => {
      window.history.pushState({}, '', '/page?token=secret#frag')
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      const event = firstEvent(captured)
      expect(event.context).toBe('/page')
      expect(event.request.url).toContain('?token=secret')
    })
  })

  describe('device', () => {
    it('reports user agent, locale, orientation and window size', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      const device = firstEvent(captured).device
      expect(device.userAgent).toBe(window.navigator.userAgent)
      expect(device.locale).toBe(window.navigator.language)
      expect(['portrait', 'landscape']).toContain(device.orientation)
      expect(device.windowWidth).toBe(window.innerWidth)
      expect(device.windowHeight).toBe(window.innerHeight)
      expect(device.time).toBeDefined()
    })

    it('prefers screen.orientation when available', () => {
      Object.defineProperty(window.screen, 'orientation', { value: { type: 'landscape-primary' }, configurable: true })
      try {
        const { Bugsnag, captured } = start()
        Bugsnag.notify(new Error('x'))
        expect(firstEvent(captured).device.orientation).toBe('landscape-primary')
      } finally {
        delete (window.screen as any).orientation
      }
    })

    it('falls back through the legacy navigator language properties', () => {
      const nav = window.navigator as any
      Object.defineProperty(nav, 'browserLanguage', { value: 'en-GB', configurable: true })
      try {
        const { Bugsnag, captured } = start()
        Bugsnag.notify(new Error('x'))
        expect(firstEvent(captured).device.locale).toBe('en-GB')
      } finally {
        delete nav.browserLanguage
      }
    })

    it('does not generate or persist an anonymous id, and does not set a user id', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      const event = firstEvent(captured)
      expect(event.device.id).toBeUndefined()
      expect(event.user.id).toBeUndefined()
      expect(window.localStorage.getItem('bugsnag-anonymous-id')).toBeNull()
    })

    it('accepts and ignores legacy privacy options', () => {
      const { client, captured } = createClient({ generateAnonymousId: true, collectUserIp: false } as any)
      client.notify(new Error('x'))
      const event = firstEvent(captured)
      expect(event.device.id).toBeUndefined()
      expect(event.user.id).toBeUndefined()
      expect(window.localStorage.getItem('bugsnag-anonymous-id')).toBeNull()
    })
  })
})
