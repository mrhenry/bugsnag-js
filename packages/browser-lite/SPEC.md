# `@mrhenry/browser-lite` — Behaviour Specification

This document describes **how `browser-lite` currently works**, as implemented in
`src/notifier.js`, `src/config.js`, the `@bugsnag/core` it embeds, and the set of
`@bugsnag/plugin-*` packages it loads.

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
- Reproducing an error using console breadcrumbs.
- Knowing which page an error happened on (context / request URL).
- Knowing when an error happened (absolute time and position in the breadcrumb
  timeline relative to page load).
- Knowing the window size and the browser make-up (user agent, locale,
  orientation).

### 1.2 What it deliberately does not do (out of scope)

- No sessions. There is no session tracking, no `startSession` / `pauseSession`
  / `resumeSession`, and no session payloads.
- No user identity collection beyond what the user explicitly sets.
- No location/geo information. The `plugin-client-ip` is not loaded, so
  `collectUserIp` is not part of the configuration schema.
- No user-behaviour breadcrumbs: no navigation, interaction (clicks/hover),
  network, or inline-script breadcrumbs.
- No Electron, React Native, Node, Angular, Vue, or Cloudflare Workers support.

### 1.3 Reduced feature set relative to `@bugsnag/browser`

`browser-lite` loads only these plugins:

| Plugin | Loaded |
| --- | --- |
| `@bugsnag/plugin-window-onerror` | yes |
| `@bugsnag/plugin-window-unhandled-rejection` | yes |
| `./device` (inline, replaces `@bugsnag/plugin-browser-device`) | yes |
| `@bugsnag/plugin-browser-context` | yes |
| `@bugsnag/plugin-browser-request` | yes |
| `@bugsnag/plugin-simple-throttle` | yes |
| `@bugsnag/plugin-console-breadcrumbs` | yes |
| `@bugsnag/plugin-strip-query-string` | yes |
| `@bugsnag/delivery-xml-http-request` | yes (delivery, not a plugin) |
| `@bugsnag/plugin-browser-device` | no (replaced by `./device`) |
| `@bugsnag/plugin-app-duration` | no |
| `@bugsnag/plugin-browser-session` | no |
| `@bugsnag/plugin-client-ip` | no |
| `@bugsnag/plugin-inline-script-content` | no |
| `@bugsnag/plugin-interaction-breadcrumbs` | no |
| `@bugsnag/plugin-navigation-breadcrumbs` | no |
| `@bugsnag/plugin-network-breadcrumbs` | no |
| `@bugsnag/delivery-x-domain-request` | no |

## 2. Package layout and build

