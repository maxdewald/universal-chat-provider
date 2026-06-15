import type { ChildProcess } from 'node:child_process'
import type { ManagedPaths } from '../src/managed/config'
import type { ServerDeps } from '../src/managed/server'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { acquireBinary, DEFAULT_BINARY_VERSION } from '../src/managed/binary'
import { buildManagedConfig, DEFAULT_HOST, generateSecret, managedPaths } from '../src/managed/config'
import { ManagedServer } from '../src/managed/server'

const HOST = DEFAULT_HOST
// Reuse a stable cache so the ~40 MB binary is downloaded at most once per machine.
const BIN_CACHE = join(tmpdir(), 'universal-chat-provider-e2e-bin')
// ManagedServer only ever calls appendLine; a bare stub satisfies the type.
const output = { appendLine() {}, show() {} } as unknown as ServerDeps['output']

let binaryPath: string
const cleanups: Array<() => Promise<void> | void> = []

beforeAll(async () => {
  binaryPath = (await acquireBinary({ binDir: BIN_CACHE, requestedVersion: DEFAULT_BINARY_VERSION, output })).binaryPath
}, 120_000)

afterEach(async () => {
  // Tear down in reverse so servers stop before their temp dirs are removed.
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe.sequential('managed CLIProxyAPI server', () => {
  it('becomes healthy on the preferred port when it is free', async () => {
    const preferred = await freePort()
    const { server } = await makeServer(preferred)

    const running = await server.ensureRunning()

    expect(running.port).toBe(preferred)
    expect(await healthy(running.port)).toBe(true)
  })

  it('falls back to a free port when the preferred port is held by a foreign server', async () => {
    // Reproduces the production failure: a foreign CLIProxyAPI already owns the
    // preferred port, so we must spawn our own on a different port — and the
    // binary takes its port only from the config file, so the config has to be
    // synced before the spawn or the new process binds the held port and exits.
    const preferred = await freePort()
    await startForeign(preferred)

    const { server, paths } = await makeServer(preferred, { verifyOwnership: async () => false })
    const running = await server.ensureRunning()

    expect(running.port).not.toBe(preferred)
    expect(await healthy(running.port)).toBe(true)
    const config = parse(await readFile(paths.configPath, 'utf8')) as { port?: number }
    expect(config.port).toBe(running.port)
  })
})

async function makeServer(
  preferred: number,
  overrides: Partial<ServerDeps> = {},
): Promise<{ server: ManagedServer, paths: ManagedPaths }> {
  const root = await mkdtemp(join(tmpdir(), 'ucp-managed-'))
  cleanups.push(async () => rm(root, { recursive: true, force: true }))
  // Point binDir at the shared cache so start() reuses the downloaded binary.
  const paths: ManagedPaths = { ...managedPaths(root), binDir: BIN_CACHE }
  await mkdir(paths.authDir, { recursive: true })
  await writeFile(paths.configPath, buildManagedConfig({
    host: HOST,
    port: preferred,
    apiKey: generateSecret(),
    managementKey: generateSecret(),
    authDir: paths.authDir,
  }))

  let persisted: number | undefined
  const server = new ManagedServer({
    paths,
    output,
    host: HOST,
    requestedVersion: DEFAULT_BINARY_VERSION,
    getPort: () => persisted ?? preferred,
    setPort: (port) => { persisted = port },
    ...overrides,
  })
  cleanups.push(async () => server.stop())
  return { server, paths }
}

/** Spawn a real CLIProxyAPI we do not own, holding `port` until cleanup. */
async function startForeign(port: number): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ucp-foreign-'))
  cleanups.push(async () => rm(root, { recursive: true, force: true }))
  const paths = managedPaths(root)
  await mkdir(paths.authDir, { recursive: true })
  await writeFile(paths.configPath, buildManagedConfig({
    host: HOST,
    port,
    apiKey: generateSecret(),
    managementKey: generateSecret(),
    authDir: paths.authDir,
  }))
  const child: ChildProcess = spawn(binaryPath, ['--config', paths.configPath, '-local-model'], { stdio: 'ignore' })
  cleanups.push(() => {
    child.kill()
  })
  await waitHealthy(port, 20_000)
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, HOST, () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('Could not allocate a free port.'))))
    })
  })
}

async function healthy(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://${HOST}:${port}/healthz`)).ok
  }
  catch {
    return false
  }
}

async function waitHealthy(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthy(port))
      return
    await delay(200)
  }
  throw new Error(`Foreign CLIProxyAPI on port ${port} never became healthy.`)
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
