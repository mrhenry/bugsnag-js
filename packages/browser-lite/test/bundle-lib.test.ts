// Unit tests for the bundled core library internals. These modules are part of
// the browser-lite bundle; the tests pin their behaviour so the whole bundle can
// be reimplemented without the upstream dependencies.
const md = require('@bugsnag/core/lib/metadata-delegate')
const ff = require('@bugsnag/core/lib/feature-flag-delegate')
const asyncEvery = require('@bugsnag/core/lib/async-every')
const runSyncCallbacks = require('@bugsnag/core/lib/sync-callback-runner')
const runCallbacks = require('@bugsnag/core/lib/callback-runner')
const jsonPayload = require('@bugsnag/core/lib/json-payload')
const hasStack = require('@bugsnag/core/lib/has-stack')
const keys = require('@bugsnag/core/lib/es-utils/keys')
const assign = require('@bugsnag/core/lib/es-utils/assign')
const intRange = require('@bugsnag/core/lib/validators/int-range')
const Session = require('@bugsnag/core/session')
const Event = require('@bugsnag/core/event')

const noopLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }

describe('metadata-delegate', () => {
  it('adds an object of values to a section', () => {
    const state: any = {}
    md.add(state, 'account', { id: 1, name: 'a' })
    expect(state).toStrictEqual({ account: { id: 1, name: 'a' } })
  })

  it('adds a single key/value to a section', () => {
    const state: any = {}
    md.add(state, 'account', 'id', 1)
    expect(state.account.id).toBe(1)
  })

  it('merges into an existing section', () => {
    const state: any = { account: { id: 1 } }
    md.add(state, 'account', 'name', 'b')
    expect(state.account).toStrictEqual({ id: 1, name: 'b' })
  })

  it('ignores calls without a section or updates', () => {
    const state: any = {}
    md.add(state, '', { a: 1 })
    md.add(state, 'x', 123)
    expect(state).toStrictEqual({})
  })

  it('clears a section when the second argument is null', () => {
    const state: any = { account: { id: 1 } }
    md.add(state, 'account', null)
    expect(state.account).toBeUndefined()
  })

  it('refuses to use prototype-polluting section names', () => {
    const state: any = {}
    md.add(state, '__proto__', { polluted: true })
    md.add(state, 'constructor', { polluted: true })
    md.add(state, 'prototype', { polluted: true })
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.keys(state)).toHaveLength(0)
  })

  it('gets a whole section or a single key', () => {
    const state: any = { account: { id: 1 } }
    expect(md.get(state, 'account')).toStrictEqual({ id: 1 })
    expect(md.get(state, 'account', 'id')).toBe(1)
    expect(md.get(state, 'account', 'missing')).toBeUndefined()
    expect(md.get({}, 'missing', 'key')).toBeUndefined()
    expect(md.get(state, 123 as any)).toBeUndefined()
  })

  it('clears a whole section or a single key', () => {
    const state: any = { account: { id: 1, name: 'a' } }
    md.clear(state, 'account', 'id')
    expect(state.account).toStrictEqual({ name: 'a' })
    md.clear(state, 'account')
    expect(state.account).toBeUndefined()
    md.clear(state, 123 as any)
    md.clear(state, '__proto__', 'x')
    md.clear(state, 'missing', 'key')
    expect(state).toStrictEqual({})
  })
})

describe('feature-flag-delegate', () => {
  it('ignores non-string names', () => {
    const features: any[] = []
    const index: any = {}
    ff.add(features, index, 123 as any, 'v')
    expect(features).toStrictEqual([])
  })

  it('defaults a missing variant to null and stringifies non-string variants', () => {
    const features: any[] = []
    const index: any = {}
    ff.add(features, index, 'a')
    ff.add(features, index, 'b', { complex: true })
    expect(features[0]).toStrictEqual({ name: 'a', variant: null })
    expect(features[1]).toStrictEqual({ name: 'b', variant: '{"complex":true}' })
  })

  it('updates an existing flag in place', () => {
    const features: any[] = []
    const index: any = {}
    ff.add(features, index, 'a', '1')
    ff.add(features, index, 'a', '2')
    expect(features).toHaveLength(1)
    expect(features[0]).toStrictEqual({ name: 'a', variant: '2' })
  })

  it('merges arrays and skips non-objects', () => {
    const features: any[] = []
    const index: any = {}
    ff.merge(features, 'nope' as any, index)
    ff.merge(features, [null, 42, { name: 'x', variant: 'y' }], index)
    expect(features).toStrictEqual([{ name: 'x', variant: 'y' }])
  })

  it('converts to the event API shape and omits empty variants', () => {
    const api = ff.toEventApi([null, { name: 'a', variant: '1' }, { name: 'b', variant: null }])
    expect(api).toStrictEqual([{ featureFlag: 'a', variant: '1' }, { featureFlag: 'b' }])
  })

  it('clears flags', () => {
    const features: any[] = []
    const index: any = {}
    ff.add(features, index, 'a', '1')
    ff.clear(features, index, 'a')
    expect(features).toStrictEqual([null])
    expect(index.a).toBeUndefined()
    ff.clear(features, index, 'missing')
  })
})

