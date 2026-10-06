// A single, deliberately-mocked case: the callback runner is the only way to
// feed an error into the final callback of Client#_notify. In production the
// runner always reports null errors (it handles callback failures itself), so
// this branch is only reachable by replacing the module.
jest.mock('@bugsnag/core/lib/callback-runner', () => jest.fn())

const runCallbacks = require('@bugsnag/core/lib/callback-runner')
const Client = require('@bugsnag/core/client')
const { schema } = require('@bugsnag/core/config')

const API_KEY = '030bab153e7c2349be364d23b5ae93b5'
const notifier = { name: 'test', version: '1.0.0', url: 'https://example.com' }

describe('core Client callback-runner errors', () => {
  it('logs an error reported by the runner and still sends the event', () => {
    const error = jest.fn()
    const sent: any[] = []
    const client: any = new Client(
      { apiKey: API_KEY, logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error } },
      schema,
      [],
      notifier
    )
    client._setDelivery(() => ({
      sendEvent: (payload: any, cb: any = () => {}) => { sent.push(payload); cb(null) },
      sendSession: () => {}
    }))

    ;(runCallbacks as jest.Mock).mockImplementationOnce((callbacks: any, event: any, onError: any, cb: any) => {
      cb(new Error('runner failure'), true)
    })

    client.notify(new Error('x'))
    expect(error).toHaveBeenCalledWith('Error occurred in onError callback, continuing anyway…')
    expect(error).toHaveBeenCalledWith(expect.any(Error))
    expect(sent).toHaveLength(1)
  })
})
