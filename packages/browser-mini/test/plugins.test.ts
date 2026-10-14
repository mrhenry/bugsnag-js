import { createClient, fireOnerror, firstEvent } from './helpers'

const realConsole = {
  log: console.log,
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error
}

function fireRejection (reason: any) {
  const evt: any = new window.Event('unhandledrejection')
  evt.reason = reason
  window.dispatchEvent(evt)
}

describe('automatic capture public API', () => {
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
      const { captured } = createClient()
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
      const { captured } = createClient()
      fireOnerror('boom', 'http://example.com/app.js', 1, 1, new Error('boom'))
      expect(previous).toHaveBeenCalled()
      expect(captured).toHaveLength(1)
    })

    it('tolerates a previous handler that throws', () => {
      ;(window as any).onerror = () => { throw new Error('prev') }
      createClient()
      expect(() => fireOnerror('boom', 'http://x/a.js', 1, 1, new Error('boom'))).not.toThrow()
    })

    it('ignores cross-domain "Script error." events', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { captured } = createClient()
      fireOnerror('Script error.', '', 0, 0, undefined)
      expect(captured).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith('[bugsnag]', expect.stringContaining('Ignoring cross-domain or eval script error'))
    })

    it('captures legacy events with no error object', () => {
      const { captured } = createClient()
      fireOnerror('legacy msg', 'http://x/a.js', 3, 4)
      expect(firstEvent(captured).exceptions[0].errorMessage).toBe('legacy msg')
    })

    it('decorates a frame column from the charNo argument', () => {
      const { captured } = createClient()
      const err: any = new Error('boom')
      err.stack = 'Error: boom\n    at foo (http://x/a.js:3:0)'
      fireOnerror('boom', 'http://x/a.js', 3, 5, err)
      expect(firstEvent(captured).exceptions[0].stacktrace[0].columnNumber).toBe(5)
    })
  })

  describe('unhandledrejection', () => {
    it('captures unhandled promise rejections', () => {
      const { captured } = createClient()
      fireRejection(new Error('rejected'))
      const event = firstEvent(captured)
      expect(event.severity).toBe('error')
      expect(event.unhandled).toBe(true)
      expect(event.severityReason).toStrictEqual({ type: 'unhandledPromiseRejection' })
      expect(event.exceptions[0].errorMessage).toBe('rejected')
    })

    it('adds metadata for a non-error reason without a stack', () => {
      const { captured } = createClient()
      const err: any = new Error('no stack')
      delete err.stack
      fireRejection(err)
      expect(firstEvent(captured).metaData['unhandledRejection handler']).toBeDefined()
    })

    it('coerces a non-error rejection reason to an error', () => {
      const { captured } = createClient()
      fireRejection('a string reason')
      const exception = firstEvent(captured).exceptions[0]
      expect(exception.errorClass).toBe('Error')
      expect(exception.errorMessage).toBe('a string reason')
    })
  })

  describe('context and request', () => {
    it('sets context to the current pathname', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      expect(firstEvent(captured).context).toBe(window.location.pathname)
    })

    it('sets request.url to the current href', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      expect(firstEvent(captured).request.url).toBe(window.location.href)
    })

    it('keeps query strings on request.url', () => {
      window.history.pushState({}, '', '/page?token=secret#frag')
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      const event = firstEvent(captured)
      expect(event.context).toBe('/page')
      expect(event.request.url).toContain('?token=secret')
    })
  })

  describe('device', () => {
    it('reports user agent, locale, orientation and window size', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
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
        const { client, captured } = createClient()
        client.notify(new Error('x'))
        expect(firstEvent(captured).device.orientation).toBe('landscape-primary')
      } finally {
        delete (window.screen as any).orientation
      }
    })

    it('does not generate or persist an anonymous id', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      const event = firstEvent(captured)
      expect(event.device.id).toBeUndefined()
      expect(event.user).toBeUndefined()
      expect(window.localStorage.getItem('bugsnag-anonymous-id')).toBeNull()
    })
  })
})