```
packages/browser-lite/
  src/notifier.js      entry point / public static API
  src/notifier.d.ts    type re-export
  src/config.js        browser-lite config overrides
  types/bugsnag.d.ts   public type surface
  types/global.d.ts    UMD global declaration
  test/index.test.ts   behaviour tests
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

This makes the following available (non-exhaustive): `notify`, `leaveBreadcrumb`,
`addMetadata`, `getMetadata`, `clearMetadata`, `addFeatureFlag`,
`addFeatureFlags`, `clearFeatureFlag`, `clearFeatureFlags`, `getContext`,
`setContext`, `getGroupingDiscriminator`, `setGroupingDiscriminator`, `getUser`,
`setUser`, `addOnError`, `removeOnError`, `addOnBreadcrumb`, `removeOnBreadcrumb`,
`addOnSession`, `removeOnSession`, `getPlugin`, `resetEventCount`.

### 3.3 Methods explicitly removed

`startSession`, `pauseSession` and `resumeSession` are **not** copied onto the
static object (`UNSUPPORTED_METHODS`). They are therefore `undefined`; calling
one throws `TypeError: Bugsnag.startSession is not a function`.

`addOnSession` / `removeOnSession` are still copied (they are ordinary
`Client.prototype` methods) but are inert, because no code path in
`browser-lite` ever starts a session.

### 3.4 Non-functions / internals

`_client` is the singleton client (or `null`). `Client`, `Event`, `Session` and
`Breadcrumb` are attached to each client instance (`client.Event`, etc.) but are
not exported by `browser-lite` (unlike `@bugsnag/browser`, which also exports
`Client`, `Event`, `Session`, `Breadcrumb` as module properties).

## 4. Configuration

Configuration is validated against a schema assembled from:

1. `@bugsnag/core/config` schema, then
2. `src/config.js` overrides, then
3. each loaded plugin's `configSchema` (`plugin-simple-throttle` adds
   `maxEvents`).

Unknown keys are ignored. An invalid value produces a warning log and falls back
to that option's default. A missing/invalid `apiKey` is fatal: the constructor
throws `Error: No Bugsnag API Key set` (only if `apiKey` is in the schema, which
it is).

### 4.1 Options

| Option | Default in browser-lite | Notes |
| --- | --- | --- |
| `apiKey` | `null` | Required. If not 32 hex chars, warns `should be a string of 32 hexadecimal characters` but still starts. |
| `appVersion` | `undefined` | Sent as `event.app.version`. |
| `appType` | `'browser'` | browser-lite override. Sent as `event.app.type`. |
| `autoDetectErrors` | `true` | Gates `onerror` and `unhandledrejection` handlers. |
| `enabledErrorTypes` | `{ unhandledExceptions: true, unhandledRejections: true }` | Partial objects are merged with defaults. Gates each handler. |
| `onError` | `[]` | Function or array. Can return `false` to cancel sending. |
| `onBreadcrumb` | `[]` | Function or array. Can return `false` to drop a breadcrumb. |
| `onSession` | `[]` | Accepted and stored, but never invoked (no sessions). |
| `endpoints` | `{ notify: 'https://notify.bugsnag.com', sessions: 'https://sessions.bugsnag.com' }` | If supplied, **both** `notify` and `sessions` must be non-empty strings and no other keys are allowed, otherwise the whole value is invalid and delivery is disabled (`notify: null`). `sessions` is required even though it is never used. |
| `autoTrackSessions` | `true` | Accepted, inert. |
| `enabledReleaseStages` | `null` | When non-null, events whose `releaseStage` is not included are not sent. |
| `releaseStage` | `'development'` when `location.host` matches `/^localhost(:\d+)?$/`, otherwise `'production'` | browser-lite override. |
| `maxBreadcrumbs` | `25` | 0–100. Oldest breadcrumbs are dropped. |
| `enabledBreadcrumbTypes` | all types: `navigation, request, process, log, user, state, error, manual` | `null` enables all. Only `log` (console) and `error` and `manual`/`state` are actually produced by browser-lite. |
| `context` | `undefined` | Default context comes from `location.pathname` (see §7). |
| `user` | `{}` | Sent as `event.user`. |
| `metadata` | `{}` | Sent as `event.metaData`. |
| `logger` | prefixed `console` if `console.debug` exists, else `undefined` | browser-lite override. Logs prefixed with `[bugsnag]`. |
| `redactedKeys` | `['password']` | Strings or regexes; used by the JSON serialiser to redact matching keys. |
| `plugins` | `[]` | User plugins loaded after internal plugins. |
| `featureFlags` | `[]` | Sent as `event.featureFlags`. |
| `reportUnhandledPromiseRejectionsAsHandled` | `false` | When `true`, unhandled rejections are sent with `unhandled: false`. |
| `sendPayloadChecksums` | `true` when no custom `endpoints` are supplied, else `false` | Adds a `Bugsnag-Integrity` header (SHA-1 of the body) when the context is secure. |
| `maxEvents` | `10` | From `plugin-simple-throttle`. Per-client-instance cap. See §11. |

### 4.2 Options that are **not** part of browser-lite

The following upstream `@bugsnag/browser` options are neither in the schema nor
in the type surface, so passing them has no effect:

- `collectUserIp` (would come from `plugin-client-ip`)
- `generateAnonymousId` (would come from `plugin-browser-device`)
- `trackInlineScripts` (would come from `plugin-inline-script-content`)

## 5. Client creation and startup

`createClient`:

1. Normalises a string argument to `{ apiKey }` and a missing argument to `{}`.
2. Loads internal plugins in this order: device, context, request, throttle,
   strip-query-string, window-onerror, unhandled-rejection, console-breadcrumbs.
3. Constructs a `Client`, which merges the schema, validates config, elevates
   `metadata`, `featureFlags`, `user`, `context` and `logger`, and registers
   `onError` / `onBreadcrumb` / `onSession` callbacks.
4. Sets the delivery mechanism to `delivery-xml-http-request`.
5. Logs `Loaded!` at debug level.
6. Leaves a `state` breadcrumb `Bugsnag loaded` with empty metadata.

`start` stores the client as the singleton. **Unlike `@bugsnag/browser`,
`browser-lite` does not auto-start a session on creation.**

## 6. Automatic error capture

### 6.1 `window.onerror`

Loaded by `plugin-window-onerror`. If `autoDetectErrors` and
`enabledErrorTypes.unhandledExceptions` are both true, it replaces
`window.onerror`. Three argument shapes are handled:

- **Modern**: a 5th `error` argument is present → the error is used directly and
  the first stack frame is decorated with `url`, `lineNo`, `charNo`.
- **jQuery-style event**: first arg is a non-null object, second arg is absent or
  not a string, and no line/char/error args → an error-like object is synthesised
  from `type`/`message`/`detail`; the raw event is stored as `originalError` and
  added as metadata under the `window onerror` section.
- **Legacy**: no error argument → an error is created from the message string and
  the stack is decorated.

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

Loaded by `plugin-window-unhandled-rejection`. Gated by `autoDetectErrors` and
`enabledErrorTypes.unhandledRejections`. It uses `addEventListener` when
available, otherwise `window.onunhandledrejection`.

- The reason is `event.reason`, or `event.detail.reason` (Bluebird) when present.
- `unhandled` is `!reportUnhandledPromiseRejectionsAsHandled` (so `true` by
  default).
- `severity: 'error'`, `severityReason: { type: 'unhandledPromiseRejection' }`.
- Bluebird stack padding is trimmed.
- If the original reason is a non-`Error` object, its name/message/code are added
  as metadata under the `unhandledRejection handler` section.

### 6.3 `enabledReleaseStages`

In `_notify`, before delivery, if `enabledReleaseStages` is non-null and does not
include the current `releaseStage`, the event is dropped with a warning.

## 7. Manual reporting (`notify`)

`Bugsnag.notify(maybeError, onError?, postReportCallback?)`.

- Non-`Error` inputs are tolerated: strings/numbers/booleans become an `Error`
  with that message; objects with `name`/`errorClass` and `message`/`errorMessage`
  become an `Error`; anything else produces an `InvalidError` whose details are
  added as metadata under the `notify()` section.
- `Error.cause` chains produce additional entries in `event.errors`.
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
- When an event is actually sent and the `error` breadcrumb type is enabled, an
  `error` breadcrumb is added (message = error class).

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
| `request` | `{ url }` (and anything user/plugin added) |
| `response` | `{}` |
| `breadcrumbs[]` | see §9 |
| `context` | see §9 |
| `groupingHash` | `undefined` unless set |
| `groupingDiscriminator` | `undefined` unless set |
| `metaData` | client metadata merged with event metadata |
| `user` | `{ id, email, name }` (empty unless the user sets it) |
| `session` | `undefined` (no sessions) |
| `featureFlags` | `[]` unless added |
| `correlation` | `undefined` unless set |

Each stack frame is `{ file, method, lineNumber, columnNumber, code, inProject }`.
Frames with no usable data are dropped. `method` defaults to `global code` when
a frame has a line number but no file/function.

### 8.1 Device fields

From the inline `src/device.js` plugin, at the moment the event is sent:

- `userAgent`: `navigator.userAgent`
- `locale`: first of `navigator.browserLanguage`, `navigator.systemLanguage`,
  `navigator.userLanguage`, `navigator.language`
- `orientation`: `screen.orientation.type` if present, else `landscape`/`portrait`
  from `documentElement.clientWidth` vs `clientHeight`
- `windowWidth`: `window.innerWidth`
- `windowHeight`: `window.innerHeight`
- `time`: `new Date()` (captured as the event is sent)

There is deliberately **no** `id` and **no** anonymous id: browser-lite does not
generate or persist a device identifier, and does not populate `user.id`.

> The Bugsnag dashboard renders a fixed set of `device` fields; custom keys such
> as `windowWidth`/`windowHeight` are carried in the payload but may not be
> shown in the UI. If dashboard display is required, mirror them into
> `metaData` via an `onError` callback.

## 9. Breadcrumbs

### 9.1 Manual

`leaveBreadcrumb(message, metadata, type)`:

- Non-string `message` → `''`; a falsy message is discarded.
- `type` must be one of the known types, otherwise `manual`.
- Non-object metadata → `{}`.
- `onBreadcrumb` callbacks run; returning `false` drops the crumb.
- The crumb is appended and the list is trimmed to `maxBreadcrumbs`.

A breadcrumb serialises to `{ type, name, timestamp, metaData }`.

### 9.2 Console breadcrumbs

`plugin-console-breadcrumbs` wraps `console.log`, `console.debug`,
`console.info`, `console.warn` and `console.error`:

- Disabled when `releaseStage` matches `/^(local-)?dev(elopment)?$/`.
- Disabled when the `log` breadcrumb type is not enabled.
- Each call leaves a breadcrumb of type `log`, with `name: "Console output"` and
  metadata keyed by argument index (`[0]`, `[1]`, …). Objects are stringified
  with `String()` and, if that yields `[object Object]`, `JSON.stringify()`.
- The original console method is still called.

### 9.3 Automatic breadcrumbs

- On startup: a `state` breadcrumb `Bugsnag loaded`.
- On send: an `error` breadcrumb (if the `error` type is enabled) whose message is
  the error class.

There is **no** navigation/interaction/network breadcrumb.

### 9.4 Timing

Every breadcrumb has a `timestamp` (a `Date`). The `state` breadcrumb is created
at startup, so the breadcrumb timeline gives the relative time of an error to
page load. The event's `device.time` gives the absolute send time.

## 10. Page / context / request

- `plugin-browser-context` sets `event.context = location.pathname` unless the
  event already has a context (e.g. set via `setContext` or config).
- `plugin-browser-request` sets `event.request.url = location.href` unless the
  event already has a request URL.
- `plugin-strip-query-string` removes `?...` and `#...` from **stack frame file
  paths only**. It does **not** strip the query string from `request.url`.

