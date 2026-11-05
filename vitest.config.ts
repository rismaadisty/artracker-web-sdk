import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: { __AR_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
})
