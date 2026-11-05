test('entry mengekspor ARTracker dengan method publik', async () => {
  const { ARTracker } = await import('../index')
  expect(typeof ARTracker.init).toBe('function')
  expect(typeof ARTracker.track).toBe('function')
})