## 11. Throttling

`plugin-simple-throttle` adds an `onError` hook that counts sent events for the
life of the client. Once `n >= maxEvents` (default 10), further events are
cancelled with the warning
`Cancelling event send due to maxEvents per session limit of <n> being reached`.
`resetEventCount()` resets the counter. The cap is per client instance, not per
page load or per session.

## 12. Delivery

`delivery-xml-http-request` sends the event as a POST via `XMLHttpRequest`:

- URL: `config.endpoints.notify`.
- If `endpoints.notify` is `null` (invalid/missing custom endpoints), the send is
  aborted and the callback receives
  `Error: Event not sent due to incomplete endpoint configuration`.
- Headers: `Content-Type: application/json`, `Bugsnag-Api-Key`,
  `Bugsnag-Payload-Version: 4`, `Bugsnag-Sent-At` (ISO 8601).
- When `sendPayloadChecksums` is true and the context is secure with
  `crypto.subtle`, a `Bugsnag-Integrity: sha1 <hex>` header is added before send.
- The body is serialised with `@bugsnag/safe-json-stringify` using
  `redactedKeys` (redaction applies within `metaData`, `breadcrumbs[].metaData`,
  `request`, `response`).
- A payload larger than 1 MB triggers a metadata-stripping retry and a warning.
- Response handling: status `0` or `>= 400` logs `Event failed to send…` and
  calls the callback with an error; otherwise the callback receives `null`.
