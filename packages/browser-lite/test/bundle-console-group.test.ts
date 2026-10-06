// The console-breadcrumbs plugin hard-codes the console methods it wraps
// (log/debug/info/warn/error), none of which start with "group", so the
// `method.indexOf('group') === 0` severity branch is normally unreachable.
// Replacing the internal filter lets us wrap a `group` method and pin that
// branch. This file is isolated so the mock does not leak into other suites.
jest.mock('@bugsnag/core/lib/es-utils/filter', () => () => ['group'])

const plugin = require('@bugsnag/plugin-console-breadcrumbs')

describe('plugin-console-breadcrumbs group methods', () => {
  const realGroup = (console as any).group

  afterEach(() => {
    if (realGroup === undefined) {
      delete (console as any).group
    } else {
      (console as any).group = realGroup
    }
  })

  it('reports group console output with log severity', () => {
    const calls: any[] = []
    ;(console as any).group = (...args: any[]) => { calls.push(args) }

    const leaveBreadcrumb = jest.fn()
    const client = { _config: { releaseStage: 'production' }, _isBreadcrumbTypeEnabled: () => true, leaveBreadcrumb }

    plugin.load(client)
    ;(console as any).group('hello', 'world')

    expect(leaveBreadcrumb).toHaveBeenCalledWith(
      'Console output',
      { '[0]': 'hello', '[1]': 'world', severity: 'log' },
      'log'
    )
    expect(calls).toStrictEqual([['hello', 'world']])

    plugin.destroy()
  })
})
