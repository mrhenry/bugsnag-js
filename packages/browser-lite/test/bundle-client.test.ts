// Behaviour of the bundled core Client (and config validation), exercised
// directly so the whole bundled stack is pinned.
const Client = require('@bugsnag/core/client')
const { schema } = require('@bugsnag/core/config')
const Session = require('@bugsnag/core/session')

const API_KEY = '030bab153e7c2349be364d23b5ae93b5'
const notifier = { name: 'test', version: '1.0.0', url: 'https://example.com' }

function makeClient (opts: any = {}, internalPlugins: any[] = []) {
  const sent: any[] = []
  const sessions: any[] = []
  const client: any = new Client({ apiKey: API_KEY, ...opts }, schema, internalPlugins, notifier)
  client._setDelivery(() => ({
    sendEvent: (payload: any, cb: any = () => {}) => { sent.push(payload); cb(null) },
    sendSession: (payload: any) => { sessions.push(payload) }
  }))
  return { client, sent, sessions }
}

describe('core Client', () => {
  it('exposes the bundled constructors', () => {
    const { client } = makeClient()
    expect(typeof client.Client).toBe('function')
    expect(typeof client.Event).toBe('function')
    expect(typeof client.Breadcrumb).toBe('function')
    expect(typeof client.Session).toBe('function')
  })

  it('uses the default schema and an empty plugin list when they are omitted', () => {
    const withDefaults: any = new Client({ apiKey: API_KEY })
    expect(withDefaults._config.apiKey).toBe(API_KEY)

    // a schema with no apiKey skips the fatal-apiKey check, and a schema with no
    // onError/onBreadcrumb/onSession keys leaves those callback lists empty
    const minimalSchema = { appVersion: { defaultValue: () => undefined, validate: () => true } }
    const minimal: any = new Client({}, minimalSchema, undefined, notifier)
    expect(minimal._config.appVersion).toBeUndefined()
    expect(minimal._cbs).toStrictEqual({ e: [], s: [], sp: [], b: [] })
  })

  describe('metadata', () => {
    it('adds, gets and clears metadata', () => {
      const { client } = makeClient()
      client.addMetadata('account', { id: 1 })
      client.addMetadata('account', 'name', 'a')
      expect(client.getMetadata('account')).toStrictEqual({ id: 1, name: 'a' })
      expect(client.getMetadata('account', 'id')).toBe(1)
      client.clearMetadata('account', 'id')
      expect(client.getMetadata('account')).toStrictEqual({ name: 'a' })
      client.clearMetadata('account')
      expect(client.getMetadata('account')).toBeUndefined()
    })
  })

  describe('feature flags', () => {
    it('adds, merges and clears flags, and includes them on events', () => {
      const { client, sent } = makeClient()
      client.addFeatureFlag('a', '1')
      client.addFeatureFlags([{ name: 'b', variant: '2' }])
      client.notify(new Error('x'))
      expect(sent[0].events[0].getFeatureFlags()).toStrictEqual([
        { featureFlag: 'a', variant: '1' },
        { featureFlag: 'b', variant: '2' }
      ])
      client.clearFeatureFlag('a')
      client.notify(new Error('y'))
      expect(sent[1].events[0].getFeatureFlags()).toStrictEqual([{ featureFlag: 'b', variant: '2' }])
      client.clearFeatureFlags()
      client.notify(new Error('z'))
      expect(sent[2].events[0].getFeatureFlags()).toStrictEqual([])
    })

    it('defaults a feature flag variant to null', () => {
      const { client, sent } = makeClient()
      client.addFeatureFlag('flag')
      client.notify(new Error('x'))
      expect(sent[0].events[0].getFeatureFlags()).toStrictEqual([{ featureFlag: 'flag' }])
    })
  })

  describe('context, grouping and user', () => {
    it('gets and sets context', () => {
      const { client } = makeClient()
      expect(client.getContext()).toBeUndefined()
      client.setContext('ctx')
      expect(client.getContext()).toBe('ctx')
    })

    it('gets and sets the grouping discriminator, ignoring invalid types', () => {
      const { client } = makeClient()
      expect(client.getGroupingDiscriminator()).toBeUndefined()
      expect(client.setGroupingDiscriminator('g')).toBeUndefined()
      expect(client.getGroupingDiscriminator()).toBe('g')
      expect(client.setGroupingDiscriminator(123 as any)).toBe('g')
      expect(client.getGroupingDiscriminator()).toBe('g')
      client.setGroupingDiscriminator(null)
      expect(client.getGroupingDiscriminator()).toBeNull()
    })

    it('gets and sets the user', () => {
      const { client } = makeClient()
      expect(client.getUser()).toStrictEqual({})
      client.setUser('id', 'e', 'n')
      expect(client.getUser()).toStrictEqual({ id: 'id', email: 'e', name: 'n' })
    })
  })

  describe('callbacks', () => {
    it('adds and removes error callbacks', () => {
      const { client } = makeClient()
      const cb = jest.fn()
      client.addOnError(cb)
      client.removeOnError(cb)
      client.notify(new Error('x'))
      expect(cb).not.toHaveBeenCalled()
    })

    it('adds and removes breadcrumb callbacks', () => {
      const { client } = makeClient()
      const cb = jest.fn()
      client.addOnBreadcrumb(cb)
      client.leaveBreadcrumb('a')
      expect(cb).toHaveBeenCalled()
      client.removeOnBreadcrumb(cb)
      cb.mockClear()
      client.leaveBreadcrumb('b')
      expect(cb).not.toHaveBeenCalled()
    })

    it('can prepend a breadcrumb callback to the list', () => {
      const { client } = makeClient()
      const a = jest.fn()
      const b = jest.fn()
      client.addOnBreadcrumb(a)
      client.addOnBreadcrumb(b, true)
      expect(client._cbs.b).toStrictEqual([b, a])
    })

    it('adds and removes session callbacks without them ever firing', () => {
      const { client } = makeClient()
      const cb = jest.fn()
      client.addOnSession(cb)
      client.removeOnSession(cb)
      expect(cb).not.toHaveBeenCalled()
    })

    it('registers internal session payload callbacks', () => {
      const { client } = makeClient()
      const fn = jest.fn()
      client._addOnSessionPayload(fn)
      expect(client._cbs.sp).toContain(fn)
    })
  })

  describe('breadcrumbs', () => {
    it('coerces bad values and defaults the type to manual', () => {
      const { client } = makeClient()
      client.leaveBreadcrumb(123 as any, null, 'nonsense' as any)
      expect(client._breadcrumbs).toHaveLength(0)
      client.leaveBreadcrumb('ok', null, 'nonsense' as any)
      expect(client._breadcrumbs[0].type).toBe('manual')
      expect(client._breadcrumbs[0].metadata).toStrictEqual({})
    })

    it('drops breadcrumbs when an onBreadcrumb callback returns false', () => {
      const { client } = makeClient({ onBreadcrumb: () => false })
      client.leaveBreadcrumb('a')
      expect(client._breadcrumbs).toHaveLength(0)
    })

    it('caps the breadcrumb buffer at maxBreadcrumbs', () => {
      const { client } = makeClient({ maxBreadcrumbs: 2 })
      client.leaveBreadcrumb('a')
      client.leaveBreadcrumb('b')
      client.leaveBreadcrumb('c')
      expect(client._breadcrumbs.map((b: any) => b.message)).toStrictEqual(['b', 'c'])
    })

    it('reports whether a breadcrumb type is enabled', () => {
      const { client } = makeClient({ enabledBreadcrumbTypes: ['manual'] })
      expect(client._isBreadcrumbTypeEnabled('manual')).toBe(true)
      expect(client._isBreadcrumbTypeEnabled('log')).toBe(false)
    })
  })

  describe('notify', () => {
    it('sends handled events with warning severity', () => {
      const { client, sent } = makeClient()
      client.notify(new Error('x'))
      expect(sent).toHaveLength(1)
      expect(sent[0].events[0].severity).toBe('warning')
    })

    it('tolerates non-error inputs', () => {
      const { client, sent } = makeClient()
      client.notify('a string' as any)
      client.notify(42 as any)
      client.notify(true as any)
      client.notify(null as any)
      client.notify((() => {}) as any)
      expect(sent.map((p: any) => p.events[0].errors[0].errorClass)).toStrictEqual([
        'Error', 'Error', 'Error', 'InvalidError', 'InvalidError'
      ])
    })

    it('does not send when an onError callback returns false', () => {
      const { client, sent } = makeClient()
      client.notify(new Error('x'), () => false)
      expect(sent).toHaveLength(0)
    })

    it('logs and continues when an onError callback throws', () => {
      const error = jest.fn()
      const { client, sent } = makeClient({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error } })
      client.notify(new Error('x'), () => { throw new Error('cb') })
      expect(error).toHaveBeenCalledWith('Error occurred in onError callback, continuing anyway…')
      expect(sent).toHaveLength(1)
    })

    it('marks the severity reason when a callback changes severity', () => {
      const { client, sent } = makeClient()
      client.notify(new Error('x'), (event: any) => { event.severity = 'info' })
      expect(sent[0].events[0].severity).toBe('info')
      expect(sent[0].events[0]._handledState.severityReason).toStrictEqual({ type: 'userCallbackSetSeverity' })
    })

    it('records unhandledOverridden when a callback changes unhandled', () => {
      const { client, sent } = makeClient()
      client.notify(new Error('x'), (event: any) => { event.unhandled = true })
      expect(sent[0].events[0]._handledState.severityReason.unhandledOverridden).toBe(true)
      expect(sent[0].events[0]._handledState.unhandled).toBe(true)
    })

    it('attaches the active session to the event and tracks it', () => {
      const { client, sent } = makeClient()
      client._session = new Session()
      client.notify(new Error('x'))
      expect(sent[0].events[0]._session).toBe(client._session)
      expect(client._session.toJSON().events.handled).toBe(1)
    })

    it('does not send when the release stage is disabled', () => {
      const { client, sent } = makeClient({ releaseStage: 'production', enabledReleaseStages: ['staging'] })
      client.notify(new Error('x'))
      expect(sent).toHaveLength(0)
    })
  })

  describe('sessions (not exposed, but bundled)', () => {
    it('runs onSession callbacks and can be cancelled by one', () => {
      const { client } = makeClient({ onSession: () => false })
      expect(client.startSession()).toBe(client)
    })

    it('throws when started without a session delegate', () => {
      const { client } = makeClient()
      expect(() => client.startSession()).toThrow()
    })

    it('throws for pauseSession and resumeSession without a session delegate', () => {
      const { client } = makeClient()
      expect(() => client.pauseSession()).toThrow()
      expect(() => client.resumeSession()).toThrow()
    })
  })

  describe('plugins', () => {
    it('loads named plugins and exposes their result', () => {
      const { client } = makeClient({}, [{ name: 'foo', load: () => 42 }])
      expect(client.getPlugin('foo')).toBe(42)
    })

    it('loads unnamed plugins without storing a result', () => {
      const load = jest.fn()
      makeClient({}, [{ load }])
      expect(load).toHaveBeenCalled()
    })

    it('skips falsy entries in the internal plugin list', () => {
      const { client } = makeClient({}, [null, undefined, { name: 'ok', load: () => 7 }])
      expect(client.getPlugin('ok')).toBe(7)
    })
  })

  describe('config validation', () => {
    it('throws without an api key', () => {
      expect(() => new Client({}, schema, [], notifier)).toThrow('No Bugsnag API Key set')
    })

    it('warns about a malformed api key but still starts', () => {
      const warn = jest.fn()
      const client = new Client({ apiKey: 'not-hex', logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() } }, schema, [], notifier)
      expect(client._config.apiKey).toBe('not-hex')
      expect(warn).toHaveBeenCalled()
    })

    it('applies defaults when options are omitted', () => {
      const { client } = makeClient()
      const c = client._config
      expect(c.appVersion).toBeUndefined()
      expect(c.autoDetectErrors).toBe(true)
      expect(c.enabledErrorTypes).toStrictEqual({ unhandledExceptions: true, unhandledRejections: true })
      expect(c.onError).toStrictEqual([])
      expect(c.maxBreadcrumbs).toBe(25)
      expect(c.context).toBeUndefined()
      expect(c.user).toStrictEqual({})
      expect(c.metadata).toStrictEqual({})
      expect(c.redactedKeys).toStrictEqual(['password'])
      expect(c.plugins).toStrictEqual([])
      expect(c.featureFlags).toStrictEqual([])
      expect(c.reportUnhandledPromiseRejectionsAsHandled).toBe(false)
      expect(c.sendPayloadChecksums).toBe(true)
    })

    it('merges partial enabledErrorTypes with the defaults', () => {
      const { client } = makeClient({ enabledErrorTypes: { unhandledRejections: false } })
      expect(client._config.enabledErrorTypes).toStrictEqual({ unhandledExceptions: true, unhandledRejections: false })
    })

    it('falls back to defaults and warns for invalid options', () => {
      const warn = jest.fn()
      const { client } = makeClient({
        logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() },
        appVersion: 123,
        enabledErrorTypes: { nope: true },
        onError: 'nope',
        endpoints: { notify: 'https://x' },
        enabledReleaseStages: [1],
        releaseStage: 1,
        maxBreadcrumbs: 101,
        enabledBreadcrumbTypes: ['nope'],
        context: 1,
        user: { nope: 1 },
        metadata: 'nope',
        logger2: undefined,
        redactedKeys: [1],
        plugins: [{}],
        featureFlags: [{}]
      } as any)
      expect(warn).toHaveBeenCalled()
      expect(client._config.appVersion).toBeUndefined()
      expect(client._config.maxBreadcrumbs).toBe(25)
      expect(client._config.endpoints).toStrictEqual({ notify: null, sessions: null })
    })

    it('rejects non-object and non-boolean enabledErrorTypes', () => {
      const warn = jest.fn()
      makeClient({ logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() }, enabledErrorTypes: 'nope' } as any)
      makeClient({ logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() }, enabledErrorTypes: { unhandledExceptions: 'yes' } } as any)
      expect(warn).toHaveBeenCalled()
    })

    it('short-circuits enabledBreadcrumbTypes validation once a bad entry is found', () => {
      const warn = jest.fn()
      const { client } = makeClient({
        logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() },
        enabledBreadcrumbTypes: ['nope', 'log']
      } as any)
      expect(warn).toHaveBeenCalled()
      expect(client._config.enabledBreadcrumbTypes).toStrictEqual(
        expect.arrayContaining(['log', 'manual'])
      )
    })

    it('validates the remaining boolean and list options', () => {
      const warn = jest.fn()
      const { client } = makeClient({
        logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() },
        autoTrackSessions: false,
        enabledBreadcrumbTypes: ['log', 'nope'],
        reportUnhandledPromiseRejectionsAsHandled: 'nope'
      } as any)
      expect(warn).toHaveBeenCalled()
      expect(client._config.autoTrackSessions).toBe(false)
      expect(client._config.reportUnhandledPromiseRejectionsAsHandled).toBe(false)
    })

    it('accepts a fully valid configuration', () => {
      const { client } = makeClient({
        appVersion: '1.2.3',
        enabledErrorTypes: { unhandledExceptions: true, unhandledRejections: true },
        onError: [() => true],
        onBreadcrumb: [() => true],
        onSession: [() => true],
        endpoints: { notify: 'https://n', sessions: 'https://s' },
        enabledReleaseStages: ['production'],
        releaseStage: 'production',
        maxBreadcrumbs: 10,
        enabledBreadcrumbTypes: null,
        context: 'ctx',
        user: { id: 'u', email: 'e', name: 'n' },
        metadata: { a: { b: 1 } },
        redactedKeys: ['x', /y/],
        plugins: [{ load: () => {} }],
        featureFlags: [{ name: 'f' }],
        reportUnhandledPromiseRejectionsAsHandled: true
      })
      expect(client._config.appVersion).toBe('1.2.3')
      expect(client._config.user).toStrictEqual({ id: 'u', email: 'e', name: 'n' })
    })

    it('uses the secondary endpoints for api keys beginning with 00000', () => {
      const client = new Client({ apiKey: '00000000000000000000000000000000' }, schema, [], notifier)
      expect(client._config.endpoints).toStrictEqual({
        notify: 'https://notify.bugsnag.smartbear.com',
        sessions: 'https://sessions.bugsnag.smartbear.com'
      })
    })

    it('stringifies unusual config values in the error message', () => {
      // a function value exercises the default branch of the internal stringify
      expect(() => makeClient({ appVersion: (() => {}) as any })).not.toThrow()
    })
  })
})