- There is **no retry/backoff**.

### 12.1 Secondary endpoints

If `endpoints` is not supplied and the API key starts with `00000`, the notify
and sessions endpoints are switched to the SmartBear secondary endpoints
(`https://notify.bugsnag.smartbear.com`, `https://sessions.bugsnag.smartbear.com`).

## 13. Privacy and data handling

- `redactedKeys` (default `['password']`) redacts matching keys in the payload.
- Query strings are stripped from stack frame file paths.
- No session, no IP, no geo, no navigation/interaction/network breadcrumbs.
- Console breadcrumbs can capture arbitrary logged data (including PII). They are
  on by default in production and off in development.
- **No device or user identifier.** The inline device plugin generates no
  anonymous id, writes nothing to `localStorage`, and does not populate
  `user.id`. There is no cross-session identifier.

## 14. Known behaviours and gaps

These are current behaviours that conflict with, or are worth deciding on
relative to, the package's stated intent:

1. **`request.url` keeps its query string and fragment.** `location.href` is sent
   verbatim; `plugin-strip-query-string` only touches stack frames. Query strings
   often contain tokens, emails and identifiers.
2. **`endpoints` requires a `sessions` URL** even though sessions are
   unsupported, so a "notify only" configuration cannot be expressed without
   also naming a sessions endpoint (or having delivery disabled).
3. **`onSession` / `autoTrackSessions` are accepted but inert.**
4. **`addOnSession` / `removeOnSession` are exposed but inert.**
5. **Console breadcrumbs are enabled by default in production**, so any
   `console.log` payload becomes part of the event.
6. **`maxEvents` is per client instance**, not per page load; a long-lived page
   stops reporting after 10 events until `resetEventCount()` is called.
7. **No retry** on failed delivery.
8. **Custom `device` fields may not render in the dashboard.** The window size is
   sent as `device.windowWidth` / `device.windowHeight`; the dashboard shows a
   fixed set of device fields, so mirror into `metaData` if UI display is needed.

The following previously listed conflicts have been resolved by this fork:

