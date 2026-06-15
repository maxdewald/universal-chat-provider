import type { ChildProcess } from 'node:child_process'
import type { ExtensionContext } from 'vscode'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { managedPaths } from '../src/managed/config'
import { ServerController } from '../src/managed/controller'
import { claimLease } from '../src/managed/lifecycle'
import { ManagedServer } from '../src/managed/server'
import { resetVSCodeMock, vscodeMock } from './support/vscode'

describe('server controller lifecycle', () => {
  let root: string
  const spawned: ChildProcess[] = []

  beforeEach(async () => {
    resetVSCodeMock()
    root = await mkdtemp(join(tmpdir(), 'ucp-controller-'))
    // Avoid touching the real binary/network: the server is stubbed wholesale.
    vi.spyOn(ManagedServer.prototype, 'ensureRunning').mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', port: 1 })
  })

  afterEach(async () => {
    for (const child of spawned.splice(0))
      child.kill()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('claims a lease on start and stops the sidecar when the last window closes', async () => {
    const shutdown = vi.spyOn(ManagedServer.prototype, 'shutdown').mockReturnValue()
    const dispose = vi.spyOn(ManagedServer.prototype, 'dispose').mockReturnValue()
    const controller = new ServerController(context(root), vscodeMock.output as never)

    await controller.ensureReady(false)
    expect(await readdir(managedPaths(root).leaseDir)).toEqual([String(process.pid)])

    controller.dispose()
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
  })

  it('leaves the sidecar running when another window still holds a lease', async () => {
    const shutdown = vi.spyOn(ManagedServer.prototype, 'shutdown').mockReturnValue()
    const dispose = vi.spyOn(ManagedServer.prototype, 'dispose').mockReturnValue()
    const controller = new ServerController(context(root), vscodeMock.output as never)
    await controller.ensureReady(false)

    // A second, still-open window holds its own lease.
    claimLease(managedPaths(root).leaseDir, liveProcess().pid)

    controller.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(shutdown).not.toHaveBeenCalled()
  })

  function liveProcess(): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
    spawned.push(child)
    return child
  }
})

describe('server controller status snapshot', () => {
  let root: string

  beforeEach(async () => {
    resetVSCodeMock()
    root = await mkdtemp(join(tmpdir(), 'ucp-status-'))
    vi.spyOn(ManagedServer.prototype, 'ensureRunning').mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', port: 1 })
    vi.spyOn(ManagedServer.prototype, 'shutdown').mockReturnValue()
    vi.spyOn(ManagedServer.prototype, 'dispose').mockReturnValue()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('reports the managed server as running once it has started', async () => {
    const controller = new ServerController(context(root), vscodeMock.output as never)
    await controller.ensureReady(false)

    const snapshot = await controller.statusSnapshot()

    expect(snapshot).toMatchObject({ mode: 'managed', status: 'running' })
    expect(snapshot.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('reports external mode and skips the account probe when no server answers', async () => {
    vscodeMock.settings.set('universalChatProvider.server.mode', 'external')
    // An unreachable port makes the best-effort account probe fail fast.
    vscodeMock.settings.set('universalChatProvider.baseUrl', 'http://127.0.0.1:9')
    vscodeMock.secrets.set('universalChatProvider.managementKey', 'mgmt-secret')
    const controller = new ServerController(context(root), vscodeMock.output as never)

    const snapshot = await controller.statusSnapshot()

    expect(snapshot).toMatchObject({ mode: 'external', status: 'external', baseUrl: 'http://127.0.0.1:9' })
    expect(snapshot.accounts).toBeUndefined()
  })
})

function context(root: string): ExtensionContext {
  const globalState = new Map<string, unknown>()
  return {
    subscriptions: [],
    globalStorageUri: { fsPath: root },
    globalState: {
      get: <T>(key: string, fallback?: T): T => (globalState.get(key) ?? fallback) as T,
      update: async (key: string, value: unknown) => {
        globalState.set(key, value)
      },
    },
    secrets: {
      get: async (key: string) => vscodeMock.secrets.get(key),
      store: async (key: string, value: string) => {
        vscodeMock.secrets.set(key, value)
      },
      delete: async (key: string) => {
        vscodeMock.secrets.delete(key)
      },
      onDidChange: () => ({ dispose() {} }),
    },
  } as unknown as ExtensionContext
}
