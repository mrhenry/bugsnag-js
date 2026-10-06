import { API_KEY, createClient, firstEvent, getBugsnag, start } from './helpers'

const realConsole = {
  log: console.log,
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error
}

interface RawRequest { url: string, headers: Record<string, string>, raw: string }

function mockStatus (status: number): RawRequest[] {
  const captured: RawRequest[] = []
  // @ts-ignore
  window.XMLHttpRequest = jest.fn().mockImplementation(() => {
    const xhr: any = {
      readyState: 4,
      status,
      _url: '',
      _headers: {},
      onreadystatechange: () => {},
      open: jest.fn((method: string, url: string) => { xhr._url = url }),
      setRequestHeader: jest.fn((key: string, value: string) => { xhr._headers[key] = value }),
      send: jest.fn((raw: string) => {
        captured.push({ url: xhr._url, headers: xhr._headers, raw })
        xhr.onreadystatechange()
      })
    }
    return xhr
  })
  // @ts-ignore
  window.XMLHttpRequest.DONE = 4
  return captured
}

describe('delivery public API', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.spyOn(console, 'debug').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.assign(console, realConsole)
    // @ts-ignore
    window.isSecureContext = false
  })

  describe('payload', () => {
    it('sends a version 4 payload to the default endpoint', () => {
      const { Bugsnag, captured } = start({ appVersion: '1.2.3' })
      Bugsnag.notify(new Error('x'))
      const req = captured[0]
      expect(req.url).toBe('https://notify.bugsnag.com')
      expect(req.headers['Content-Type']).toBe('application/json')
      expect(req.headers['Bugsnag-Payload-Version']).toBe('4')
      expect(req.headers['Bugsnag-Api-Key']).toBe(API_KEY)
      expect(typeof req.headers['Bugsnag-Sent-At']).toBe('string')
      expect(req.body.notifier.name).toBe('Bugsnag JavaScript')
      expect(req.body.events[0].payloadVersion).toBe('4')
      expect(req.body.events[0].app).toStrictEqual({ releaseStage: 'development', version: '1.2.3', type: 'browser' })
    })

    it('redacts redactedKeys in metadata', () => {
      const { Bugsnag, captured } = start({ metadata: { auth: { password: 'secret', user: 'bob' } } })
      Bugsnag.notify(new Error('x'))
      expect(firstEvent(captured).metaData.auth).toStrictEqual({ password: '[REDACTED]', user: 'bob' })
    })

    it('reports an error when endpoint configuration is incomplete', () => {
      const { Bugsnag } = start({ endpoints: {} })
      Bugsnag.notify(new Error('x'), undefined, (err: any) => {
        expect(err).toStrictEqual(new Error('Event not sent due to incomplete endpoint configuration'))
      })
    })
  })

  describe('release stages', () => {
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
  })

  describe('throttling', () => {
    it('stops sending after maxEvents and can be reset', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { Bugsnag, captured } = start({ maxEvents: 2 })
      Bugsnag.notify(new Error('1'))
      Bugsnag.notify(new Error('2'))
      Bugsnag.notify(new Error('3'))
      expect(captured).toHaveLength(2)
      expect(warn).toHaveBeenCalledWith('[bugsnag]', expect.stringContaining('maxEvents limit'))

      Bugsnag.resetEventCount()
      Bugsnag.notify(new Error('4'))
      expect(captured).toHaveLength(3)
    })
  })

  describe('failures', () => {
    it('reports a failed request to the caller', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      const captured = mockStatus(500)
      const Bugsnag = getBugsnag()
      Bugsnag.start({ apiKey: API_KEY })
      let result: any
      Bugsnag.notify(new Error('x'), undefined, (err: any) => { result = err })
      expect(result.message).toContain('Request failed with status 500')
      expect(error).toHaveBeenCalledWith('[bugsnag]', 'Event failed to send…', expect.any(Error))
      expect(captured).toHaveLength(1)
    })

    it('treats status 0 as a failure', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      mockStatus(0)
      const Bugsnag = getBugsnag()
      Bugsnag.start({ apiKey: API_KEY })
      let result: any
      Bugsnag.notify(new Error('x'), undefined, (err: any) => { result = err })
      expect(result).toBeInstanceOf(Error)
      expect(error).toHaveBeenCalled()
    })

    it('warns when an oversized event fails to send', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      jest.spyOn(console, 'error').mockImplementation(() => {})
      mockStatus(500)
      const Bugsnag = getBugsnag()
      Bugsnag.start({ apiKey: API_KEY })
      Bugsnag.notify(new Error('x'.repeat(1.2e6)))
      expect(warn).toHaveBeenCalledWith('[bugsnag]', expect.stringContaining('Event oversized'))
    })

    it('logs and swallows errors thrown by the transport', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      // @ts-ignore
      window.XMLHttpRequest = function () { throw new Error('no xhr') }
      // @ts-ignore
      window.XMLHttpRequest.DONE = 4
      const Bugsnag = getBugsnag()
      Bugsnag.start({ apiKey: API_KEY })
      expect(() => Bugsnag.notify(new Error('x'))).not.toThrow()
      expect(error).toHaveBeenCalled()
    })
  })
})
