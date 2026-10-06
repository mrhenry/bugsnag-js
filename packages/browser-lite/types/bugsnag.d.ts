import { Client, Config, BugsnagStatic } from '@bugsnag/core'

interface BrowserConfig extends Omit<Config, 'onSession' | 'autoTrackSessions' | 'plugins' | 'endpoints' | 'featureFlags' | 'user' | 'onBreadcrumb' | 'maxBreadcrumbs' | 'enabledBreadcrumbTypes' | 'sendPayloadChecksums'> {
  maxEvents?: number
  endpoints?: { notify: string }
}

export interface BrowserBugsnagStatic extends Omit<BugsnagStatic, 'startSession' | 'pauseSession' | 'resumeSession' | 'addOnSession' | 'removeOnSession' | 'getPlugin' | 'addFeatureFlag' | 'addFeatureFlags' | 'clearFeatureFlag' | 'clearFeatureFlags' | 'getUser' | 'setUser' | 'leaveBreadcrumb' | 'addOnBreadcrumb' | 'removeOnBreadcrumb' | 'getGroupingDiscriminator' | 'setGroupingDiscriminator'> {
  start(apiKeyOrOpts: string | BrowserConfig): Client
  createClient(apiKeyOrOpts: string | BrowserConfig): Client
}

declare const Bugsnag: BrowserBugsnagStatic

export default Bugsnag
export * from '@bugsnag/core'
export { BrowserConfig }
