# `@mrhenry/browser-lite` — Behaviour Specification

This document describes **how `browser-lite` currently works**, as implemented
in the single self-contained `src/bugsnag.js` bundle.

It is a description of the present, not a wishlist. Where the current behaviour
conflicts with the stated intent of the package, that is called out under
[Known behaviours and gaps](#known-behaviours-and-gaps).

Upstream references:

- Bugsnag documentation: <https://docs.bugsnag.com>
- Bugsnag error-reporting payload: <https://docs.bugsnag.com/api/error-reporting/>
- Bugsnag JavaScript configuration: <https://docs.bugsnag.com/platforms/javascript/configuration-options/>
- Bugsnag source: <https://github.com/bugsnag/bugsnag-js>

## 1. Purpose and scope

`browser-lite` is a fork of `@bugsnag/browser` with a deliberately reduced
surface. It is a **minimal error reporter** for browser JavaScript.

### 1.1 What it is for (in scope)

- Capturing uncaught exceptions (`window.onerror`) and unhandled promise
  rejections (`unhandledrejection`).
- Manually reporting errors via `notify()`.
- Knowing which page an error happened on (context / request URL).
- Knowing when an error happened (absolute send time).
- Knowing the window size and the browser make-up (user agent, locale,
  orientation).

### 1.2 What it deliberately does not do (out of scope)

- No sessions. There is no session tracking, no `startSession` / `pauseSession`
  / `resumeSession`, and no session payloads.
- No user identity collection. There is no `user` option, `getUser`/`setUser`,
  or `user` field in the payload.
- No feature flags. There is no `featureFlags` option, feature-flag API, or
  `featureFlags` field in the payload.
- No breadcrumbs of any kind: no manual, console, navigation, interaction,
  network, or inline-script breadcrumbs.
- No trace correlation or grouping discriminator.
- No location/geo information. The `plugin-client-ip` is not loaded, so
  `collectUserIp` is not part of the configuration schema.
- No Electron, React Native, Node, Angular, Vue, or Cloudflare Workers support.

### 1.3 Reduced feature set relative to `@bugsnag/browser`

There is **no plugin system**. All automatic behaviour is built in and wired up
directly when a client is created:

| Behaviour | Built in |
| --- | --- |
| `window.onerror` capture | yes |
| `unhandledrejection` capture | yes |
| device info (user agent, locale, orientation, window size) | yes |
| context (pathname) | yes |
| request URL | yes |
| event throttling (`maxEvents`) | yes |
| stack-frame query-string stripping | yes |
| XMLHttpRequest delivery | yes |
| breadcrumbs | no |
| sessions | no |
| client IP / geo | no |
| inline-script content | no |
| interaction / navigation / network breadcrumbs | no |
| cross-domain (x-domain) delivery | no |

The `plugins` configuration option and the `getPlugin()` API do not exist.


## 2. Package layout and build

```
packages/browser-lite/
  src/bugsnag.js       the whole notifier (single self-contained file)
  src/bugsnag.d.ts     type re-export
  types/bugsnag.d.ts   public type surface
  types/global.d.ts    UMD global declaration
  test/                behaviour tests
  dist/                built bundle (git-ignored)
```

- `main`: `dist/bugsnag.js` (unminified bundle)
- `types`: `types/bugsnag.d.ts`
- Build: browserify + babelify + `browserify-versionify` (replaces `__VERSION__`)
  + `envify` (`NODE_ENV=production`), bundled with `browser-pack-flat`, then
  minified with uglify (`--compress --mangle --ie8`).
- `bin/size` reports the **gzipped** size of `dist/bugsnag.min.js`.
- The bundle exposes a UMD global named `Bugsnag`.

## 3. Public API

`require('@mrhenry/browser-lite')` returns a static object (the UMD global
`Bugsnag`). It has a `default` property that points at itself for ESM interop.

### 3.1 Explicit static methods

| Method | Behaviour |
| --- | --- |
| `Bugsnag.start(apiKeyOrOpts)` | Creates the singleton client if not already started and returns it. Calling it again logs a warning (`Bugsnag.start() was called more than once. Ignoring.`) and returns the existing client. |
| `Bugsnag.createClient(apiKeyOrOpts)` | Always creates and returns a new client. A string argument is treated as `{ apiKey }`. |
| `Bugsnag.isStarted()` | Returns `true` once `start()` has been called. |

### 3.2 Delegated static methods

After the static object is defined, every enumerable method on
`Client.prototype` (plus `resetEventCount`, minus names starting with `_`) is
copied onto the static object as a thin wrapper. The wrapper:

1. If the client has not been started, logs
   `Bugsnag.<method>() was called before Bugsnag.start()` to `console.log` and
   returns `undefined`.
2. Otherwise increments `client._depth`, calls the method with the static
   object's `this` bound to the client, decrements `_depth`, and returns the
   result.

This makes the following available (non-exhaustive): `notify`, `addMetadata`,
`getMetadata`, `clearMetadata`, `getContext`, `setContext`, `addOnError`,
`removeOnError`, `resetEventCount`.

### 3.3 Methods that do not exist

Sessions are not supported. `startSession`, `pauseSession`, `resumeSession`,
`addOnSession` and `removeOnSession` are not defined anywhere, so they are
`undefined` on both the client and the static object; calling one throws
`TypeError: Bugsnag.startSession is not a function`.

There is no plugin system, so `getPlugin` is likewise undefined. There are no
feature-flag or user methods (`addFeatureFlag`, `addFeatureFlags`,
`clearFeatureFlag`, `clearFeatureFlags`, `getUser`, `setUser`). There are no
breadcrumb methods (`leaveBreadcrumb`, `addOnBreadcrumb`,
`removeOnBreadcrumb`), and no grouping-discriminator or trace-correlation
methods (`getGroupingDiscriminator`, `setGroupingDiscriminator`,
`setTraceCorrelation`).

### 3.4 Non-functions / internals

`_client` is the singleton client (or `null`). `Client` and `Event` are attached
to each client instance (`client.Event`, etc.) but are not exported by
`browser-lite` (unlike `@bugsnag/browser`, which also exports `Client`, `Event`,
`Session`, `Breadcrumb` as module properties).

## 4. Configuration

Configuration is validated against a single schema defined in `src/bugsnag.js`.

Unknown keys are ignored. An invalid value produces a warning log and falls back
to that option's default. A missing/invalid `apiKey` is fatal: the constructor
throws `Error: No Bugsnag API Key set`.

### 4.1 Options

| Option | Default in browser-lite | Notes |
| --- | --- | --- |
| `apiKey` | `null` | Required. If not 32 hex chars, warns `should be a string of 32 hexadecimal characters` but still starts. |
| `appVersion` | `undefined` | Sent as `event.app.version`. |
| `appType` | `'browser'` | browser-lite override. Sent as `event.app.type`. |
| `autoDetectErrors` | `true` | Gates `onerror` and `unhandledrejection` handlers. |
| `enabledErrorTypes` | `{ unhandledExceptions: true, unhandledRejections: true }` | Partial objects are merged with defaults. Gates each handler. |
| `onError` | `[]` | Function or array. Can return `false` to cancel sending. |
| `endpoints` | `{ notify: 'https://notify.bugsnag.com' }` | If supplied, `notify` must be a non-empty string and no other keys are allowed, otherwise the value is invalid and delivery is disabled (`notify: null`). |
| `enabledReleaseStages` | `null` | When non-null, events whose `releaseStage` is not included are not sent. |
| `releaseStage` | `'development'` when `location.host` matches `/^localhost(:\d+)?$/`, otherwise `'production'` | browser-lite override. |
| `context` | `undefined` | Default context comes from `location.pathname` (see §7). |
| `metadata` | `{}` | Sent as `event.metaData`. |
| `logger` | prefixed `console` if `console.debug` exists, else `undefined` | browser-lite override. Logs prefixed with `[bugsnag]`. |
| `redactedKeys` | `['password']` | Strings or regexes; used by the JSON serialiser to redact matching keys. |
| `reportUnhandledPromiseRejectionsAsHandled` | `false` | When `true`, unhandled rejections are sent with `unhandled: false`. |
| `maxEvents` | `10` | Per-client-instance cap. See §11. |

### 4.2 Options that are **not** part of browser-lite

The following upstream `@bugsnag/browser` options are neither in the schema nor
in the type surface, so passing them has no effect:

- `collectUserIp` (would come from `plugin-client-ip`)
- `generateAnonymousId` (would come from `plugin-browser-device`)
- `trackInlineScripts` (would come from `plugin-inline-script-content`)
- `user` / `featureFlags` (user identity and feature flags have been removed)
- `onBreadcrumb` / `maxBreadcrumbs` / `enabledBreadcrumbTypes` (breadcrumbs have
  been removed)
- `sendPayloadChecksums` (payload checksums have been removed)
- `onSession` / `autoTrackSessions` / `plugins` (removed with sessions/plugins)

## 5. Client creation and startup

`createClient`:

1. Normalises a string argument to `{ apiKey }` and a missing argument to `{}`.
2. Constructs a `Client`, which validates config, elevates `metadata`, `context`
   and `logger`, and registers `onError` callbacks.
3. Wires up automatic behaviour in this order: device, context, request,
   throttle, strip-query-string, window-onerror, unhandled-rejection.
4. Sets the delivery mechanism to XMLHttpRequest.
5. Logs `Loaded!` at debug level.

`start` stores the client as the singleton. There is no session to auto-start.

## 6. Automatic error capture

### 6.1 `window.onerror`

Built in (no plugin). If `autoDetectErrors` and
`enabledErrorTypes.unhandledExceptions` are both true, it replaces
`window.onerror`. Two argument shapes are handled:

- **Modern**: a 5th `error` argument is present → the error is used directly and
  the first stack frame is decorated with `url`, `lineNo`, `charNo`.
- **Legacy**: no error argument → an `Error` is created from the message string
  and the stack is decorated.

Events from `onerror` are marked:

```
severity: 'error'
unhandled: true
severityReason: { type: 'unhandledException' }
```

`Script error.` at line 0 (CORS / cross-domain) is ignored with the warning
`Ignoring cross-domain or eval script error...`.

The previously installed `window.onerror` is always called afterwards, inside a
`try/catch`.

### 6.2 `unhandledrejection`

Built in (no plugin). Gated by `autoDetectErrors` and
`enabledErrorTypes.unhandledRejections`. It registers an
`addEventListener('unhandledrejection', …)` listener.

- The reason is `event.reason`.
- `unhandled` is `!reportUnhandledPromiseRejectionsAsHandled` (so `true` by
  default).
- `severity: 'error'`, `severityReason: { type: 'unhandledPromiseRejection' }`.
- If the original reason is a non-`Error` object without a stack, its
  name/message/code are added as metadata under the `unhandledRejection handler`
  section.

### 6.3 `enabledReleaseStages`

In `_notify`, before delivery, if `enabledReleaseStages` is non-null and does not
include the current `releaseStage`, the event is dropped with a warning.

## 7. Manual reporting (`notify`)

`Bugsnag.notify(maybeError, onError?, postReportCallback?)`.

- `maybeError` is used directly when it is an `Error`; anything else is coerced
  to an `Error` whose message is `String(maybeError)`.
- Events from `notify()` are handled by default:
  `severity: 'warning'`, `unhandled: false`,
  `severityReason: { type: 'handledException' }`.
- `notify()` returns `undefined` (`void`). This is by design and matches upstream
  `@bugsnag/browser` — `Client.prototype.notify` has no return value
  (`packages/core/types/client.d.ts` declares it `: void`). Use the
  `postReportCallback` argument if the event/result is needed.
- The per-call `onError` callback is appended to the configured `onError`
  callbacks. Returning `false` cancels sending.
- If an `onError` callback changes severity, `severityReason` becomes
  `{ type: 'userCallbackSetSeverity' }`.
- If an `onError` callback changes `event.unhandled`, the original unhandled
  state is preserved in `severityReason.unhandledOverridden`.

## 8. Event payload

The wire payload sent to the notify endpoint is:

```json
{
  "apiKey": "<api key>",
  "notifier": { "name": "Bugsnag JavaScript", "version": "<version>", "url": "https://github.com/bugsnag/bugsnag-js" },
  "events": [ <event> ]
}
```

An event serialises (`Event.toJSON`) to:

| Field | Source |
| --- | --- |
| `payloadVersion` | `"4"` |
| `exceptions[]` | `errorClass`, `errorMessage`, `message`, `type: "browserjs"`, `stacktrace[]` |
| `severity` | `warning` (handled) / `error` (unhandled) |
| `unhandled` | from handled state |
| `severityReason` | see §6/§7 |
| `app` | `{ releaseStage, version, type }` |
| `device` | see below |
| `request` | `{ url }` (and anything the user added) |
| `context` | see §10 |
| `metaData` | client metadata merged with event metadata |

Each stack frame is `{ file, method, lineNumber, columnNumber, code, inProject }`.
Frames with no usable data are dropped. `method` defaults to `global code` when
a frame has a line number but no file/function.

### 8.1 Device fields

Built in, at the moment the event is sent:

- `userAgent`: `navigator.userAgent`
- `locale`: `navigator.language`
- `orientation`: `screen.orientation.type` if present, else `landscape`/`portrait`
  from `documentElement.clientWidth` vs `clientHeight`
- `windowWidth`: `window.innerWidth`
- `windowHeight`: `window.innerHeight`
- `time`: `new Date()` (captured as the event is sent)

There is deliberately **no** `id` and **no** anonymous id: browser-lite does not
generate or persist a device identifier.

> The Bugsnag dashboard renders a fixed set of `device` fields; custom keys such
> as `windowWidth`/`windowHeight` are carried in the payload but may not be
> shown in the UI. If dashboard display is required, mirror them into
> `metaData` via an `onError` callback.

## 9. Breadcrumbs

Breadcrumbs have been removed entirely. There is no `leaveBreadcrumb`, no
`onBreadcrumb` callback, no `maxBreadcrumbs` / `enabledBreadcrumbTypes`
configuration, no automatic console/state/error breadcrumbs, and no
`breadcrumbs[]` field in the payload.

## 10. Page / context / request

- The notifier sets `event.context = location.pathname` unless the event already
  has a context (e.g. set via `setContext` or config).
- It sets `event.request.url = location.href` unless the event already has a
  request URL.
- It removes `?...` and `#...` from **stack frame file paths only**. It does
  **not** strip the query string from `request.url`.

## 11. Throttling

The notifier adds an `onError` hook that counts sent events for the life of the
client. Once `n >= maxEvents` (default 10), further events are cancelled with the
warning `Cancelling event send due to maxEvents limit of <n> being reached`.
`resetEventCount()` resets the counter. The cap is per client instance, not per
page load.

## 12. Delivery

Delivery sends the event as a POST via `XMLHttpRequest`:

- URL: `config.endpoints.notify`.
- If `endpoints.notify` is `null` (invalid/missing custom endpoints), the send is
  aborted and the callback receives
  `Error: Event not sent due to incomplete endpoint configuration`.
- Headers: `Content-Type: application/json`, `Bugsnag-Api-Key`,
  `Bugsnag-Payload-Version: 4`, `Bugsnag-Sent-At` (ISO 8601).
- The body is serialised with `@bugsnag/safe-json-stringify` using
  `redactedKeys` (redaction applies within `metaData` and `request`).
- A payload larger than 1 MB triggers a metadata-stripping retry and a warning.
- Response handling: status `0` or `>= 400` logs `Event failed to send…` and
  calls the callback with an error; otherwise the callback receives `null`.
- There is **no retry/backoff**.

## 13. Privacy and data handling

- `redactedKeys` (default `['password']`) redacts matching keys in the payload.
- Query strings are stripped from stack frame file paths.
- No session, no IP, no geo, no breadcrumbs.
- **No device or user identifier.** The notifier generates no anonymous id,
  writes nothing to `localStorage`, and sends no user field. There is no
  cross-session identifier.

## 14. Known behaviours and gaps

These are current behaviours that conflict with, or are worth deciding on
relative to, the package's stated intent:

1. **`request.url` keeps its query string and fragment.** `location.href` is sent
   verbatim; only stack frames are stripped of query strings. Query strings often
   contain tokens, emails and identifiers.
2. **`maxEvents` is per client instance**, not per page load; a long-lived page
   stops reporting after 10 events until `resetEventCount()` is called.
3. **No retry** on failed delivery.
4. **Custom `device` fields may not render in the dashboard.** The window size is
   sent as `device.windowWidth` / `device.windowHeight`; the dashboard shows a
   fixed set of device fields, so mirror into `metaData` if UI display is needed.

The following previously listed conflicts have been resolved by this fork:

- ~~Anonymous device/user id persisted in `localStorage` and copied to
  `user.id`~~ — the notifier generates no identifier.
- ~~Window size not reported~~ — now sent as `device.windowWidth` /
  `device.windowHeight`.
- ~~Sessions accepted but inert~~ — sessions have been removed entirely.
- ~~A plugin system and secondary SmartBear endpoint mapping existed~~ — both
  have been removed.
- ~~Feature flags and user identity were part of the payload~~ — both have been
  removed.
- ~~Breadcrumbs (manual, console, automatic) were collected~~ — breadcrumbs have
  been removed entirely.
- ~~Payload checksums, trace correlation and grouping discriminator existed~~ —
  all have been removed.

## 15. Testing

Tests live in `test/` and run as part of the root `browser` Jest project
(`jest.config.js`). They exercise the package through its public API with a
mocked `XMLHttpRequest` and the jsdom environment
(`jest/FixJSDOMEnvironment.js`).

- `test/index.test.ts` — baseline suite (startup, notify, config validation,
  session API absence).
- `test/behaviour.test.ts` — behaviour driven by the stated intent: bootstrap
  and event enrichment, automatic capture (`onerror`, `unhandledrejection`,
  CORS, `autoDetectErrors`, `enabledErrorTypes`), manual reporting and
  callbacks, metadata, context/request/page, timing, device/browser
  (including window size and the absence of an anonymous id), throttling,
  delivery/payload (endpoints, redaction, release stages), and configuration
  defaults.
- `test/client.test.ts` — client metadata, context, callbacks and
  configuration.
- `test/events.test.ts` — event normalisation, handled state, onError callback
  forms, stacktrace parsing and payload serialisation.
- `test/plugins.test.ts` — automatic capture: `window.onerror`,
  `unhandledrejection`, context/request and device.
- `test/delivery.test.ts` — payload, release stages, throttling and delivery
  failures.

### 15.1 Coverage

`jest.coverage.config.js` instruments the single source file and runs only the
browser-lite tests. Run it with:

```
npx jest --config packages/browser-lite/jest.coverage.config.js --coverage
```

Coverage is high but not 100%: a few defensive `catch` branches are not
exercised.

Notes for writing tests here:

- jsdom's default location is `http://localhost/`, so the default `releaseStage`
  in tests is `development` unless a test sets `releaseStage` explicitly.
- The notifier attaches a `window` `unhandledrejection` listener. Tests must
  remove listeners after each case (see the `afterEach` in
  `test/behaviour.test.ts`).
- The default logger prefixes every message with `[bugsnag]`, so log assertions
  match on `('[bugsnag]', expect.stringContaining(...))`.

## 16. Consumer integration

`test/behaviour.test.ts` pins the way an embedding application integrates the
package, which is representative of production usage:

### 16.1 Integration contract

- A shared wrapper creates the client with `createClient({...})` at module
  evaluation time and exposes it (for example as a window global). It does
  **not** call `start`, so `isStarted()` stays `false` and callers use the
  returned client rather than the delegated static methods.
- Application code never imports `@bugsnag/*` or the package's internals
  directly; it goes through the wrapper or the exposed client.
- The client is bundled into the application's own JavaScript; there is no CDN
  load at runtime.

### 16.2 Config used by the wrapper

A small set of options: `apiKey`, `appType`, an `enabledReleaseStages`
allow-list, `releaseStage`, and an `onError` callback. `endpoints`,
`appVersion`, `redactedKeys`, and metadata are left at their defaults.

### 16.3 `onError` enrichment

The callback appends a suffix to `event.context` and adds metadata sections
(for example `site: { id, app }` and `bundle: { target }`), guarding against
absent values.

### 16.4 API surface used by applications

- `client.notify(err)` — always a single `Error` argument.
- `client.addMetadata(section, {...})` — attaching flow identifiers that persist
  onto later reports.
- No breadcrumbs, user, feature flags, sessions, or plugins are used from
  application code (all of those features have been removed).
- Most consumers never call the API at all and rely entirely on the automatic
  `window.onerror` / `unhandledrejection` capture.

### 16.5 Legacy options

An earlier published build had `generateAnonymousId` active (a persistent
`localStorage` id used as `user.id`), while `collectUserIp` and
`autoTrackSessions` were inert. In this fork those options are ignored: no
anonymous id, no `localStorage` write, no user field, and no sessions. The tests
assert that the legacy options are accepted and ignored.

### 16.6 Out of scope (server-side)

Any server-side emission of the config values (API key, release stage, app
identity) and CSP allow-listing are outside the client behaviour described here.
No `appVersion`, `codeBundleId`, or source-map upload is configured.

## 17. Supported browsers

`browser-lite` must run on the browser versions below. A build may target any
one of the named, date-stamped ranges; the runtime must not rely on language or
platform features newer than the range it targets.

| Chrome | Firefox | Safari | Other |
| --- | --- | --- | --- |
| >= 47 | >= 43 | >= 10 | Edge >= 15, Opera >= 42, Samsung >= 5 |
