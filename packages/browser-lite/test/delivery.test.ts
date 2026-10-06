import { API_KEY, createClient, firstEvent, getBugsnag } from './helpers'

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
  })

  describe('payload', () => {
    it('sends a version 4 payload to the notify endpoint', () => {
      const { client, captured } = createClient({ appType: 'example-app' })
      client.notify(new Error('x'))
      const req = captured[0]
      expect(req.url).toBe('https://notify.bugsnag.com')
      expect(req.headers['Content-Type']).toBe('application/json')
      expect(req.headers['Bugsnag-Payload-Version']).toBe('4')
      expect(req.headers['Bugsnag-Api-Key']).toBe(API_KEY)
      expect(typeof req.headers['Bugsnag-Sent-At']).toBe('string')
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
  })

  describe('release stages', () => {
    it('does not send when the releaseStage is not enabled', () => {
      const { client, captured } = createClient({ releaseStage: 'production', enabledReleaseStages: ['staging'] })
      client.notify(new Error('x'))
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
    it('stops sending after maxEvents', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { client, captured } = createClient()
      for (let i = 0; i < 11; i++) client.notify(new Error(String(i)))
      expect(captured).toHaveLength(10)
      expect(warn).toHaveBeenCalledWith('[bugsnag]', expect.stringContaining('maxEvents limit'))
    })
  })

  describe('failures', () => {
    it('logs a failed request', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      const captured = mockStatus(500)
      const Bugsnag = getBugsnag()
      const client = Bugsnag.createClient({ apiKey: API_KEY })
      client.notify(new Error('x'))
      expect(error).toHaveBeenCalledWith('[bugsnag]', 'Event failed to send…', expect.any(Error))
      expect(captured).toHaveLength(1)
    })

    it('treats status 0 as a failure', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      mockStatus(0)
      const Bugsnag = getBugsnag()
      const client = Bugsnag.createClient({ apiKey: API_KEY })
      client.notify(new Error('x'))
      expect(error).toHaveBeenCalled()
    })

    it('logs and swallows errors thrown by the transport', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      // @ts-ignore
      window.XMLHttpRequest = function () { throw new Error('no xhr') }
      // @ts-ignore
      window.XMLHttpRequest.DONE = 4
      const Bugsnag = getBugsnag()
      const client = Bugsnag.createClient({ apiKey: API_KEY })
      expect(() => client.notify(new Error('x'))).not.toThrow()
      expect(error).toHaveBeenCalled()
    })
  })
})