- ~~Anonymous device/user id persisted in `localStorage` and copied to
  `user.id`~~ — removed by replacing `plugin-browser-device` with the inline
  `src/device.js`.
- ~~Window size not reported~~ — now sent as `device.windowWidth` /
  `device.windowHeight`.

## 15. Testing

Tests live in `test/` and run as part of the root `browser` Jest project
(`jest.config.js`). They exercise the package through its public API with a
mocked `XMLHttpRequest` and the jsdom environment
(`jest/FixJSDOMEnvironment.js`), which provides `TextEncoder` and
`crypto.subtle` so payload checksums can be exercised.

- `test/index.test.ts` — the package's baseline suite (startup, notify, plugin
  registration, config validation, payload checksums, session API absence).
- `test/behaviour.test.ts` — behaviour driven by the stated intent and by
  coverage gaps: bootstrap and event enrichment (creating a client without
  starting the singleton, exposing it as a global, `onError` enrichment),
  automatic capture (`onerror`, `unhandledrejection`, CORS, `autoDetectErrors`,
  `enabledErrorTypes`), manual reporting and callbacks, metadata, breadcrumbs
  (manual, console, `maxBreadcrumbs`, `enabledBreadcrumbTypes`),
  context/request/page, timing, device/browser (including window size and the
  absence of an anonymous id), throttling, delivery/payload (endpoints,
  redaction, release stages), and configuration defaults.
- `test/device.test.ts` — unit tests for the inline device plugin (orientation
  sources, window size, locale fallback chain).
- `test/bundle-lib.test.ts`, `test/bundle-client.test.ts`,
  `test/bundle-event.test.ts`, `test/bundle-plugins.test.ts`,
  `test/bundle-delivery.test.ts` — direct tests for every first-party module that
  ends up in the bundle (core lib, client, event, config, each plugin, delivery).
- `test/bundle-client-edge.test.ts` — the one branch of `Client#_notify` that is
  only reachable by replacing the internal callback runner.
- `test/bundle-console-group.test.ts` — pins the `group*` severity branch of the
  console-breadcrumbs plugin by replacing the internal `filter` module.

### 15.1 Bundle coverage

`jest.coverage.config.js` instruments every first-party module that the browser
bundle contains and runs only the browser-lite tests. Run it with:

```
npx jest --config packages/browser-lite/jest.coverage.config.js --coverage
```

Current bundle coverage: **100% statements, 100% branches, 100% functions, 100%
lines** across ~230 tests. `packages/browser-lite/src` itself is at 100% for all
metrics.

Two regions are unreachable in a modern engine and are exercised by temporarily
changing the environment rather than by production code paths:

- `core/lib/es-utils/keys.js` lines 18–21 — the legacy "dontEnum bug" shim for
  old IE. Its guard is `false` in every modern engine, so the test replaces
  `Object.prototype.propertyIsEnumerable` and re-requires the module to make the
  guard `true`.
- `plugin-console-breadcrumbs` line 31 — the `method.indexOf('group') === 0`
  severity branch. The plugin only wraps `log`/`debug`/`info`/`warn`/`error`, so
  the test replaces the internal `filter` module to wrap a `group` method.

Notes for writing tests here:

- jsdom's default location is `http://localhost/`, so the default `releaseStage`
  in tests is `development` (which disables console breadcrumbs) unless a test
  sets `releaseStage` explicitly.
- The console-breadcrumbs plugin mutates the global `console` on every
  `start()`, and the unhandled-rejection plugin attaches a `window` listener.
  Tests must restore `console` and remove listeners after each case (see the
  `afterEach` in `test/behaviour.test.ts`).
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
`appVersion`, `maxBreadcrumbs`, `redactedKeys`, plugins, and user/metadata are
left at their defaults.

### 16.3 `onError` enrichment

The callback appends a suffix to `event.context` and adds metadata sections
(for example `site: { id, app }` and `bundle: { target }`), guarding against
absent values.

### 16.4 API surface used by applications

- `client.notify(err)` — always a single `Error` argument.
- `client.addMetadata(section, {...})` — attaching flow identifiers that persist
  onto later reports.
- No breadcrumbs, user, context, feature flags, sessions, plugins, or callbacks
  are used from application code.
- Most consumers never call the API at all and rely entirely on the automatic
  `window.onerror` / `unhandledrejection` capture.

### 16.5 Legacy options

An earlier published build had `generateAnonymousId` active (a persistent
`localStorage` id used as `user.id`), while `collectUserIp` and
`autoTrackSessions` were inert. In this fork those options are ignored: no
anonymous id, no `localStorage` write, no `user.id`, and no sessions. The tests
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
