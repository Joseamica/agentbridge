import { defineConfig } from 'vitest/config'

// Opt-in: talks to real public Nostr relays over the internet. Never part of `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.live.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
