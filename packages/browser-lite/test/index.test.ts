import BugsnagBrowserStatic, { BrowserConfig } from '../src/bugsnag'

const DONE = window.XMLHttpRequest.DONE

const API_KEY = '030bab153e7c2349be364d23b5ae93b5'

interface MockXHR {
  open: jest.Mock<any, any>
  send: jest.Mock<any, any>
  setRequestHeader: jest.Mock<any, any>
}

type SendCallback = (xhr: MockXHR) => void

// browser-lite does not support sessions, so only notify requests are expected
function mockFetch (onNotifySend?: SendCallback) {
  const makeMockXHR = (onSend?: SendCallback) => {
    const xhr = {
      open: jest.fn(),
      send: jest.fn(),
      setRequestHeader: jest.fn(),
      readyState: DONE,
      onreadystatechange: () => {}
    }
    xhr.send.mockImplementation((...args) => {
      xhr.onreadystatechange()
      onSend?.(xhr)
    })
    return xhr
  }

  const notify = makeMockXHR(onNotifySend)

  // @ts-ignore
  window.XMLHttpRequest = jest.fn()
    .mockImplementationOnce(() => notify)
    .mockImplementation(() => makeMockXHR(() => {}))
  // @ts-ignore
  window.XMLHttpRequest.DONE = DONE

  return { notify }
}

describe('browser notifier', () => {
  beforeAll(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  beforeEach(() => {
    jest.resetModules()
  })

  function getBugsnag (): typeof BugsnagBrowserStatic {
    const Bugsnag = require('../src/bugsnag') as typeof BugsnagBrowserStatic
    return Bugsnag
  }

  it('does not expose the session API', () => {
    const Bugsnag = getBugsnag()
    // @ts-expect-error
    expect(Bugsnag.startSession).toBeUndefined()
    // @ts-expect-error
    expect(Bugsnag.pauseSession).toBeUndefined()
    // @ts-expect-error
    expect(Bugsnag.resumeSession).toBeUndefined()
  })

  it('notifies handled errors', (done) => {
    const onNotifySend = (notify: MockXHR) => {
      expect(notify.open).toHaveBeenCalledWith('POST', 'https://notify.bugsnag.com')
      expect(notify.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/json')
      expect(notify.setRequestHeader).toHaveBeenCalledWith('Bugsnag-Api-Key', '030bab153e7c2349be364d23b5ae93b5')
      expect(notify.setRequestHeader).toHaveBeenCalledWith('Bugsnag-Payload-Version', '4')
      expect(notify.send).toHaveBeenCalledWith(expect.any(String))
      done()
    }

    mockFetch(onNotifySend)

    const Bugsnag = getBugsnag()
    Bugsnag.start(API_KEY)
    Bugsnag.notify(new Error('123'), undefined, (err, event) => {
      if (err) {
        done(err)
      }
      expect(event.originalError.message).toBe('123')
    })
  })

  it('does not send an event with invalid configuration', () => {
    const { notify } = mockFetch()

    const Bugsnag = getBugsnag()
    // @ts-expect-error
    Bugsnag.start({ apiKey: API_KEY, endpoints: {} })
    Bugsnag.notify(new Error('123'), undefined, (err, event) => {
      expect(err).toStrictEqual(new Error('Event not sent due to incomplete endpoint configuration'))
    })

    expect(notify.open).not.toHaveBeenCalled()
  })

  it('does not send if false is returned in onError', (done) => {
    const { notify } = mockFetch()
    const Bugsnag = getBugsnag()
    Bugsnag.start(API_KEY)
    Bugsnag.notify(new Error('123'), (event) => {
      return false
    }, (err, event) => {
      if (err) {
        done(err)
      }
      expect(notify.open).not.toHaveBeenCalled()
      done()
    })
  })

  it('accepts all config options', (done) => {
    const Bugsnag = getBugsnag()

    const completeConfig: Required<BrowserConfig> = {
      apiKey: API_KEY,
      appVersion: '1.2.3',
      appType: 'worker',
      autoDetectErrors: true,
      enabledErrorTypes: {
        unhandledExceptions: true,
        unhandledRejections: true
      },
      onError: [
        event => true
      ],
      endpoints: { notify: 'https://notify.bugsnag.com' },
      enabledReleaseStages: ['zzz'],
      releaseStage: 'production',
      context: 'contextual',
      metadata: {
        debug: { foo: 'bar' }
      },
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      redactedKeys: ['foo', /bar/],
      maxEvents: 10,
      reportUnhandledPromiseRejectionsAsHandled: true
    }

    Bugsnag.start(completeConfig)
    Bugsnag.notify(new Error('123'), (event) => {
      return false
    }, (err, event) => {
      if (err) {
        done(err)
      }
      expect(event.originalError.message).toBe('123')
      expect(event.getMetadata('debug')).toEqual({ foo: 'bar' })
      done()
    })
  })

  it('indicates whether or not the client is started', () => {
    const Bugsnag = getBugsnag()
    expect(Bugsnag.isStarted()).toBe(false)
    Bugsnag.start(API_KEY)
    expect(Bugsnag.isStarted()).toBe(true)
  })
})
