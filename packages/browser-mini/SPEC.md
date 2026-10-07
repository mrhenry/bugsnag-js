# `@mrhenry/browser-mini` — Behaviour Specification

This document describes **how `browser-mini` currently works**, as implemented
in the single self-contained `src/bugsnag.js` bundle.

It is a description of the present, not a wishlist.

Upstream references:

- Bugsnag documentation: <https://docs.bugsnag.com>
- Bugsnag error-reporting payload: <https://docs.bugsnag.com/api/error-reporting/>
- Bugsnag source: <https://github.com/bugsnag/bugsnag-js>

## 1. Purpose and scope

`browser-mini` is a deliberately minimal **error reporter** for browser
JavaScript.

### 1.1 What it is for (in scope)

- Capturing uncaught exceptions (`window.onerror`) and unhandled promise
  rejections (`unhandledrejection`).
- Manually reporting errors via `notify()`.
- Knowing which page an error happened on (context / request URL).
- Knowing when an error happened (absolute send time).
- Knowing the window size and the browser make-up (user agent, locale,
  orientation).

### 1.2 What it deliberately does not do (out of scope)

- No sessions.
- No user identity collection.
- No feature flags.
- No breadcrumbs of any kind (manual, console, navigation, interaction,
  network, inline-script).
- No trace correlation or grouping discriminator.
- No payload checksums / integrity header.
- No location/geo information, no client IP.
- No plugin system.
- No Electron, React Native, Node, Angular, Vue, or Cloudflare Workers support.

## 2. Package layout and build

```
packages/browser-mini/
  src/bugsnag.js       the whole notifier (single ES module, named exports)
  src/bugsnag.d.ts     type re-export
  types/bugsnag.d.ts   public type surface
  test/                behaviour tests
  dist/                built bundle (git-ignored)
```

- `main` / `module`: `dist/bugsnag.js` (unminified ES module)
- `types`: `types/bugsnag.d.ts`
- Build (`build.js`): the source is already a self-contained ES module, so the
  build only substitutes `__VERSION__` with the package version and then
  minifies with uglify
  (`--compress passes=3 --mangle toplevel --mangle-props regex=/^_/ --ie8`).
  No bundling, wrapping or transpilation happens and no runtime/helper bloat is
  introduced. Private (`_`-prefixed) properties are mangled; exported names are
  preserved.
- `bin/size` reports the **gzipped** size of `dist/bugsnag.min.js`.
- There is no UMD/AMD wrapper and nothing is attached to `window`.

## 3. Public API

`@mrhenry/browser-mini` is an ES module. Its public API is a single named
export, `createClient`. There is no default export and no global.

```js
import { createClient } from '@mrhenry/browser-mini'
```

### 3.1 Named exports

| Export | Behaviour |
| --- | --- |
| `createClient(apiKeyOrOpts)` | Creates and returns a new client. A string argument is treated as `{ apiKey }`; a missing argument as `{}`. |

There is no `start()`, no `isStarted()`, and no singleton `_client`. Every
client is created explicitly with `createClient`.

### 3.2 Client methods

| Method | Behaviour |
| --- | --- |
| `client.notify(error)` | Reports an error. Non-`Error` values are coerced. Returns `undefined`. |
| `client.addMetadata(section, obj)` / `(section, key, value)` | Adds client metadata merged onto every subsequent event. |
| `client.addOnError(fn, front?)` | Registers an additional `onError` callback. |
| `client.resetEventCount` | Not defined. The throttle counter is fixed at the build-time `maxEvents`. |

`Client`, `Event` are attached to each client instance (`client.Event`).

### 3.3 Methods that do not exist

There are no session, user, feature-flag, breadcrumb, plugin, metadata-read or
context-setter methods. In particular: `startSession`, `pauseSession`,
`resumeSession`, `addOnSession`, `removeOnSession`, `getPlugin`, `getUser`,
`setUser`, `addFeatureFlag`, `addFeatureFlags`, `clearFeatureFlag`,
`clearFeatureFlags`, `leaveBreadcrumb`, `addOnBreadcrumb`,
`removeOnBreadcrumb`, `getGroupingDiscriminator`, `setGroupingDiscriminator`,
`setTraceCorrelation`, `getMetadata`, `clearMetadata`, `getContext`,
`setContext`, `removeOnError`, `resetEventCount`.

