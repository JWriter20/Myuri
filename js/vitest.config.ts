import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 120000,
    hookTimeout: 60000,
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    globals: true,
  },
})
