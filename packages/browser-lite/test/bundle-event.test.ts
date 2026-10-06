// Behaviour of the bundled core Event, including the input-normalisation and
// stacktrace logic that the browser-lite notifier relies on.
const Event = require('@bugsnag/core/event')

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }

describe('core Event', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('Event.create input normalisation', () => {
    it('uses a real Error as-is', () => {
      const err = new Error('boom')
      const event: any = Event.create(err, true, undefined, 'notify()')
      expect(event.errors[0].errorClass).toBe('Error')
      expect(event.errors[0].errorMessage).toBe('boom')
      expect(event.originalError).toBe(err)
    })

    it('coerces strings, numbers and booleans to errors', () => {
      expect(Event.create('s', true, undefined, 'notify()').errors[0].errorMessage).toBe('s')
      expect(Event.create(1, true, undefined, 'notify()').errors[0].errorMessage).toBe('1')
      expect(Event.create(false, true, undefined, 'notify()').errors[0].errorMessage).toBe('false')
    })

    it('treats functions as invalid errors and records metadata', () => {
      const event: any = Event.create(() => {}, true, undefined, 'notify()', 0, logger)
      expect(event.errors[0].errorClass).toBe('InvalidError')
      expect(event.getMetadata('notify()', 'non-error parameter')).toBeDefined()
      expect(logger.warn).toHaveBeenCalled()
    })

    it('treats null and unsupported objects as invalid errors', () => {
      expect(Event.create(null, true, undefined, 'notify()').errors[0].errorClass).toBe('InvalidError')
      expect(Event.create({}, true, undefined, 'notify()').errors[0].errorClass).toBe('InvalidError')
    })

    it('treats undefined as an invalid error', () => {
      expect(Event.create(undefined, true, undefined, 'notify()').errors[0].errorClass).toBe('InvalidError')
    })

    it('accepts error-like objects with name/message', () => {
      const event: any = Event.create({ name: 'Custom', message: 'oops' }, true, undefined, 'notify()')
      expect(event.errors[0].errorClass).toBe('Custom')
      expect(event.errors[0].errorMessage).toBe('oops')
    })

    it('accepts error-like objects with errorClass/errorMessage', () => {
      const event: any = Event.create({ errorClass: 'C', errorMessage: 'm' }, true, undefined, 'notify()')
      expect(event.errors[0].errorClass).toBe('C')
      expect(event.errors[0].errorMessage).toBe('m')
    })

    it('rejects non-errors when tolerateNonErrors is false', () => {
      const event: any = Event.create('nope', false, undefined, 'notify()')
      expect(event.errors[0].errorClass).toBe('InvalidError')
    })

    it('includes the cause chain as additional exceptions', () => {
      const cause = new Error('inner')
      const err: any = new Error('outer')
      err.cause = cause
      const event: any = Event.create(err, true, undefined, 'notify()')
      expect(event.errors).toHaveLength(2)
      expect(event.errors[1].errorMessage).toBe('inner')
    })

    it('handles non-error causes', () => {
      const err: any = new Error('outer')
      err.cause = 'a string'
      const event: any = Event.create(err, true, undefined, 'notify()')
      expect(event.errors.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('stacktrace formatting', () => {
    it('marks a bare frame with a line number as global code', () => {
      const event: any = new Event('Error', 'x', [{ lineNumber: 1 }])
      expect(event.errors[0].stacktrace[0].file).toBe('global code')
    })

    it('handles an error without a stack', () => {
      const err: any = new Error('nostack')
      delete err.stack
      const event: any = Event.create(err, true, undefined, 'notify()')
      expect(event.errors[0].errorMessage).toBe('nostack')
    })

    it('parses a real error stack', () => {
      const frames = Event.getStacktrace(new Error('x'), 0, 0)
      expect(Array.isArray(frames)).toBe(true)
      expect(frames.length).toBeGreaterThan(0)
    })

    it('falls back to walking the call stack when there is no stack', () => {
      const frames = Event.getStacktrace({}, 0, 0)
      expect(Array.isArray(frames)).toBe(true)
    })

    it('drops frames with no usable data', () => {
      const event: any = new Event('Error', 'x', [{}])
      expect(event.errors[0].stacktrace).toStrictEqual([])
    })
  })

  describe('event data', () => {
    it('gets and sets trace correlation', () => {
      const event: any = new Event('Error', 'x')
      event.setTraceCorrelation('trace', 'span')
      expect(event.toJSON().correlation).toStrictEqual({ traceId: 'trace', spanId: 'span' })
      event.setTraceCorrelation('trace2')
      expect(event.toJSON().correlation).toStrictEqual({ traceId: 'trace2' })
      event.setTraceCorrelation(123 as any)
      expect(event.toJSON().correlation).toStrictEqual({ traceId: 'trace2' })
    })

    it('gets and sets the grouping discriminator', () => {
      const event: any = new Event('Error', 'x')
      expect(event.getGroupingDiscriminator()).toBeUndefined()
      event.setGroupingDiscriminator('g')
      expect(event.getGroupingDiscriminator()).toBe('g')
      event.setGroupingDiscriminator(123 as any)
      expect(event.getGroupingDiscriminator()).toBe('g')
    })

    it('adds, gets and clears metadata', () => {
      const event: any = new Event('Error', 'x')
      event.addMetadata('a', { b: 1 })
      expect(event.getMetadata('a')).toStrictEqual({ b: 1 })
      expect(event.getMetadata('a', 'b')).toBe(1)
      event.clearMetadata('a', 'b')
      expect(event.getMetadata('a')).toStrictEqual({})
    })

    it('adds, merges and clears feature flags', () => {
      const event: any = new Event('Error', 'x')
      event.addFeatureFlag('a', '1')
      event.addFeatureFlags([{ name: 'b' }])
      expect(event.getFeatureFlags()).toStrictEqual([{ featureFlag: 'a', variant: '1' }, { featureFlag: 'b' }])
      event.clearFeatureFlag('a')
      expect(event.getFeatureFlags()).toStrictEqual([{ featureFlag: 'b' }])
      event.clearFeatureFlags()
      expect(event.getFeatureFlags()).toStrictEqual([])
    })

    it('gets and sets the user', () => {
      const event: any = new Event('Error', 'x')
      expect(event.getUser()).toStrictEqual({})
      event.setUser('id', 'e', 'n')
      expect(event.getUser()).toStrictEqual({ id: 'id', email: 'e', name: 'n' })
    })

    it('serialises to the expected payload shape', () => {
      const event: any = new Event('Error', 'x')
      const json = event.toJSON()
      expect(json.payloadVersion).toBe('4')
      expect(json.severity).toBe('warning')
      expect(json.unhandled).toBe(false)
      expect(json.severityReason).toStrictEqual({ type: 'handledException' })
      expect(json.exceptions[0]).toStrictEqual(expect.objectContaining({ errorClass: 'Error', message: 'x' }))
    })
  })
})