## 4. Configuration

Configuration is validated against a small schema defined in `src/bugsnag.js`.
Unknown keys are ignored. An invalid value produces a warning log and falls back
to that option's default.

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | `null` | Required. If not 32 hex chars, warns `should be a string of 32 hexadecimal characters` but still starts. |
| `appType` | `'browser'` | Sent as `event.app.type`. |
| `onError` | `[]` | Function or array of functions. Return `false` to cancel sending. |
| `enabledReleaseStages` | `null` | When non-null, events whose `releaseStage` is not included are not sent. |
| `releaseStage` | `'development'` when `location.host` matches `/^localhost(:\d+)?$/`, otherwise `'production'` | Sent as `event.app.releaseStage`. |

A missing `apiKey` is fatal: the constructor throws
`Error: No Bugsnag API Key set`.

Everything else is hard-coded:

- `endpoints` — always `https://notify.bugsnag.com`.
- `appVersion` — never sent.
- `redactedKeys` — always `['password']`.
- `maxEvents` — always `10`.
- `autoDetectErrors` / `enabledErrorTypes` — automatic capture is always on for
  both unhandled exceptions and unhandled rejections.
- `reportUnhandledPromiseRejectionsAsHandled` — unhandled rejections are always
  marked `unhandled: true`.
- `metadata` — client metadata is only ever set through `addMetadata`.
- `logger` — a `[bugsnag]`-prefixed `console` logger.

## 5. Client creation and startup

`createClient`:

1. Normalises a string argument to `{ apiKey }` and a missing argument to `{}`.
2. Constructs a `Client`, which validates config and registers `onError`
   callbacks.
3. Wires up automatic behaviour in this order: device, context, request,
   throttle, strip-query-string, window-onerror, unhandled-rejection.
4. Sets XMLHttpRequest delivery.
5. Logs `Loaded!` at debug level.

## 6. Automatic error capture

### 6.1 `window.onerror`

Built in. It always replaces `window.onerror`. Two argument shapes are handled:

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

Built in. It registers an `addEventListener('unhandledrejection', …)` listener.

- The reason is `event.reason`.
- `unhandled: true`, `severity: 'error'`,
  `severityReason: { type: 'unhandledPromiseRejection' }`.
- If the reason is an `Error` without a stack, its name/message/code are added
  as metadata under the `unhandledRejection handler` section.

### 6.3 `enabledReleaseStages`

In `_notify`, before delivery, if `enabledReleaseStages` is non-null and does not
include the current `releaseStage`, the event is dropped with a warning.

## 7. Manual reporting (`notify`)

`client.notify(maybeError)`.

- `maybeError` is used directly when it is an `Error`; anything else is coerced
  to an `Error` whose message is `String(maybeError)`.
- Events from `notify()` are handled by default:
  `severity: 'warning'`, `unhandled: false`,
  `severityReason: { type: 'handledException' }`.
- `notify()` returns `undefined` (`void`).
- Configured `onError` callbacks run in registration order. Returning `false`
  from any callback cancels sending. A callback that throws is logged and
  skipped.
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
| `app` | `{ releaseStage, type }` |
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

There is deliberately **no** `id` and **no** anonymous id.

## 9. Breadcrumbs

Breadcrumbs have been removed entirely.

## 10. Page / context / request

- The notifier sets `event.context = location.pathname` unless the event already
  has a context (e.g. set in an `onError` callback).
- It sets `event.request.url = location.href` unless the event already has a
  request URL.
- It removes `?...` and `#...` from **stack frame file paths only**. It does
  **not** strip the query string from `request.url`.

## 11. Throttling

