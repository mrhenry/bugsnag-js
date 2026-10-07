import { createClient, fireOnerror, firstEvent } from './helpers'

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
      const { client, captured } = createClient()
      values.forEach(v => client.notify(v))
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
      const { client, captured } = createClient()
      client.notify('a string problem' as any)
      client.notify(42 as any)
      const messages = captured.map(c => c.body.events[0].exceptions[0].errorMessage)
      expect(messages).toStrictEqual(['a string problem', '42'])
    })
  })

  describe('handled state', () => {
    it('reports handled errors with warning severity', () => {
      const { client, captured } = createClient()
      client.notify(new Error('manual'))
      const event = firstEvent(captured)
      expect(event.severity).toBe('warning')
      expect(event.unhandled).toBe(false)
      expect(event.severityReason).toStrictEqual({ type: 'handledException' })
    })

    it('records userCallbackSetSeverity when a callback changes severity', () => {
      const { client, captured } = createClient({
        onError: (event: any) => { event.severity = 'info' }
      })
      client.notify(new Error('sev'))
      const event = firstEvent(captured)
      expect(event.severity).toBe('info')
      expect(event.severityReason).toStrictEqual({ type: 'userCallbackSetSeverity' })
    })

    it('records unhandledOverridden when a callback changes unhandled', () => {
      const { client, captured } = createClient({
        onError: (event: any) => { event.unhandled = true }
      })
      client.notify(new Error('x'))
      const event = firstEvent(captured)
      expect(event.unhandled).toBe(true)
      expect(event.severityReason.unhandledOverridden).toBe(true)
    })
  })

  describe('onError callback forms', () => {
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

  describe('stacktrace parsing', () => {
    const stackOf = (stack: string): any => {
      const { client, captured } = createClient()
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
      const { client, captured } = createClient({ appType: 'example-app' })
      client.notify(new Error('boom'))
      const event = firstEvent(captured)
      expect(event.payloadVersion).toBe('4')
      expect(event.severity).toBe('warning')
      expect(event.unhandled).toBe(false)
      expect(event.severityReason).toStrictEqual({ type: 'handledException' })
      expect(event.app).toStrictEqual({ releaseStage: 'development', type: 'example-app' })
      expect(event.request.url).toBe(window.location.href)
      expect(event.context).toBe(window.location.pathname)
      expect(event.exceptions[0]).toStrictEqual(expect.objectContaining({ errorClass: 'Error', message: 'boom' }))
    })

    it('redacts the default password key', () => {
      const { client, captured } = createClient()
      client.addMetadata('auth', { password: 'secret', user: 'bob' })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.auth).toStrictEqual({ password: '[REDACTED]', user: 'bob' })
    })

    it('marks circular metadata references', () => {
      const a: any = {}
      a.self = a
      const { client, captured } = createClient()
      client.addMetadata('loop', { a })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.loop.a.self).toBe('[Circular]')
    })

    it('handles metadata whose properties throw when read', () => {
      const meta: any = {}
      Object.defineProperty(meta, 'boom', { enumerable: true, get () { throw new Error('nope') } })
      const { client, captured } = createClient()
      client.addMetadata('section', { nested: meta })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.section.nested.boom).toBe('[Throws: nope]')
    })

    it('replaces metadata values beyond the maximum depth', () => {
      const root: any = {}
      let cur = root
      for (let i = 0; i < 25; i++) { cur.child = {}; cur = cur.child }
      const { client, captured } = createClient()
      client.addMetadata('deep', root)
      client.notify(new Error('x'))
      expect(JSON.stringify(firstEvent(captured).metaData.deep)).toContain('...')
    })

    it('strips metadata when the payload is oversized', () => {
      const { client, captured } = createClient()
      client.addMetadata('big', { data: 'x'.repeat(1.2e6) })
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.notifier).toContain('metadata was removed')
    })

    it('serialises raw errors in metadata as name/message', () => {
      const { client, captured } = createClient()
      client.addMetadata('section', 'err', new Error('inner'))
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.section.err).toStrictEqual({ name: 'Error', message: 'inner' })
    })

    it('handles metadata whose toJSON throws', () => {
      const bad = { toJSON () { throw new Error('bad') } }
      const { client, captured } = createClient()
      client.addMetadata('bad', bad)
      client.notify(new Error('x'))
      expect(firstEvent(captured).metaData.bad).toBe('[Throws: bad]')
    })

    it('replaces deeply nested metadata once the edge limit is exceeded', () => {
      const wide: any = {}
      for (let i = 0; i < 26000; i++) wide['k' + i] = i
      let root: any = wide
      for (let i = 0; i < 9; i++) root = { child: root }
      const { client, captured } = createClient()
      client.addMetadata('root', root)
      client.notify(new Error('x'))
      expect(JSON.stringify(firstEvent(captured).metaData.root)).toContain('...')
    })
  })
})
