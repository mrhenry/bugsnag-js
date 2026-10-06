const pluginDevice = require('../src/device')

function fakeClient () {
  const cbs: any[] = []
  return {
    addOnError: (fn: any) => cbs.push(fn),
    runOnError: (event: any) => cbs.forEach(fn => fn(event))
  }
}

function load (nav: any, win: any) {
  const client = fakeClient()
  pluginDevice(nav, win).load(client)
  const event: any = { device: {} }
  client.runOnError(event)
  return event.device
}

describe('device plugin', () => {
  it('uses screen.orientation and reports the window size', () => {
    const device = load(
      { browserLanguage: 'en-GB', userAgent: 'test-agent' },
      { screen: { orientation: { type: 'landscape-primary' } }, innerWidth: 1024, innerHeight: 768 }
    )
    expect(device.orientation).toBe('landscape-primary')
    expect(device.windowWidth).toBe(1024)
    expect(device.windowHeight).toBe(768)
    expect(device.locale).toBe('en-GB')
    expect(device.userAgent).toBe('test-agent')
    expect(device.time).toBeInstanceOf(Date)
  })

  it('falls back to document dimensions (portrait) and omits window size when unavailable', () => {
    const device = load(
      { systemLanguage: 'de', userAgent: 'ua' },
      { document: { documentElement: { clientWidth: 100, clientHeight: 200 } } }
    )
    expect(device.orientation).toBe('portrait')
    expect(device.windowWidth).toBeUndefined()
    expect(device.windowHeight).toBeUndefined()
    expect(device.locale).toBe('de')
  })

  it('reports landscape from document dimensions', () => {
    const device = load(
      { userLanguage: 'fr', userAgent: 'ua' },
      { document: { documentElement: { clientWidth: 200, clientHeight: 100 } } }
    )
    expect(device.orientation).toBe('landscape')
    expect(device.locale).toBe('fr')
  })

  it('falls back to navigator.language and omits orientation without a screen or document', () => {
    const device = load({ language: 'en', userAgent: 'ua' }, {})
    expect(device.locale).toBe('en')
    expect(device.orientation).toBeUndefined()
  })
})
