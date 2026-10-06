import { createClient, fireOnerror, firstEvent, start } from './helpers'

const realConsole = {
  log: console.log,
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error
}

describe('event public API', () => {
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

  describe('notify input normalisation', () => {
    const classesFor = (values: any[]): string[] => {
      const { Bugsnag, captured } = start()
      values.forEach(v => Bugsnag.notify(v))
      return captured.map(c => c.body.events[0].exceptions[0].errorClass)
    }

    it('treats strings, numbers and booleans as errors', () => {
      expect(classesFor(['s', 1, false])).toStrictEqual(['Error', 'Error', 'Error'])
    })

    it('coerces null, undefined, functions and plain objects to errors', () => {
      expect(classesFor([null, undefined, () => {}, {}])).toStrictEqual([
        'Error', 'Error', 'Error', 'Error'
      ])
    })

    it('reports the stringified value as the message', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify('a string problem' as any)
      Bugsnag.notify(42 as any)
      const messages = captured.map(c => c.body.events[0].exceptions[0].errorMessage)
      expect(messages).toStrictEqual(['a string problem', '42'])
    })
  })

  describe('handled state', () => {
    it('reports handled errors with warning severity', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('manual'))
      const event = firstEvent(captured)
      expect(event.severity).toBe('warning')
      expect(event.unhandled).toBe(false)
      expect(event.severityReason).toStrictEqual({ type: 'handledException' })
    })

    it('records userCallbackSetSeverity when a callback changes severity', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('sev'), (event: any) => { event.severity = 'info' })
      const event = firstEvent(captured)
      expect(event.severity).toBe('info')
      expect(event.severityReason).toStrictEqual({ type: 'userCallbackSetSeverity' })
    })

    it('records unhandledOverridden when a callback changes unhandled', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'), (event: any) => { event.unhandled = true })
      const event = firstEvent(captured)
      expect(event.unhandled).toBe(true)
      expect(event.severityReason.unhandledOverridden).toBe(true)
    })
  })

  describe('onError callback forms', () => {
    it('does not send when a sync callback returns false', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'), () => false)
      expect(captured).toHaveLength(0)
    })

    it('does not send when a node-style callback reports false', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'), (event: any, cb: any) => cb(null, false))
      expect(captured).toHaveLength(0)
    })

    it('logs and continues when a callback throws', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'), () => { throw new Error('cb') })
      expect(captured).toHaveLength(1)
      expect(error).toHaveBeenCalledWith('[bugsnag]', 'Error occurred in onError callback, continuing anyway…')
    })

    it('logs and continues when a node-style callback reports an error', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'), (event: any, cb: any) => cb(new Error('bad')))
      expect(captured).toHaveLength(1)
      expect(error).toHaveBeenCalled()
    })

    it('awaits promise-returning callbacks', async () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'), () => Promise.resolve(false))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(captured).toHaveLength(0)
    })

    it('logs and continues when a promise rejects', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {})
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'), () => Promise.reject(new Error('nope')))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(captured).toHaveLength(1)
      expect(error).toHaveBeenCalled()
    })
  })

  describe('stacktrace parsing', () => {
    const stackOf = (stack: string): any => {
      const { captured } = start()
      const err: any = new Error('boom')
      err.stack = stack
      fireOnerror('boom', 'http://x/fallback.js', 9, 9, err)
      return firstEvent(captured).exceptions[0].stacktrace
    }

    it('parses V8 frames with and without a function name', () => {
      const frames = stackOf('Error: boom\n    at foo (http://x/a.js:1:2)\n    at http://x/b.js:3:4')
      expect(frames[0]).toStrictEqual(expect.objectContaining({
        file: 'http://x/a.js', method: 'foo', lineNumber: 1, columnNumber: 2
      }))
      expect(frames[1]).toStrictEqual(expect.objectContaining({
        file: 'http://x/b.js', lineNumber: 3, columnNumber: 4
      }))
    })

    it('parses Firefox and Safari frames', () => {
      const frames = stackOf('Error: boom\nfoo@http://x/a.js:1:2\n@http://x/b.js:3:4\nbar@http://x/c.js\n@http://x/d.js')
      expect(frames[0]).toStrictEqual(expect.objectContaining({ file: 'http://x/a.js', method: 'foo' }))
      expect(frames[1]).toStrictEqual(expect.objectContaining({ file: 'http://x/b.js' }))
      expect(frames[2]).toStrictEqual(expect.objectContaining({ file: 'http://x/c.js', method: 'bar' }))
      expect(frames[3]).toStrictEqual(expect.objectContaining({ file: 'http://x/d.js' }))
    })

    it('drops frames with no usable data', () => {
      const frames = stackOf('Error: boom\nnot a frame at all\n    at foo (http://x/a.js:1:2)')
      expect(frames).toHaveLength(1)
      expect(frames[0]).toStrictEqual(expect.objectContaining({ file: 'http://x/a.js', method: 'foo' }))
    })
  })

  describe('payload', () => {
    it('serialises to the version 4 payload shape', () => {
      const { client, captured } = createClient({ appVersion: '1.2.3' })
      client.setContext('ctx')
      client.notify(new Error('boom'))
      const event = firstEvent(captured)
      expect(event.payloadVersion).toBe('4')
      expect(event.severity).toBe('warning')
      expect(event.unhandled).toBe(false)
      expect(event.severityReason).toStrictEqual({ type: 'handledException' })
      expect(event.app).toStrictEqual({ releaseStage: 'development', version: '1.2.3', type: 'browser' })
      expect(event.request.url).toBe(window.location.href)
      expect(event.context).toBe('ctx')
      expect(event.exceptions[0]).toStrictEqual(expect.objectContaining({ errorClass: 'Error', message: 'boom' }))
    })

    it('redacts keys matching a regex', () => {
      const { client, captured } = createClient({
        metadata: { auth: { token: 'secret', user: 'bob' } },
        redactedKeys: [/token/]
      })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.auth).toStrictEqual({ token: '[REDACTED]', user: 'bob' })
    })

    it('marks circular metadata references', () => {
      const a: any = {}
      a.self = a
      const { client, captured } = createClient({ metadata: { loop: { a } } })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.loop.a.self).toBe('[Circular]')
    })

    it('handles metadata whose properties throw when read', () => {
      const meta: any = {}
      Object.defineProperty(meta, 'boom', { enumerable: true, get () { throw new Error('nope') } })
      const { client, captured } = createClient({ metadata: { section: meta } })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.section.boom).toBe('[Throws: nope]')
    })

    it('replaces metadata values beyond the maximum depth', () => {
      const root: any = {}
      let cur = root
      for (let i = 0; i < 25; i++) { cur.child = {}; cur = cur.child }
      const { client, captured } = createClient({ metadata: { deep: root } })
      client.notify(new Error('x'))
      expect(JSON.stringify(firstEvent(captured).metaData.deep)).toContain('...')
    })

    it('strips metadata when the payload is oversized', () => {
      const { client, captured } = createClient({ metadata: { big: { data: 'x'.repeat(1.2e6) } } })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.notifier).toContain('metadata was removed')
    })

    it('serialises raw errors in metadata as name/message', () => {
      const { client, captured } = createClient({ metadata: { err: new Error('inner') } })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.err).toStrictEqual({ name: 'Error', message: 'inner' })
    })

    it('handles metadata whose toJSON throws', () => {
      const bad = { toJSON () { throw new Error('bad') } }
      const { client, captured } = createClient({ metadata: { bad } })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.bad).toBe('[Throws: bad]')
    })

    it('replaces deeply nested metadata once the edge limit is exceeded', () => {
      const wide: any = {}
      for (let i = 0; i < 26000; i++) wide['k' + i] = i
      let root: any = wide
      for (let i = 0; i < 9; i++) root = { child: root }
      const { client, captured } = createClient({ metadata: { root } })
      client.notify(new Error('x'))
      expect(JSON.stringify(firstEvent(captured).metaData.root)).toContain('...')
    })

    it('replaces deeply nested array metadata once the edge limit is exceeded', () => {
      const wide: any[] = []
      for (let i = 0; i < 26000; i++) wide.push(i)
      let root: any = wide
      for (let i = 0; i < 9; i++) root = { child: root }
      const { client, captured } = createClient({ metadata: { root } })
      client.notify(new Error('x'))
      expect(JSON.stringify(firstEvent(captured).metaData.root)).toContain('...')
    })
  })

  describe('event helpers in onError', () => {
    it('exposes metadata helpers', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'), (event: any) => {
        event.addMetadata('site', { id: 's1' })
        event.addMetadata('site', 'app', 'example')
        expect(event.getMetadata('site', 'id')).toBe('s1')
        event.clearMetadata('site', 'id')
      })
      const event = firstEvent(captured)
      expect(event.metaData.site).toStrictEqual({ app: 'example' })
    })

    it('can clear all metadata', () => {
      const { Bugsnag, captured } = start()
      Bugsnag.notify(new Error('x'), (event: any) => {
        event.addMetadata('s', { a: 1 })
        event.clearMetadata('s')
      })
      const event = firstEvent(captured)
      expect(event.metaData.s).toBeUndefined()
    })
  })
})
