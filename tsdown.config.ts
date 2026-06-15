import { execSync } from 'node:child_process'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
  ],
  format: ['cjs'],
  shims: false,
  dts: false,
  deps: {
    neverBundle: ['vscode'],
    alwaysBundle: [
      'tokenx',
      'untildify',
      'yaml',
    ],
    onlyBundle: false,
  },
  hooks(hooks) {
    hooks.hookOnce('build:prepare', () => {
      execSync('pnpm generate', { stdio: 'inherit' })
    })
  },
})
