import { API_KEY, createClient, firstEvent, getBugsnag, mockDelivery } from './helpers'

const realConsole = {
  log: console.log,
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error
}

describe('client public API', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.spyOn(console, 'debug').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.assign(console, realConsole)
    ;(window as any).onerror = null
  })

  describe('metadata', () => {
    it('adds, gets and clears metadata', () => {
      const { client } = createClient()
      client.addMetadata('account', { id: 1 })
      client.addMetadata('account', 'name', 'a')
      expect(client.getMetadata('account')).toStrictEqual({ id: 1, name: 'a' })
      expect(client.getMetadata('account', 'id')).toBe(1)
      client.clearMetadata('account', 'id')
      expect(client.getMetadata('account')).toStrictEqual({ name: 'a' })
      client.clearMetadata('account')
      expect(client.getMetadata('account')).toBeUndefined()
      expect(client.getMetadata('missing', 'key')).toBeUndefined()
    })

    it('attaches client metadata to reports', () => {
      const { client, captured } = createClient()
      client.addMetadata('checkout', { cartId: 'c-1' })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.checkout).toStrictEqual({ cartId: 'c-1' })
    })

    it('refuses prototype-polluting section names', () => {
      const { client } = createClient()
      client.addMetadata('__proto__', { polluted: true })
      client.addMetadata('constructor', { polluted: true })
      client.addMetadata('prototype', { polluted: true })
      expect(({} as any).polluted).toBeUndefined()
      expect(client.getMetadata('missing')).toBeUndefined()
    })
  })

  describe('context', () => {
    it('gets and sets context', () => {
      const { client } = createClient()
      expect(client.getContext()).toBeUndefined()
      client.setContext('ctx')
      expect(client.getContext()).toBe('ctx')
    })
  })

  describe('callbacks', () => {
    it('adds and removes error callbacks', () => {
      const { client } = createClient()
      const cb = jest.fn()
      client.addOnError(cb)
      client.removeOnError(cb)
      client.notify(new Error('x'))
      expect(cb).not.toHaveBeenCalled()
    })
  })

  describe('configuration', () => {
    it('warns about invalid options and falls back to defaults', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { client, captured } = createClient({ maxEvents: 101, appVersion: 123 } as any)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toBe('[bugsnag]')
      expect(warn.mock.calls[0][1].message).toContain('Invalid configuration')
      client.notify(new Error('x'))
      expect(firstEvent(captured).app.version).toBeUndefined()
    })

    it('stringifies unusual config values in the warning', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      createClient({ appVersion: function () {} } as any)
      expect(warn).toHaveBeenCalledTimes(1)
      const message = warn.mock.calls[0][1].message
      expect(message).toContain('appVersion')
      expect(message).toContain('got function')
    })

    it('exposes the public static surface and hides the session API', () => {
      const Bugsnag = getBugsnag()
      expect(typeof Bugsnag.start).toBe('function')
      expect(typeof Bugsnag.createClient).toBe('function')
      expect(typeof Bugsnag.isStarted).toBe('function')
      expect(Bugsnag.default).toBe(Bugsnag)
      expect(Bugsnag.startSession).toBeUndefined()
      expect(Bugsnag.pauseSession).toBeUndefined()
      expect(Bugsnag.resumeSession).toBeUndefined()
    })

    it('only ever reports to the configured notify endpoint', () => {
      const captured = mockDelivery()
      const Bugsnag = getBugsnag()
      Bugsnag.start({ apiKey: API_KEY })
      Bugsnag.notify(new Error('x'))
      expect(captured).toHaveLength(1)
      expect(captured[0].url).toBe('https://notify.bugsnag.com')
    })
  })
})