describe('async-every', () => {
  it('resolves true when all items pass', (done) => {
    asyncEvery([1, 2, 3], (item, cb) => cb(null, item < 10), (err, res) => {
      expect(err).toBeNull()
      expect(res).toBe(true)
      done()
    })
  })

  it('short-circuits to false when an item fails', (done) => {
    asyncEvery([1, 2, 3], (item, cb) => cb(null, item < 2), (err, res) => {
      expect(err).toBeNull()
      expect(res).toBe(false)
      done()
    })
  })

  it('propagates errors', (done) => {
    asyncEvery([1], (item, cb) => cb(new Error('boom')), (err, res) => {
      expect((err as Error).message).toBe('boom')
      done()
    })
  })
})

describe('sync-callback-runner', () => {
  it('returns false when no callback returns false', () => {
    expect(runSyncCallbacks([() => true, () => undefined], {}, 'onX', noopLogger)).toBe(false)
  })

  it('returns true as soon as a callback returns false (last first)', () => {
    const calls: string[] = []
    const ignore = runSyncCallbacks([
      () => { calls.push('a'); return true },
      () => { calls.push('b'); return false }
    ], {}, 'onX', noopLogger)
    expect(ignore).toBe(true)
    expect(calls).toStrictEqual(['b'])
  })

  it('logs and continues when a callback throws', () => {
    const logger = { error: jest.fn() }
    const ignore = runSyncCallbacks([() => { throw new Error('x') }], {}, 'onBreadcrumb', logger as any)
    expect(ignore).toBe(false)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Error occurred in onBreadcrumb callback'))
  })
})

describe('callback-runner', () => {
  it('runs synchronous callbacks and reports that the event should be sent', (done) => {
    runCallbacks([() => 42], {}, jest.fn(), (err, ret) => {
      expect(err).toBeNull()
      expect(ret).toBe(true)
      done()
    })
  })

  it('stops when a callback returns false', (done) => {
    runCallbacks([() => false, () => true], {}, jest.fn(), (err, ret) => {
      expect(err).toBeNull()
      expect(ret).toBe(false)
      done()
    })
  })

  it('awaits thenables', (done) => {
    runCallbacks([() => Promise.resolve('ok')], {}, jest.fn(), (err, ret) => {
      expect(err).toBeNull()
      expect(ret).toBe(true)
      done()
    })
  })

  it('reports thenable rejections and continues', (done) => {
    const onError = jest.fn()
    runCallbacks([() => Promise.reject(new Error('nope'))], {}, onError, (err, ret) => {
      expect(err).toBeNull()
      expect(onError).toHaveBeenCalled()
      expect(ret).toBe(true)
      done()
    })
  })

  it('supports node-style async callbacks', (done) => {
    runCallbacks([(event: any, cb: any) => cb(null, 7)], {}, jest.fn(), (err, ret) => {
      expect(err).toBeNull()
      expect(ret).toBe(true)
      done()
    })
  })

  it('reports node-style callback errors and continues', (done) => {
    const onError = jest.fn()
    runCallbacks([(event: any, cb: any) => cb(new Error('bad'))], {}, onError, (err, ret) => {
      expect(err).toBeNull()
      expect(onError).toHaveBeenCalled()
      expect(ret).toBe(true)
      done()
    })
  })

  it('reports thrown errors', (done) => {
    const onError = jest.fn()
    runCallbacks([() => { throw new Error('thrown') }], {}, onError, (err) => {
      expect(err).toBeNull()
      expect(onError).toHaveBeenCalled()
      done()
    })
  })

  it('skips non-functions', (done) => {
    runCallbacks([null], {}, jest.fn(), (err, ret) => {
      expect(err).toBeNull()
      expect(ret).toBe(true)
      done()
    })
  })
})

