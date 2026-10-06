// Shared helpers for driving the package through its public API only.
export const API_KEY = '030bab153e7c2349be364d23b5ae93b5'

export interface Captured {
  url: string
  headers: Record<string, string>
  raw: string
  body: any
}

// Replaces window.XMLHttpRequest with a mock that records every request made
// through the public API and returns it.
export function mockDelivery (): Captured[] {
  const captured: Captured[] = []
  // @ts-ignore
  window.XMLHttpRequest = jest.fn().mockImplementation(() => {
    const xhr: any = {
      readyState: 4,
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
  window.XMLHttpRequest.DONE = 4
  return captured
}

export function getBugsnag (): any {
  return require('../src/bugsnag')
}

// Starts the singleton, capturing requests, as an application would.
export function start (opts: any = {}): { Bugsnag: any, captured: Captured[] } {
  const captured = mockDelivery()
  const Bugsnag = getBugsnag()
  Bugsnag.start({ apiKey: API_KEY, ...opts })
  return { Bugsnag, captured }
}

// Creates a client without touching the singleton, as an embedding app would.
export function createClient (opts: any = {}): { Bugsnag: any, client: any, captured: Captured[] } {
  const captured = mockDelivery()
  const Bugsnag = getBugsnag()
  const client = Bugsnag.createClient({ apiKey: API_KEY, ...opts })
  return { Bugsnag, client, captured }
}

export function firstEvent (captured: Captured[]): any {
  return captured[captured.length - 1].body.events[0]
}

export function fireOnerror (message: string, url?: string, line?: number, col?: number, error?: any) {
  ;(window as any).onerror(message, url, line, col, error)
}

export function fireRejection (reason: any) {
  const evt: any = new window.Event('unhandledrejection')
  evt.reason = reason
  window.dispatchEvent(evt)
}
