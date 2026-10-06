import { API_KEY, createClient, firstEvent, getBugsnag } from './helpers'

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
    it('adds metadata to reports', () => {
      const { client, captured } = createClient()
      client.addMetadata('account', { id: 1 })
      client.addMetadata('account', 'name', 'a')
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.account).toStrictEqual({ id: 1, name: 'a' })
    })

    it('refuses prototype-polluting section names', () => {
      const { client } = createClient()
      client.addMetadata('__proto__', { polluted: true })
      client.addMetadata('constructor', { polluted: true })
      client.addMetadata('prototype', { polluted: true })
      expect(({} as any).polluted).toBeUndefined()
    })
  })

  describe('context', () => {
    it('defaults context to the current pathname', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      expect(firstEvent(captured).context).toBe(window.location.pathname)
    })

    it('allows context to be overridden in onError', () => {
      const { client, captured } = createClient({
        onError: (event: any) => { event.context = 'custom-context' }
      })
      client.notify(new Error('x'))
      expect(firstEvent(captured).context).toBe('custom-context')
    })
  })

  describe('callbacks', () => {
    it('runs configured and added onError callbacks', () => {
      const { client, captured } = createClient()
      const cb = jest.fn()
      client.addOnError(cb)
      client.notify(new Error('x'))
      expect(cb).toHaveBeenCalled()
      expect(firstEvent(captured).exceptions[0].errorMessage).toBe('x')
    })

    it('does not send when a callback returns false', () => {
      const { client, captured } = createClient({ onError: () => false })
      client.notify(new Error('x'))
      expect(captured).toHaveLength(0)
    })

    it('logs and continues when a callback throws', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      const { client, captured } = createClient({ onError: () => { throw new Error('cb') } })
      client.notify(new Error('x'))
      expect(captured).toHaveLength(1)
      expect(error).toHaveBeenCalledWith('[bugsnag]', 'Error occurred in onError callback, continuing anyway…')
    })
  })

  describe('configuration', () => {
    it('warns about invalid options and falls back to defaults', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { client, captured } = createClient({ appType: 123 } as any)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toBe('[bugsnag]')
      expect(warn.mock.calls[0][1].message).toContain('Invalid configuration')
      client.notify(new Error('x'))
      expect(firstEvent(captured).app.type).toBe('browser')
    })

    it('stringifies unusual config values in the warning', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      getBugsnag().createClient({ apiKey: API_KEY, appType: function () {} })
      expect(warn).toHaveBeenCalledTimes(1)
      const message = warn.mock.calls[0][1].message
      expect(message).toContain('appType')
      expect(message).toContain('got function')
    })

    it('does not expose the session API', () => {
      const { client } = createClient()
      expect((client as any).startSession).toBeUndefined()
      expect((client as any).pauseSession).toBeUndefined()
      expect((client as any).resumeSession).toBeUndefined()
    })

    it('only ever reports to the notify endpoint', () => {
      const { client, captured } = createClient()
      client.notify(new Error('x'))
      expect(captured).toHaveLength(1)
      expect(captured[0].url).toBe('https://notify.bugsnag.com')
    })
  })
})
