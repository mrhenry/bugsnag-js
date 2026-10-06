import type BugsnagBrowserStatic from '../src/bugsnag'

const DONE = window.XMLHttpRequest.DONE
const API_KEY = '030bab153e7c2349be364d23b5ae93b5'

interface Captured {
  url: string
  headers: Record<string, string>
  raw: string
  body: any
}

const realConsole = {
  log: console.log,
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error
}

function mockDelivery (): Captured[] {
  const captured: Captured[] = []
  // @ts-ignore
  window.XMLHttpRequest = jest.fn().mockImplementation(() => {
    const xhr: any = {
      readyState: DONE,
      status: 200,
      _url: '',
      _headers: {},
      onreadystatechange: () => {},
      open: jest.fn((method: string, url: string) => { xhr._url = url }),
      setRequestHeader: jest.fn((key: string, value: string) => { xhr._headers[key] = value }),
      send: jest.fn((raw: string) => {
        captured.push({ url: xhr._url, headers: xhr._headers, raw, body: JSON.parse(raw) })
        xhr.onreadystatechange()
      })
    }
    return xhr
  })
  // @ts-ignore
  window.XMLHttpRequest.DONE = DONE
  return captured
}

function getBugsnag (): typeof BugsnagBrowserStatic {
  return require('../src/bugsnag') as typeof BugsnagBrowserStatic
}

function createClient (opts: any = {}): { client: any, captured: Captured[] } {
  const captured = mockDelivery()
  const Bugsnag = getBugsnag()
  const client = Bugsnag.createClient({ apiKey: API_KEY, ...opts })
  return { client, captured }
}

function firstEvent (captured: Captured[]): any {
  return captured[captured.length - 1].body.events[0]
}

function fireOnerror (message: string, url?: string, line?: number, col?: number, error?: any) {
  ;(window as any).onerror(message, url, line, col, error)
}

function fireRejection (reason: any) {
  const evt: any = new window.Event('unhandledrejection')
  evt.reason = reason
  window.dispatchEvent(evt)
}