The notifier adds an `onError` hook that counts sent events for the life of the
client. Once `n >= 10`, further events are cancelled with the warning
`Cancelling event send due to maxEvents limit of 10 being reached`. The cap is
per client instance and is not resettable.

## 12. Delivery

Delivery sends the event as a POST via `XMLHttpRequest`:

- URL: `https://notify.bugsnag.com` (hard-coded).
- Headers: `Content-Type: application/json`, `Bugsnag-Api-Key`,
  `Bugsnag-Payload-Version: 4`, `Bugsnag-Sent-At` (ISO 8601).
- The body is serialised with a safe JSON serialiser using `['password']` for
  redaction (redaction applies within `metaData` and `request`).
- A payload larger than 1 MB triggers a metadata-stripping retry.
- Response handling: status `0` or `>= 400` logs `Event failed to send…`.
- There is **no retry/backoff**.

## 13. Privacy and data handling

- `['password']` redacts matching keys in the payload.
- Query strings are stripped from stack frame file paths.
- No session, no IP, no geo, no breadcrumbs.
- **No device or user identifier.** The notifier generates no anonymous id,
  writes nothing to `localStorage`, and sends no user field.

## 14. Known behaviours and gaps

1. **`request.url` keeps its query string and fragment.** `location.href` is sent
   verbatim; only stack frames are stripped of query strings.
2. **`maxEvents` is per client instance**, not per page load; a long-lived page
   stops reporting after 10 events.
3. **No retry** on failed delivery.
4. **Custom `device` fields may not render in the dashboard.** The window size is
   sent as `device.windowWidth` / `device.windowHeight`; mirror into `metaData`
   if UI display is needed.

## 15. Testing

Tests live in `test/` and run as part of the root `browser` Jest project
(`jest.config.js`). They exercise the package through its public API with a
mocked `XMLHttpRequest` and the jsdom environment
(`jest/FixJSDOMEnvironment.js`).

- `test/index.test.ts` — baseline suite (client creation, notify, config
  validation).
- `test/behaviour.test.ts` — behaviour driven by the stated intent: bootstrap
  and event enrichment, automatic capture, manual reporting, metadata,
  context/request/page, timing, device/browser, throttling, delivery/payload,
  and configuration defaults.
- `test/client.test.ts` — client metadata, context, callbacks and
  configuration.
- `test/events.test.ts` — event normalisation, handled state, onError callbacks,
  stacktrace parsing and payload serialisation.
- `test/plugins.test.ts` — automatic capture: `window.onerror`,
  `unhandledrejection`, context/request and device.
- `test/delivery.test.ts` — payload, release stages, throttling and delivery
  failures.

### 15.1 Coverage

`jest.coverage.config.js` instruments the single source file and runs only the
browser-mini tests. Run it with:

```
npx jest --config packages/browser-mini/jest.coverage.config.js --coverage
```

## 16. Consumer integration

`test/behaviour.test.ts` pins the way an embedding application integrates the
package, which is representative of production usage:

- A shared wrapper creates the client with `createClient({...})` at module
  evaluation time and exposes it (for example as a window global).
- Application code never imports `@bugsnag/*` or the package's internals
  directly; it goes through the wrapper or the exposed client.
- The client is bundled into the application's own JavaScript; there is no CDN
  load at runtime.
- The config used is a small set: `apiKey`, `appType`, an `enabledReleaseStages`
  allow-list, `releaseStage`, and an `onError` callback.
- The `onError` callback appends a suffix to `event.context` and adds metadata
  sections.
- Application code uses `client.notify(err)` and
  `client.addMetadata(section, {...})`. Most consumers never call the API at all
  and rely entirely on automatic `window.onerror` / `unhandledrejection`
  capture.

## 17. Supported browsers

`browser-mini` must run on the browser versions below. A build may target any
one of the named, date-stamped ranges; the runtime must not rely on language or
platform features newer than the range it targets.

| Chrome | Firefox | Safari | Other |
| --- | --- | --- | --- |
| >= 47 | >= 43 | >= 10 | Edge >= 15, Opera >= 42, Samsung >= 5 |
