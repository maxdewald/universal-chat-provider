import { execSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { defineConfig } from 'tsdown'

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map(module => `node:${module}`),
])

export default defineConfig({
  entry: [
    'src/index.ts',
  ],
  format: ['cjs'],
  shims: false,
  dts: false,
  deps: {
    neverBundle: ['vscode'],
    alwaysBundle: id => id !== 'vscode' && !nodeBuiltins.has(id),
    // Silences tsdown's "unintended bundling" hint; bundling is deliberate here.
    onlyBundle: false,
  },
  hooks(hooks) {
    hooks.hookOnce('build:prepare', () => {
      execSync('pnpm generate', { stdio: 'inherit' })
    })
  },
})
