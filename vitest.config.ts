import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/support/vscode.ts', import.meta.url)),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**'],
      reporter: ['text', 'html'],
    },
    projects: [
      {
        resolve: {
          alias: {
            vscode: fileURLToPath(new URL('./test/support/vscode.ts', import.meta.url)),
          },
        },
        test: {
          name: 'test:unit',
          include: ['test/**/*.test.ts'],
          clearMocks: true,
          restoreMocks: true,
          unstubGlobals: true,
        },
      },
      {
        resolve: {
          alias: {
            vscode: fileURLToPath(new URL('./test/support/vscode.ts', import.meta.url)),
          },
        },
        test: {
          name: 'test:e2e',
          include: ['e2e/**/*.test.ts'],
          fileParallelism: false,
          hookTimeout: 60_000,
          maxWorkers: 1,
          testTimeout: 70_000,
        },
      },
    ],
  },
})
