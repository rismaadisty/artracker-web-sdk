import type { ARTrackerOptions, LogLevel } from './types'

export type { ARTrackerOptions, RawItem, Envelope, LogLevel, ItemType } from './types'

const noop = (): void => {}

// Stub — digantikan oleh ARTrackerClient di Task 12.
export const ARTracker = {
  init: (_options: ARTrackerOptions): void => {},
  identify: (_userId: string, _traits?: Record<string, unknown>): void => {},
  track: (_name: string, _properties?: Record<string, unknown>): void => {},
  log: (_level: LogLevel, _message: string, _attributes?: Record<string, unknown>): void => {},
  captureException: (_error: unknown, _context?: Record<string, unknown>): void => {},
  setContext: (_key: string, _value: unknown): void => {},
  addBreadcrumb: (_breadcrumb: { type: string; data?: Record<string, unknown> }): void => {},
  flush: (): Promise<void> => Promise.resolve(),
  startReplay: noop,
  stopReplay: noop,
  reset: noop,
  shutdown: noop,
}

export default ARTracker
