import { replay, replayDriver } from '../index'

test('replay() mengembalikan konfigurasi yang mengaktifkan replay dengan driver dan sampleRate', () => {
  expect(replay({ sampleRate: 0.25 })).toEqual({ enabled: true, sampleRate: 0.25, driver: replayDriver })
})

test('replay() tanpa argumen membiarkan sampleRate ke default config', () => {
  expect(replay().sampleRate).toBeUndefined()
})

test('replayDriver diekspor untuk mode manual: { driver: replayDriver } + startReplay()', () => {
  expect(typeof replayDriver.start).toBe('function')
})
