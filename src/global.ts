// Entry IIFE (<script>): namespace global = API langsung, jadi `ARTracker.init(...)` bekerja tanpa `.ARTracker.`.
import { ARTracker } from './index'

export const init = ARTracker.init
export const identify = ARTracker.identify
export const track = ARTracker.track
export const log = ARTracker.log
export const captureException = ARTracker.captureException
export const setContext = ARTracker.setContext
export const addBreadcrumb = ARTracker.addBreadcrumb
export const flush = ARTracker.flush
export const startReplay = ARTracker.startReplay
export const stopReplay = ARTracker.stopReplay
export const reset = ARTracker.reset
export const shutdown = ARTracker.shutdown
