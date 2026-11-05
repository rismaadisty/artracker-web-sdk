import { ARTrackerClient } from './core/client'
import type { ARTrackerOptions, LogLevel } from './types'

export type { ARTrackerOptions, RawItem, Envelope, LogLevel, ItemType } from './types'

const client = new ARTrackerClient()

export const ARTracker = {
  init: (options: ARTrackerOptions): void => client.init(options),
  identify: (userId: string, traits?: Record<string, unknown>): void => client.identify(userId, traits),
  track: (name: string, properties?: Record<string, unknown>): void => client.track(name, properties),
  log: (level: LogLevel, message: string, attributes?: Record<string, unknown>): void => client.log(level, message, attributes),
  captureException: (error: unknown, context?: Record<string, unknown>): void => client.captureException(error, context),
  setContext: (key: string, value: unknown): void => client.setContext(key, value),
  addBreadcrumb: (breadcrumb: { type: string; data?: Record<string, unknown> }): void => client.addBreadcrumb(breadcrumb),
  flush: (): Promise<void> => client.flush(),
  startReplay: (): void => client.startReplay(),
  stopReplay: (): void => client.stopReplay(),
  reset: (): void => client.reset(),
  disable: (): void => client.disable(),
  enable: (): void => client.enable(),
  shutdown: (): void => client.shutdown(),
}

