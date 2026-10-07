import type * as BugsnagBrowserStatic from '../src/bugsnag'

const DONE = window.XMLHttpRequest.DONE

const API_KEY = '030bab153e7c2349be364d23b5ae93b5'

interface MockXHR {
  open: jest.Mock<any, any>
  send: jest.Mock<any, any>
  setRequestHeader: jest.Mock<any, any>
}

type SendCallback = (xhr: MockXHR) => void

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
  window.XMLHttpRequest = jest.fn().mockImplementation(() => notify)
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

  it('notifies errors', () => {
    const onNotifySend = (notify: MockXHR) => {
      expect(notify.open).toHaveBeenCalledWith('POST', 'https://notify.bugsnag.com')
      expect(notify.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/json')
      expect(notify.setRequestHeader).toHaveBeenCalledWith('Bugsnag-Api-Key', API_KEY)
      expect(notify.setRequestHeader).toHaveBeenCalledWith('Bugsnag-Payload-Version', '4')
      expect(notify.send).toHaveBeenCalledWith(expect.any(String))
    }

    const { notify } = mockFetch(onNotifySend)

    const Bugsnag = getBugsnag()
    const client = Bugsnag.createClient(API_KEY)
    client.notify(new Error('123'))

    expect(notify.open).toHaveBeenCalled()
  })

  it('does not send if false is returned in onError', () => {
    const { notify } = mockFetch()
    const Bugsnag = getBugsnag()
    const client = Bugsnag.createClient({
      apiKey: API_KEY,
      onError: () => false
    })
    client.notify(new Error('123'))
    expect(notify.open).not.toHaveBeenCalled()
  })

  it('accepts all supported config options', () => {
    const Bugsnag = getBugsnag()

    const completeConfig: Required<BugsnagBrowserStatic.BrowserConfig> = {
      apiKey: API_KEY,
      appType: 'worker',
      onError: [
        event => true
      ],
      enabledReleaseStages: ['production', 'staging'],
      releaseStage: 'production'
    }

    const client = Bugsnag.createClient(completeConfig)
    expect(typeof client.notify).toBe('function')
  })

  it('throws when no api key is supplied', () => {
    const Bugsnag = getBugsnag()
    expect(() => Bugsnag.createClient()).toThrow('No Bugsnag API Key set')
  })

  it('uses supplied config values without validation', () => {
    const { notify } = mockFetch()
    const Bugsnag = getBugsnag()
    const client = Bugsnag.createClient({ apiKey: API_KEY, appType: 123 } as any)
    client.notify(new Error('x'))
    const body = JSON.parse(notify.send.mock.calls[0][0])
    expect(body.events[0].app.type).toBe(123)
  })
})
