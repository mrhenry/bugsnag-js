import type BugsnagBrowserStatic from '../src/notifier'

const DONE = window.XMLHttpRequest.DONE
const API_KEY = '030bab153e7c2349be364d23b5ae93b5'

interface Captured {
  url: string
  headers: Record<string, string>
  raw: string
  body: any
}

// console is mutated by the console-breadcrumbs plugin on every start(), so keep
// the real methods around and restore them after each test
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
  return require('../src/notifier') as typeof BugsnagBrowserStatic
}

function start (opts: any = {}): { Bugsnag: typeof BugsnagBrowserStatic, captured: Captured[] } {
  const captured = mockDelivery()
  const Bugsnag = getBugsnag()
  Bugsnag.start({ apiKey: API_KEY, sendPayloadChecksums: false, ...opts })
  return { Bugsnag, captured }
}

// a client created without touching the static singleton, as an embedding
// application would do
function createClient (opts: any = {}): { Bugsnag: typeof BugsnagBrowserStatic, client: any, captured: Captured[] } {
  const captured = mockDelivery()
  const Bugsnag = getBugsnag()
  const client = Bugsnag.createClient({ apiKey: API_KEY, sendPayloadChecksums: false, ...opts })
  return { Bugsnag, client, captured }
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
    // suppress default logging noise (re-applied each test because afterEach restores console)
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
      const { captured } = start()
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
      const { captured } = start()
      fireOnerror('boom', 'http://example.com/app.js', 1, 1, new Error('boom'))
      expect(previous).toHaveBeenCalled()
      expect(captured).toHaveLength(1)
    })

    it('ignores cross-domain "Script error." events', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { captured } = start()
      fireOnerror('Script error.', '', 0, 0, undefined)
      expect(captured).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith('[bugsnag]', expect.stringContaining('Ignoring cross-domain or eval script error'))
    })

    it('captures unhandled promise rejections', () => {
      const { captured } = start()
      fireRejection(new Error('rejected'))

      expect(captured).toHaveLength(1)
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

    it('does not auto-capture when autoDetectErrors is false', () => {
      const { captured } = start({ autoDetectErrors: false })
      expect(typeof (window as any).onerror).not.toBe('function')
      fireRejection(new Error('rejected'))
      expect(captured).toHaveLength(0)
    })

    it('honours enabledErrorTypes flags individually', () => {
      const { captured } = start({ enabledErrorTypes: { unhandledRejections: false } })
      fireRejection(new Error('rejected'))
      expect(captured).toHaveLength(0)

      fireOnerror('boom', 'http://example.com/app.js', 1, 1, new Error('boom'))
      expect(captured).toHaveLength(1)
    })
  })

  describe('bootstrap and event enrichment', () => {
    it('creates a client with createClient without starting the singleton', () => {
      const { Bugsnag, client, captured } = createClient()
      expect(Bugsnag.isStarted()).toBe(false)
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

    it('leaves events untouched when enrichment values are absent', () => {
      const { client, captured } = createClient({
        onError: (event: any) => {
          const app: string | undefined = undefined
          if (app) event.context = event.context + ' - ' + app
        }
      })
      client.notify(new Error('x'))
      expect(firstEvent(captured).context).toBe('/')
    })
  })

  describe('manual reporting', () => {
    it('reports handled errors with warning severity', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('manual'))
      const event = firstEvent(captured)
      expect(event.severity).toBe('warning')
      expect(event.unhandled).toBe(false)
      expect(event.severityReason).toStrictEqual({ type: 'handledException' })
      expect(event.exceptions[0].errorMessage).toBe('manual')
    })

    it('coerces non-error inputs', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify('a string problem' as any)
      expect(firstEvent(captured).exceptions[0].errorMessage).toBe('a string problem')
    })

    it('invokes the post-report callback with the event', (done) => {
      const { Bugsnag } = start()
      Bugsnag.notify(new Error('cb'), undefined, (err, event) => {
        expect(err).toBeNull()
        expect(event.originalError.message).toBe('cb')
        done()
      })
    })

    it('logs and returns when notify is called before start', () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => {})
      const Bugsnag = getBugsnag()
      const ret = Bugsnag.notify(new Error('early'))
      expect(ret).toBeUndefined()
      expect(log).toHaveBeenCalledWith('Bugsnag.notify() was called before Bugsnag.start()')
    })

    it('records userCallbackSetSeverity when an onError callback changes severity', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('sev'), (event) => {
        event.severity = 'info'
      })
      const event = firstEvent(captured)
      expect(event.severity).toBe('info')
      expect(event.severityReason).toStrictEqual({ type: 'userCallbackSetSeverity' })
    })

    it('does not invoke onSession callbacks (sessions unsupported)', () => {
      const onSession = jest.fn()
      const { Bugsnag } = start({ onSession })
      Bugsnag.notify(new Error('x'))
      expect(onSession).not.toHaveBeenCalled()
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

  describe('breadcrumbs', () => {
    it('starts with a "Bugsnag loaded" state breadcrumb', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).breadcrumbs[0]).toStrictEqual(expect.objectContaining({
        type: 'state',
        name: 'Bugsnag loaded'
      }))
    })

    it('adds manual breadcrumbs with a timestamp', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.leaveBreadcrumb('clicked thing', { id: 7 }, 'manual')
      Bugsnag.notify(new Error('x'))
      const crumb = firstEvent(captured).breadcrumbs[1]
      expect(crumb).toStrictEqual(expect.objectContaining({
        type: 'manual',
        name: 'clicked thing',
        metaData: { id: 7 }
      }))
      expect(typeof crumb.timestamp).toBe('string')
    })

    it('caps breadcrumbs at maxBreadcrumbs', () => {
      const { Bugsnag, captured } = start({ maxBreadcrumbs: 2 })
      Bugsnag.leaveBreadcrumb('a')
      Bugsnag.leaveBreadcrumb('b')
      Bugsnag.leaveBreadcrumb('c')
      Bugsnag.notify(new Error('x'))
      const names = firstEvent(captured).breadcrumbs.map((b: any) => b.name)
      expect(names).toStrictEqual(['b', 'c'])
    })

    it('captures console output as log breadcrumbs', () => {
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

    it('does not capture console output in development', () => {
      const { Bugsnag, captured } = start({ releaseStage: 'development' })
      console.log('hello')
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).breadcrumbs.filter((b: any) => b.type === 'log')).toHaveLength(0)
    })

    it('respects enabledBreadcrumbTypes', () => {
      const { Bugsnag, captured } = start({ releaseStage: 'production', enabledBreadcrumbTypes: ['manual'] })
      console.log('hello')
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).breadcrumbs.filter((b: any) => b.type === 'log')).toHaveLength(0)
    })
  })

  describe('page, context and request', () => {
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

    it('documents that query strings are kept on request.url', () => {
      const { Bugsnag, captured } = start()
      window.history.pushState({}, '', '/page?token=secret#frag')
      Bugsnag.notify(new Error('x'))
      const event = firstEvent(captured)
      expect(event.context).toBe('/page')
      expect(event.request.url).toContain('?token=secret')
    })

    it('strips query strings and fragments from stack frame file paths', () => {
      const { _strip } = require('@bugsnag/plugin-strip-query-string')
      expect(_strip('http://example.com/app.js?v=1#hash')).toBe('http://example.com/app.js')
    })
  })

  describe('timing', () => {
    it('stamps the event with the time it was sent', () => {
      const before = Date.now()
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      const after = Date.now()
      const time = Date.parse(firstEvent(captured).device.time)
      expect(time).toBeGreaterThanOrEqual(before)
      expect(time).toBeLessThanOrEqual(after)
    })
  })

  describe('device, window and browser', () => {
    it('reports user agent and locale', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      const device = firstEvent(captured).device
      expect(device.userAgent).toBe(window.navigator.userAgent)
      expect(device.locale).toBe(window.navigator.language)
    })

    it('reports orientation', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      expect(['portrait', 'landscape']).toContain(firstEvent(captured).device.orientation)
    })

    it('reports the window size', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      const device = firstEvent(captured).device
      expect(device.windowWidth).toBe(window.innerWidth)
      expect(device.windowHeight).toBe(window.innerHeight)
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
      const { client, captured } = createClient({ generateAnonymousId: true, collectUserIp: false })
      client.notify(new Error('x'))
      const event = firstEvent(captured)
      expect(event.device.id).toBeUndefined()
      expect(event.user.id).toBeUndefined()
      expect(window.localStorage.getItem('bugsnag-anonymous-id')).toBeNull()
    })
  })

  describe('throttling', () => {
    it('stops sending after maxEvents and can be reset', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { Bugsnag, captured } = start({ maxEvents: 2 })
      Bugsnag.notify(new Error('1'))
      Bugsnag.notify(new Error('2'))
      Bugsnag.notify(new Error('3'))
      expect(captured).toHaveLength(2)
      expect(warn).toHaveBeenCalledWith('[bugsnag]', expect.stringContaining('maxEvents per session limit'))

      Bugsnag.resetEventCount()
      Bugsnag.notify(new Error('4'))
      expect(captured).toHaveLength(3)
    })
  })

  describe('delivery and payload', () => {
    it('sends a version 4 payload to the default endpoint', () => {
      const { Bugsnag, captured } = start({ appVersion: '1.2.3' })
      Bugsnag.notify(new Error('x'))
      const req = captured[0]
      expect(req.url).toBe('https://notify.bugsnag.com')
      expect(req.headers['Bugsnag-Payload-Version']).toBe('4')
      expect(req.headers['Bugsnag-Api-Key']).toBe(API_KEY)
      expect(req.body.notifier.name).toBe('Bugsnag JavaScript')
      expect(req.body.events[0].payloadVersion).toBe('4')
      expect(req.body.events[0].app).toStrictEqual({ releaseStage: 'development', version: '1.2.3', type: 'browser' })
    })

    it('redacts redactedKeys in metadata', () => {
      const { Bugsnag, captured } = start({ metadata: { auth: { password: 'secret', user: 'bob' } } })
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).metaData.auth).toStrictEqual({ password: '[REDACTED]', user: 'bob' })
    })

    it('does not send when the releaseStage is not enabled', () => {
      const { Bugsnag, captured } = start({ releaseStage: 'production', enabledReleaseStages: ['staging'] })
      Bugsnag.notify(new Error('x'))
      expect(captured).toHaveLength(0)
    })

    it('sends in each enabled release stage and skips disabled ones', () => {
      for (const stage of ['production', 'staging']) {
        const { client, captured } = createClient({ releaseStage: stage, enabledReleaseStages: ['production', 'staging'] })
        client.notify(new Error('x'))
        expect(captured).toHaveLength(1)
      }
      const { client, captured } = createClient({ releaseStage: 'development', enabledReleaseStages: ['production', 'staging'] })
      client.notify(new Error('x'))
      expect(captured).toHaveLength(0)
    })

    it('uses the secondary endpoint for API keys starting with 00000', () => {
      const captured = mockDelivery()
      const Bugsnag = getBugsnag()
      Bugsnag.start({ apiKey: '00000abc000000000000000000000000', sendPayloadChecksums: false })
      Bugsnag.notify(new Error('x'))
      expect(captured[0].url).toBe('https://notify.bugsnag.smartbear.com')
    })

    it('reports an error when endpoint configuration is incomplete', () => {
      const { Bugsnag } = start({ endpoints: { notify: 'https://notify.custom.com' } })
      Bugsnag.notify(new Error('x'), undefined, (err) => {
        expect(err).toStrictEqual(new Error('Event not sent due to incomplete endpoint configuration'))
      })
    })
  })

  describe('configuration', () => {
    it('warns when start() is called more than once', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const Bugsnag = getBugsnag()
      Bugsnag.start(API_KEY)
      Bugsnag.start(API_KEY)
      expect(warn).toHaveBeenCalledWith('[bugsnag]', expect.stringContaining('called more than once'))
    })

    it('defaults releaseStage to development on localhost', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).app.releaseStage).toBe('development')
    })

    it('throws when no api key is supplied', () => {
      const Bugsnag = getBugsnag()
      expect(() => Bugsnag.createClient()).toThrow('No Bugsnag API Key set')
    })

    it('treats a string argument as the api key', () => {
      const Bugsnag = getBugsnag()
      const client = Bugsnag.createClient(API_KEY)
      expect(client._config.apiKey).toBe(API_KEY)
    })

    it('falls back to no logger when console.debug is unavailable', () => {
      const original = console.debug
      try {
        ;(console as any).debug = undefined
        jest.isolateModules(() => {
          const config = require('../src/config')
          expect(config.logger.defaultValue()).toBeUndefined()
        })
      } finally {
        ;(console as any).debug = original
      }
    })

    it('falls back to console.log for missing console methods', () => {
      const originalInfo = console.info
      try {
        ;(console as any).info = undefined
        jest.isolateModules(() => {
          const config = require('../src/config')
          const logger = config.logger.defaultValue()
          expect(typeof logger.info).toBe('function')
          expect(typeof logger.debug).toBe('function')
        })
      } finally {
        ;(console as any).info = originalInfo
      }
    })

    it('defaults releaseStage to production for non-localhost hosts', () => {
      const original = window.location
      try {
        Object.defineProperty(window, 'location', { value: { host: 'example.com' }, configurable: true })
        jest.isolateModules(() => {
          const config = require('../src/config')
          expect(config.releaseStage.defaultValue()).toBe('production')
        })
      } finally {
        Object.defineProperty(window, 'location', { value: original, configurable: true })
      }
    })
  })
})