describe('es-utils', () => {
  it('keys returns own enumerable keys only', () => {
    expect(keys({ a: 1, b: 2 }).sort()).toStrictEqual(['a', 'b'])
    expect(keys(Object.create({ inherited: 1 }))).toStrictEqual([])
  })

  it('assign copies own enumerable properties', () => {
    const source = Object.create({ inherited: 1 })
    source.own = 2
    expect(assign({}, source)).toStrictEqual({ own: 2 })
  })

  it('re-adds the DontEnum keys when the engine has the legacy bug', () => {
    const original = Object.prototype.propertyIsEnumerable
    // force the module to detect the (historically real) IE DontEnum bug
    // eslint-disable-next-line no-extend-native
    Object.prototype.propertyIsEnumerable = function (prop: string) {
      if (prop === 'toString') return false
      return original.call(this, prop)
    }
    try {
      jest.resetModules()
      const keysWithBug = require('@bugsnag/core/lib/es-utils/keys')
      const obj = { toString: 1 }
      expect(keysWithBug(obj)).toContain('toString')
    } finally {
      // eslint-disable-next-line no-extend-native
      Object.prototype.propertyIsEnumerable = original
    }
  })
})

describe('validators', () => {
  it('int-range accepts integers within range only', () => {
    const v = intRange(1, 10)
    expect(v(5)).toBe(true)
    expect(v(1)).toBe(true)
    expect(v(10)).toBe(true)
    expect(v(0)).toBe(false)
    expect(v(11)).toBe(false)
    expect(v(1.5)).toBe(false)
    expect(v('5' as any)).toBe(false)
  })

  it('int-range applies its default bounds', () => {
    const v = intRange()
    expect(v(1)).toBe(true)
    expect(v(0)).toBe(false)
  })
})

describe('has-stack', () => {
  it('detects real stacks', () => {
    expect(hasStack(new Error('x'))).toBe(true)
    expect(hasStack({ stacktrace: 'a' })).toBe(true)
    expect(hasStack({ 'opera#sourceloc': 'a' })).toBe(true)
  })

  it('rejects missing or placeholder stacks', () => {
    expect(hasStack(null)).toBe(false)
    expect(hasStack({})).toBe(false)
    expect(hasStack({ name: 'Error', message: 'x', stack: 'Error: x' })).toBe(false)
  })
})

describe('session', () => {
  it('exposes id, timestamps, user and tracking', () => {
    const s: any = new Session()
    expect(typeof s.id).toBe('string')
    expect(s.startedAt).toBeInstanceOf(Date)
    expect(s.getUser()).toStrictEqual({})
    s.setUser('u', 'e', 'n')
    expect(s.getUser()).toStrictEqual({ id: 'u', email: 'e', name: 'n' })
    s._track({ _handledState: { unhandled: true } })
    s._track({ _handledState: { unhandled: false } })
    expect(s.toJSON()).toStrictEqual({
      id: s.id,
      startedAt: s.startedAt,
      events: { handled: 1, unhandled: 1 }
    })
  })
})

describe('json-payload', () => {
  it('serialises an event payload and redacts keys', () => {
    const event: any = new Event('Error', 'boom')
    event.addMetadata('auth', { password: 'secret', user: 'bob' })
    const out = jsonPayload.event({ apiKey: 'k', notifier: {}, events: [event] } as any, ['password'])
    expect(out).toContain('"apiKey":"k"')
    expect(out).toContain('"password":"[REDACTED]"')
  })

  it('strips metadata when the payload is oversized', () => {
    const event: any = new Event('Error', 'boom')
    event.addMetadata('big', { data: 'x'.repeat(1.2e6) })
    const out = jsonPayload.event({ apiKey: 'k', notifier: {}, events: [event] } as any, [])
    expect(out).toContain('Serialized payload was')
    expect(out).toContain('metadata was removed')
  })

  it('serialises a session', () => {
    const s: any = new Session()
    expect(jsonPayload.session({ sessions: [s.toJSON()] } as any, [])).toContain('"events"')
  })
})
