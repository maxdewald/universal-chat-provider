import type { ChildProcess } from 'node:child_process'
import type { OutputChannel } from 'vscode'
import type { ManagedPaths } from './config'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { acquireBinary } from './binary'
import { DEFAULT_PORT, setConfigPort } from './config'

const HEALTH_TIMEOUT_MS = 1500
const STARTUP_TIMEOUT_MS = 20_000
const STARTUP_POLL_MS = 300

export interface ServerDeps {
  paths: ManagedPaths
  output: OutputChannel
  host: string
  /** Pinned binary version or `latest`. */
  requestedVersion: string
  /** Persist/recall the chosen port across windows and sessions. */
  getPort: () => number | undefined
  setPort: (port: number) => void | Thenable<void>
  /**
   * Confirm a healthy server on `baseUrl` is ours (authenticates with our
   * management key) before adopting it. When it returns false, a foreign
   * CLIProxyAPI occupies the port and we spawn our own elsewhere instead.
   */
  verifyOwnership?: (baseUrl: string) => Promise<boolean>
}

export interface RunningServer {
  baseUrl: string
  port: number
  /** Version of the binary backing this window's child, or undefined when adopted. */
  version?: string
}

/**
 * Owns the local CLIProxyAPI process. The running server on a known port *is*
 * the singleton: any window adopts a healthy server, otherwise spawns a
 * detached daemon that outlives the spawning window. A dead server is revived
 * lazily on the next `ensureRunning` call.
 */
export class ManagedServer {
  private child: ChildProcess | undefined
  private adopted = false
  private port: number | undefined
  private version: string | undefined
  private stopping = false
  private startPromise: Promise<RunningServer> | undefined

  constructor(private readonly deps: ServerDeps) {}

  baseUrl(): string | undefined {
    return this.port === undefined ? undefined : `http://${this.deps.host}:${this.port}`
  }

  installedVersion(): string | undefined {
    return this.version
  }

  async ensureRunning(signal?: AbortSignal): Promise<RunningServer> {
    if (this.startPromise !== undefined)
      return this.startPromise
    if (this.port !== undefined && (this.adopted || (this.child !== undefined && this.child.exitCode === null)))
      return { baseUrl: this.baseUrl()!, port: this.port, ...(this.version !== undefined ? { version: this.version } : {}) }

    this.startPromise = this.start(signal).finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  async restart(signal?: AbortSignal): Promise<RunningServer> {
    await this.stop()
    return this.ensureRunning(signal)
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = undefined
    this.adopted = false
    this.port = undefined
    if (child !== undefined && child.exitCode === null) {
      child.kill()
      this.deps.output.appendLine('Stopped the managed CLIProxyAPI server.')
    }
    this.stopping = false
  }

  dispose(): void {
    // A detached daemon is meant to outlive a single window: drop our handle
    // without killing it. Use `stop()` / restart for explicit teardown.
    this.child?.removeAllListeners()
    this.child = undefined
  }

  private async start(signal?: AbortSignal): Promise<RunningServer> {
    const preferred = this.deps.getPort() ?? DEFAULT_PORT
    const preferredBase = `http://${this.deps.host}:${preferred}`
    if (await isHealthy(this.deps.host, preferred, signal)) {
      if (this.deps.verifyOwnership === undefined || await this.deps.verifyOwnership(preferredBase)) {
        this.adopted = true
        this.port = preferred
        this.deps.output.appendLine(`Adopted a healthy CLIProxyAPI server on port ${preferred}.`)
        return { baseUrl: preferredBase, port: preferred }
      }
      this.deps.output.appendLine(`Port ${preferred} is held by another CLIProxyAPI; starting a separate managed server.`)
    }

    const { binaryPath, version } = await acquireBinary({
      binDir: this.deps.paths.binDir,
      requestedVersion: this.deps.requestedVersion,
      output: this.deps.output,
      ...(signal ? { signal } : {}),
    })
    this.version = version

    const port = (await isFree(this.deps.host, preferred)) ? preferred : await findFreePort(this.deps.host)
    await this.spawnServer(binaryPath, port)
    await waitForHealthz(this.deps.host, port, signal)
    this.adopted = false
    this.port = port
    await this.deps.setPort(port)
    this.deps.output.appendLine(`CLIProxyAPI ${version} is running on port ${port}.`)
    return { baseUrl: this.baseUrl()!, port, version }
  }

  private async spawnServer(binaryPath: string, port: number): Promise<void> {
    await mkdir(this.deps.paths.authDir, { recursive: true })
    // The binary reads its listen port only from the config file, so the config
    // must point at the port we chose before we spawn (and health-check) it.
    await setConfigPort(this.deps.paths.configPath, port)
    const logFd = openSync(this.deps.paths.logPath, 'a')
    try {
      const child = spawn(binaryPath, ['--config', this.deps.paths.configPath], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      })
      this.child = child
      this.stopping = false
      child.unref()
      child.on('exit', (code, sig) => {
        if (this.child === child) {
          this.child = undefined
          this.port = undefined
        }
        if (!this.stopping)
          this.deps.output.appendLine(`CLIProxyAPI exited unexpectedly (code=${code ?? 'null'}, signal=${sig ?? 'null'}); it will restart on next use.`)
      })
      child.on('error', (error) => {
        this.deps.output.appendLine(`CLIProxyAPI process error on port ${port}: ${error.message}`)
      })
    }
    finally {
      closeSync(logFd)
    }
  }
}

async function isHealthy(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, { signal: controller.signal })
    return response.ok
  }
  catch {
    return false
  }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function waitForHealthz(host: string, port: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted)
      throw new Error('Cancelled while waiting for CLIProxyAPI to start.')
    if (await isHealthy(host, port, signal))
      return
    await delay(STARTUP_POLL_MS)
  }
  throw new Error(`CLIProxyAPI did not become healthy on port ${port} within ${STARTUP_TIMEOUT_MS / 1000}s.`)
}

/** True when nothing is already listening on host:port. */
async function isFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, host)
  })
}

async function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, host, () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('Could not allocate a free port.'))))
    })
  })
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