describe('browser-lite behaviour', () => {
  let rejectionListeners: any[] = []
  let originalAddEventListener: any

  beforeEach(() => {
    jest.resetModules()
    jest.spyOn(console, 'debug').mockImplementation(() => {})
    jest.spyOn(console, 'info').mockImplementation(() => {})
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
    delete (window as any).bugsnagClient
    Object.assign(console, realConsole)
    window.history.replaceState({}, '', '/')
  })

  describe('automatic error capture', () => {
    it('captures uncaught exceptions via window.onerror', () => {
      const { captured } = createClient()
      fireOnerror('boom', 'http://example.com/app.js', 12, 34, new Error('boom'))

      expect(captured).toHaveLength(1)
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

    it('ignores cross-domain "Script error." events', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { captured } = createClient()
      fireOnerror('Script error.', '', 0, 0, undefined)
      expect(captured).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith('[bugsnag]', expect.stringContaining('Ignoring cross-domain or eval script error'))
    })

    it('captures unhandled promise rejections', () => {
      const { captured } = createClient()
      fireRejection(new Error('rejected'))

      expect(captured).toHaveLength(1)
      const event = firstEvent(captured)
      expect(event.severity).toBe('error')
      expect(event.unhandled).toBe(true)
      expect(event.severityReason).toStrictEqual({ type: 'unhandledPromiseRejection' })
      expect(event.exceptions[0].errorMessage).toBe('rejected')
    })
  })

  describe('bootstrap and event enrichment', () => {
    it('creates a client and reports through it', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      expect(captured).toHaveLength(1)
    })

    it('can be exposed as a window global and used to report', () => {
      const { client, captured } = createClient()
      ;(window as any).bugsnagClient = client
      ;(window as any).bugsnagClient.notify(new Error('x'))
      expect(captured).toHaveLength(1)
    })

    it('enriches events in an onError callback', () => {
      const { client, captured } = createClient({
        appType: 'example-app',
        releaseStage: 'production',
        enabledReleaseStages: ['production', 'staging'],
        onError: (event: any) => {
          event.context = event.context + ' - example-app'
          event.addMetadata('site', { id: 'site-1', app: 'example-app' })
          event.addMetadata('bundle', { target: 'modern' })
        }
      })
      client.notify(new Error('[checkout] API Error: 500'))
      const event = firstEvent(captured)
      expect(event.app.type).toBe('example-app')
      expect(event.context).toBe('/ - example-app')
      expect(event.metaData.site).toStrictEqual({ id: 'site-1', app: 'example-app' })
      expect(event.metaData.bundle).toStrictEqual({ target: 'modern' })
    })
  })

  describe('manual reporting', () => {
    it('reports handled errors with warning severity', () => {
      const { client, captured } = createClient()
      client.notify(new Error('manual'))
      const event = firstEvent(captured)
      expect(event.severity).toBe('warning')
      expect(event.unhandled).toBe(false)
      expect(event.severityReason).toStrictEqual({ type: 'handledException' })
      expect(event.exceptions[0].errorMessage).toBe('manual')
    })

    it('coerces non-error inputs', () => {
      const { client, captured } = createClient()
      client.notify('a string problem' as any)
      expect(firstEvent(captured).exceptions[0].errorMessage).toBe('a string problem')
    })
  })

  describe('metadata', () => {
    it('attaches client metadata to subsequent reports', () => {
      const { client, captured } = createClient()
      client.addMetadata('checkout', { cartId: 'c-1' })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.checkout).toStrictEqual({ cartId: 'c-1' })
    })
  })

  describe('page, context and request', () => {
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

    it('documents that query strings are kept on request.url', () => {
      window.history.pushState({}, '', '/page?token=secret#frag')
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      const event = firstEvent(captured)
      expect(event.context).toBe('/page')
      expect(event.request.url).toContain('?token=secret')
    })

    it('strips query strings and fragments from stack frame file paths', () => {
      const { client, captured } = createClient({
        onError: (event: any) => {
          event.errors[0].stacktrace = [{ file: 'http://example.com/app.js?v=1#hash' }]
        }
      })
      client.notify(new Error('x'))
      expect(firstEvent(captured).exceptions[0].stacktrace[0].file).toBe('http://example.com/app.js')
    })
  })

  describe('timing', () => {
    it('stamps the event with the time it was sent', () => {
      const before = Date.now()
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      const after = Date.now()
      const time = Date.parse(firstEvent(captured).device.time)
      expect(time).toBeGreaterThanOrEqual(before)
      expect(time).toBeLessThanOrEqual(after)
    })
  })

  describe('device, window and browser', () => {
    it('reports user agent and locale', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      const device = firstEvent(captured).device
      expect(device.userAgent).toBe(window.navigator.userAgent)
      expect(device.locale).toBe(window.navigator.language)
    })

    it('reports orientation', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      expect(['portrait', 'landscape']).toContain(firstEvent(captured).device.orientation)
    })

    it('reports the window size', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      const device = firstEvent(captured).device
      expect(device.windowWidth).toBe(window.innerWidth)
      expect(device.windowHeight).toBe(window.innerHeight)
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

  describe('throttling', () => {
    it('stops sending after maxEvents', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { client, captured } = createClient()
      for (let i = 0; i < 11; i++) client.notify(new Error(String(i)))
      expect(captured).toHaveLength(10)
      expect(warn).toHaveBeenCalledWith('[bugsnag]', expect.stringContaining('maxEvents limit'))
    })
  })

  describe('delivery and payload', () => {
    it('sends a version 4 payload to the default endpoint', () => {
      const { client, captured } = createClient({ appType: 'example-app' })
      client.notify(new Error('x'))
      const req = captured[0]
      expect(req.url).toBe('https://notify.bugsnag.com')
      expect(req.headers['Bugsnag-Payload-Version']).toBe('4')
      expect(req.headers['Bugsnag-Api-Key']).toBe(API_KEY)
      expect(req.body.notifier.name).toBe('Bugsnag JavaScript')
      expect(req.body.events[0].payloadVersion).toBe('4')
      expect(req.body.events[0].app).toStrictEqual({ releaseStage: 'development', type: 'example-app' })
    })

    it('redacts the default password key in metadata', () => {
      const { client, captured } = createClient()
      client.addMetadata('auth', { password: 'secret', user: 'bob' })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.auth).toStrictEqual({ password: '[REDACTED]', user: 'bob' })
    })

    it('does not send when the releaseStage is not enabled', () => {
      const { client, captured } = createClient({ releaseStage: 'production', enabledReleaseStages: ['staging'] })
      client.notify(new Error('x'))
      expect(captured).toHaveLength(0)
    })
  })

  describe('configuration', () => {
    it('defaults releaseStage to development on localhost', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      expect(firstEvent(captured).app.releaseStage).toBe('development')
    })

    it('throws when no api key is supplied', () => {
      const Bugsnag = getBugsnag()
      expect(() => Bugsnag.createClient()).toThrow('No Bugsnag API Key set')
    })

    it('treats a string argument as the api key', () => {
      const captured = mockDelivery()
      const Bugsnag = getBugsnag()
      const client = Bugsnag.createClient(API_KEY)
      client.notify(new Error('x'))
      expect(captured[0].body.apiKey).toBe(API_KEY)
    })

    it('falls back to production for non-localhost hosts', () => {
      const original = window.location
      try {
        Object.defineProperty(window, 'location', {
          value: { host: 'example.com', pathname: '/', href: 'http://example.com/' },
          configurable: true
        })
        const { client, captured } = createClient()
        client.notify(new Error('x'))
        expect(firstEvent(captured).app.releaseStage).toBe('production')
      } finally {
        Object.defineProperty(window, 'location', { value: original, configurable: true })
      }
    })
  })
})
