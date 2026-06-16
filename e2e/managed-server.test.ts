import type { ChildProcess } from 'node:child_process'
import type { ManagedPaths } from '../src/cliproxy/managed/config'
import type { ServerDeps } from '../src/cliproxy/managed/server'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sleep, timeout } from 'moderndash'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { acquireBinary, DEFAULT_BINARY_VERSION } from '../src/cliproxy/managed/binary'
import { buildManagedConfig, DEFAULT_HOST, generateSecret, managedPaths } from '../src/cliproxy/managed/config'
import { claimLease, readServerPid, releaseLease } from '../src/cliproxy/managed/leases'
import { ManagedServer } from '../src/cliproxy/managed/server'

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

  it('stops the sidecar process when the last window closes', async () => {
    const preferred = await freePort()
    const { server, paths } = await makeServer(preferred)
    const running = await server.ensureRunning()
    const pid = readServerPid(paths.pidPath)
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid!)).toBe(true)
    expect(await healthy(running.port)).toBe(true)

    // Closing the only window: its lease is the last, so the sidecar is stopped.
    claimLease(paths.leaseDir, process.pid)
    expect(releaseLease(paths.leaseDir, process.pid)).toBe(true)
    server.shutdown()

    await waitUntil(() => !alive(pid!), 5000)
    expect(alive(pid!)).toBe(false)
    expect(await healthy(running.port)).toBe(false)
  })

  it('keeps the sidecar running while another window is still open', async () => {
    const preferred = await freePort()
    const { server, paths } = await makeServer(preferred)
    const running = await server.ensureRunning()
    const pid = readServerPid(paths.pidPath)!

    claimLease(paths.leaseDir, process.pid)
    const other = liveProcess()
    claimLease(paths.leaseDir, other.pid)

    // This window closes while `other` is still open → not last → leave it up.
    expect(releaseLease(paths.leaseDir, process.pid)).toBe(false)
    server.dispose()

    expect(alive(pid)).toBe(true)
    expect(await healthy(running.port)).toBe(true)
  })

  it('lets a window that only adopted the sidecar stop it via the recorded pid', async () => {
    const preferred = await freePort()
    const { server: owner, paths } = await makeServer(preferred)
    const running = await owner.ensureRunning()
    const pid = readServerPid(paths.pidPath)!
    expect(alive(pid)).toBe(true)

    // A second window adopts the same sidecar: it never spawned, so it holds no
    // child handle and must stop the process through the recorded server.pid.
    const { server: adopter } = await makeServer(preferred, { verifyOwnership: async () => true }, paths)
    const adopted = await adopter.ensureRunning()
    expect(adopted.port).toBe(running.port)

    adopter.shutdown()

    await waitUntil(() => !alive(pid), 5000)
    expect(alive(pid)).toBe(false)
  })
})

async function makeServer(
  preferred: number,
  overrides: Partial<ServerDeps> = {},
  existing?: ManagedPaths,
): Promise<{ server: ManagedServer, paths: ManagedPaths }> {
  let paths: ManagedPaths
  if (existing !== undefined) {
    paths = existing
  }
  else {
    const root = await mkdtemp(join(tmpdir(), 'ucp-managed-'))
    cleanups.push(async () => rm(root, { recursive: true, force: true }))
    // Point binDir at the shared cache so start() reuses the downloaded binary.
    paths = { ...managedPaths(root), binDir: BIN_CACHE }
    await mkdir(paths.authDir, { recursive: true })
    await writeFile(paths.configPath, buildManagedConfig({
      host: HOST,
      port: preferred,
      apiKey: generateSecret(),
      managementKey: generateSecret(),
      authDir: paths.authDir,
    }))
  }

  let persisted: number | undefined
  const server = new ManagedServer({
    paths,
    output,
    host: HOST,
    requestedVersion: () => DEFAULT_BINARY_VERSION,
    getPort: () => persisted ?? preferred,
    setPort: (port) => { persisted = port },
    ...overrides,
  })
  // Reap the sidecar no matter how the test left it: kill our own child, then
  // fall back to the recorded pid for a server we adopted or only dropped.
  cleanups.push(async () => {
    await server.stop()
    const pid = readServerPid(paths.pidPath)
    if (pid !== undefined) {
      try {
        process.kill(pid)
      }
      catch {}
    }
  })
  return { server, paths }
}

/** A do-nothing child that stays alive until cleanup, giving us a real pid. */
function liveProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
  cleanups.push(() => {
    child.kill()
  })
  return child
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const poll = async (): Promise<void> => {
    while (!predicate())
      await sleep(100)
  }
  await timeout(poll(), timeoutMs)
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
  const poll = async (): Promise<void> => {
    while (!(await healthy(port)))
      await sleep(200)
  }
  try {
    await timeout(poll(), timeoutMs)
  }
  catch {
    throw new Error(`Foreign CLIProxyAPI on port ${port} never became healthy.`)
  }
}
