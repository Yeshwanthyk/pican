import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/extensions/*.test.ts'],
  },
  resolve: {
    alias: {
      '@earendil-works/pi-coding-agent': new URL('./__mocks__/pi-coding-agent.ts', import.meta.url).pathname,
      '@earendil-works/pi-tui': new URL('./__mocks__/pi-tui.ts', import.meta.url).pathname,
    },
  },
});
