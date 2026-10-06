import { Client, Config } from '@bugsnag/core'

export interface BrowserConfig {
  apiKey: string
  appType?: string
  enabledReleaseStages?: string[] | null
  releaseStage?: string
  onError?: Config['onError']
}

export interface BrowserClient extends Omit<Client, 'startSession' | 'pauseSession' | 'resumeSession' | 'addOnSession' | 'removeOnSession' | 'getPlugin' | 'getUser' | 'setUser' | 'addFeatureFlag' | 'addFeatureFlags' | 'clearFeatureFlag' | 'clearFeatureFlags' | 'leaveBreadcrumb' | 'addOnBreadcrumb' | 'removeOnBreadcrumb' | 'getGroupingDiscriminator' | 'setGroupingDiscriminator' | 'getMetadata' | 'clearMetadata' | 'getContext' | 'setContext' | 'removeOnError' | 'resetEventCount'> {}

export interface BrowserBugsnagStatic {
  createClient(apiKeyOrOpts: string | BrowserConfig): BrowserClient
}

declare const Bugsnag: BrowserBugsnagStatic

export default Bugsnag
export * from '@bugsnag/core'
export { BrowserConfig }
