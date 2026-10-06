// Behaviour of the bundled XMLHttpRequest delivery mechanism.
const delivery = require('@bugsnag/delivery-xml-http-request')
const Event = require('@bugsnag/core/event')

function makeLogger () {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

function makeClient (overrides: any = {}) {
  return Object.assign({
    _config: {
      endpoints: { notify: 'https://notify', sessions: 'https://sessions' },
      redactedKeys: [],
      apiKey: 'k',
      sendPayloadChecksums: false
    },
    _logger: makeLogger()
  }, overrides)
}

function makeWin (status = 200, opts: any = {}) {
  const xhr: any = {
    readyState: 4,
    status,
    onreadystatechange: () => {},
    open: jest.fn(),
    setRequestHeader: jest.fn(),
    send: jest.fn(function () { this.onreadystatechange() })
  }
  const XHR: any = jest.fn(() => xhr)
  XHR.DONE = 4
  const win: any = Object.assign({ XMLHttpRequest: XHR }, opts)
  return { win, xhr }
}

function eventPayload () {
  const event: any = new Event('Error', 'boom')
  return { apiKey: 'k', notifier: { name: 'n', version: 'v', url: 'u' }, events: [event] }
}

describe('delivery-xml-http-request sendEvent', () => {
  it('POSTs the event with the expected headers on success', () => {
    const client = makeClient()
    const { win, xhr } = makeWin(200)
    let result: any = 'unset'
    delivery(client, win).sendEvent(eventPayload(), (err: any) => { result = err })
    expect(xhr.open).toHaveBeenCalledWith('POST', 'https://notify')
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('Bugsnag-Payload-Version', '4')
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('Bugsnag-Api-Key', 'k')
    expect(result).toBeNull()
  })

  it('reports a failed request', () => {
    const client = makeClient()
    const { win } = makeWin(500)
    let result: any
    delivery(client, win).sendEvent(eventPayload(), (err: any) => { result = err })
    expect(result.message).toContain('Request failed with status 500')
    expect(client._logger.error).toHaveBeenCalled()
  })

  it('treats status 0 as a failure', () => {
    const client = makeClient()
    const { win } = makeWin(0)
    let result: any
    delivery(client, win).sendEvent(eventPayload(), (err: any) => { result = err })
    expect(result).toBeInstanceOf(Error)
  })

  it('aborts when the notify endpoint is null', () => {
    const client = makeClient({ _config: { endpoints: { notify: null, sessions: 'https://s' }, redactedKeys: [], apiKey: 'k', sendPayloadChecksums: false } })
    const { win } = makeWin(200)
    let result: any
    delivery(client, win).sendEvent(eventPayload(), (err: any) => { result = err })
    expect(result).toStrictEqual(new Error('Event not sent due to incomplete endpoint configuration'))
  })

  it('warns when an oversized event fails to send', () => {
    const client = makeClient()
    const { win } = makeWin(500)
    const event: any = new Event('Error', 'x'.repeat(1.2e6))
    delivery(client, win).sendEvent({ apiKey: 'k', notifier: {}, events: [event] }, () => {})
    expect(client._logger.warn).toHaveBeenCalledWith(expect.stringContaining('Event oversized'))
  })

  it('logs and swallows errors thrown by the transport', () => {
    const client = makeClient()
    const win: any = { XMLHttpRequest: function () { throw new Error('no xhr') } }
    win.XMLHttpRequest.DONE = 4
    expect(() => delivery(client, win).sendEvent(eventPayload(), () => {})).not.toThrow()
    expect(client._logger.error).toHaveBeenCalled()
  })

  it('adds an integrity header when checksums are enabled', (done) => {
    const client = makeClient({ _config: { endpoints: { notify: 'https://notify', sessions: 'https://s' }, redactedKeys: [], apiKey: 'k', sendPayloadChecksums: true } })
    const crypto = { subtle: { digest: () => Promise.resolve(new ArrayBuffer(20)) } }
    const { win, xhr } = makeWin(200, { isSecureContext: true, crypto })
    delivery(client, win).sendEvent(eventPayload(), () => {
      expect(xhr.setRequestHeader).toHaveBeenCalledWith('Bugsnag-Integrity', expect.stringContaining('sha1 '))
      done()
    })
  })

  it('sends without an integrity header when the digest fails', (done) => {
    const client = makeClient({ _config: { endpoints: { notify: 'https://notify', sessions: 'https://s' }, redactedKeys: [], apiKey: 'k', sendPayloadChecksums: true } })
    const crypto = { subtle: { digest: () => Promise.reject(new Error('nope')) } }
    const { win, xhr } = makeWin(200, { isSecureContext: true, crypto })
    delivery(client, win).sendEvent(eventPayload(), () => {
      expect(xhr.setRequestHeader).not.toHaveBeenCalledWith('Bugsnag-Integrity', expect.any(String))
      expect(client._logger.error).toHaveBeenCalled()
      done()
    })
  })

  it('does not add an integrity header outside a secure context', () => {
    const client = makeClient({ _config: { endpoints: { notify: 'https://notify', sessions: 'https://s' }, redactedKeys: [], apiKey: 'k', sendPayloadChecksums: true } })
    const { win, xhr } = makeWin(200, { isSecureContext: false })
    delivery(client, win).sendEvent(eventPayload(), () => {})
    expect(xhr.setRequestHeader).not.toHaveBeenCalledWith('Bugsnag-Integrity', expect.any(String))
  })

  it('defaults the callback and falls back to the configured api key', () => {
    const client = makeClient()
    const { win, xhr } = makeWin(200)
    const payload: any = eventPayload()
    delete payload.apiKey
    expect(() => delivery(client, win).sendEvent(payload)).not.toThrow()
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('Bugsnag-Api-Key', 'k')
  })

  it('ignores readystatechange events until the request is DONE', () => {
    const client = makeClient()
    const xhr: any = {
      readyState: 2,
      status: 200,
      open: jest.fn(),
      setRequestHeader: jest.fn(),
      send: jest.fn()
    }
    const win: any = { XMLHttpRequest: Object.assign(jest.fn(() => xhr), { DONE: 4 }) }
    const cb = jest.fn()
    delivery(client, win).sendEvent(eventPayload(), cb)
    xhr.onreadystatechange()
    expect(cb).not.toHaveBeenCalled()
    xhr.readyState = 4
    xhr.onreadystatechange()
    expect(cb).toHaveBeenCalledWith(null)
  })

  it('skips checksum computation when Promise is missing or not native', () => {
    const client = makeClient({ _config: { endpoints: { notify: 'https://notify', sessions: 'https://s' }, redactedKeys: [], apiKey: 'k', sendPayloadChecksums: true } })
    const { win, xhr } = makeWin(200, { isSecureContext: true, crypto: { subtle: { digest: jest.fn() } } })
    const RealPromise = global.Promise
    try {
      // @ts-ignore
      global.Promise = undefined
      delivery(client, win).sendEvent(eventPayload(), () => {})
      // @ts-ignore
      global.Promise = function FakePromise () {}
      delivery(client, win).sendEvent(eventPayload(), () => {})
    } finally {
      global.Promise = RealPromise
    }
    expect(xhr.setRequestHeader).not.toHaveBeenCalledWith('Bugsnag-Integrity', expect.any(String))
  })
})

describe('delivery-xml-http-request sendSession', () => {
  const sessionPayload = () => ({ notifier: {}, device: {}, app: {}, sessions: [{ id: 's' }] })

  it('POSTs the session on success', () => {
    const client = makeClient()
    const { win, xhr } = makeWin(200)
    let result: any = 'unset'
    delivery(client, win).sendSession(sessionPayload(), (err: any) => { result = err })
    expect(xhr.open).toHaveBeenCalledWith('POST', 'https://sessions')
    expect(result).toBeNull()
  })

  it('reports a failed session request', () => {
    const client = makeClient()
    const { win } = makeWin(503)
    let result: any
    delivery(client, win).sendSession(sessionPayload(), (err: any) => { result = err })
    expect(result.message).toContain('Request failed with status 503')
    expect(client._logger.error).toHaveBeenCalled()
  })

  it('aborts when the sessions endpoint is null', () => {
    const client = makeClient({ _config: { endpoints: { notify: 'https://n', sessions: null }, redactedKeys: [], apiKey: 'k', sendPayloadChecksums: false } })
    const { win } = makeWin(200)
    let result: any
    delivery(client, win).sendSession(sessionPayload(), (err: any) => { result = err })
    expect(result).toStrictEqual(new Error('Session not sent due to incomplete endpoint configuration'))
  })

  it('logs and swallows errors thrown by the transport', () => {
    const client = makeClient()
    const win: any = { XMLHttpRequest: function () { throw new Error('no xhr') } }
    win.XMLHttpRequest.DONE = 4
    expect(() => delivery(client, win).sendSession(sessionPayload(), () => {})).not.toThrow()
    expect(client._logger.error).toHaveBeenCalled()
  })

  it('defaults the callback and ignores readystatechange until DONE', () => {
    const client = makeClient()
    const xhr: any = {
      readyState: 2,
      status: 200,
      open: jest.fn(),
      setRequestHeader: jest.fn(),
      send: jest.fn()
    }
    const win: any = { XMLHttpRequest: Object.assign(jest.fn(() => xhr), { DONE: 4 }) }
    expect(() => delivery(client, win).sendSession(sessionPayload())).not.toThrow()
    xhr.onreadystatechange()
    xhr.readyState = 4
    xhr.onreadystatechange()
    expect(xhr.open).toHaveBeenCalledWith('POST', 'https://sessions')
  })

  it('adds an integrity header to sessions when checksums are enabled', (done) => {
    const client = makeClient({ _config: { endpoints: { notify: 'https://notify', sessions: 'https://s' }, redactedKeys: [], apiKey: 'k', sendPayloadChecksums: true } })
    const crypto = { subtle: { digest: () => Promise.resolve(new ArrayBuffer(20)) } }
    const { win, xhr } = makeWin(200, { isSecureContext: true, crypto })
    delivery(client, win).sendSession(sessionPayload(), () => {
      expect(xhr.setRequestHeader).toHaveBeenCalledWith('Bugsnag-Integrity', expect.stringContaining('sha1 '))
      done()
    })
  })

  it('sends without an integrity header when the digest fails', (done) => {
    const client = makeClient({ _config: { endpoints: { notify: 'https://notify', sessions: 'https://s' }, redactedKeys: [], apiKey: 'k', sendPayloadChecksums: true } })
    const crypto = { subtle: { digest: () => Promise.reject(new Error('nope')) } }
    const { win, xhr } = makeWin(200, { isSecureContext: true, crypto })
    delivery(client, win).sendSession(sessionPayload(), () => {
      expect(xhr.setRequestHeader).not.toHaveBeenCalledWith('Bugsnag-Integrity', expect.any(String))
      expect(client._logger.error).toHaveBeenCalled()
      done()
    })
  })

  it('sends without an integrity header when the context is not secure', (done) => {
    const client = makeClient({ _config: { endpoints: { notify: 'https://notify', sessions: 'https://s' }, redactedKeys: [], apiKey: 'k', sendPayloadChecksums: true } })
    const { win, xhr } = makeWin(200, { isSecureContext: false })
    delivery(client, win).sendSession(sessionPayload(), (err: any) => {
      expect(err).toBeNull()
      expect(xhr.setRequestHeader).not.toHaveBeenCalledWith('Bugsnag-Integrity', expect.any(String))
      done()
    })
  })
})
