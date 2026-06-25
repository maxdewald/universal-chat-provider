import type { ChildProcess } from 'node:child_process'
import type { OutputChannel } from 'vscode'
import type { ManagedPaths } from './config'
import { spawn } from 'node:child_process'
import { closeSync, openSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import process from 'node:process'
import getPort from 'get-port'
import ky from 'ky'
import { sleep } from 'moderndash'
import { acquireBinary, readInstalledVersion } from './binary'
import { DEFAULT_PORT, setConfigPort } from './config'
import { readServerPid, writeServerPid } from './leases'

const HEALTH_TIMEOUT_MS = 1500
const STARTUP_TIMEOUT_MS = 20_000
const STARTUP_POLL_MS = 300

export interface ServerDeps {
  paths: ManagedPaths
  output: OutputChannel
  host: string
  requestedVersion: () => string
  getPort: () => number | undefined
  setPort: (port: number) => void | Thenable<void>
  verifyOwnership?: (baseUrl: string) => Promise<boolean>
}

export interface RunningServer {
  baseUrl: string
  port: number
  version?: string
}

export class ManagedServer {
  private child: ChildProcess | undefined
  private adopted = false
  private port: number | undefined
  private version: string | undefined
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
    const child = this.child
    this.child = undefined
    this.adopted = false
    this.port = undefined
    if (child !== undefined && child.exitCode === null) {
      child.kill()
      this.deps.output.appendLine('Stopped the managed CLIProxyAPI server.')
    }
  }

  dispose(): void {
    this.child?.removeAllListeners()
    this.child = undefined
  }

  shutdown(): void {
    const child = this.child
    this.child = undefined
    this.adopted = false
    this.port = undefined
    if (child !== undefined && child.exitCode === null) {
      child.kill()
    }
    else {
      const pid = readServerPid(this.deps.paths.pidPath)
      if (pid !== undefined) {
        try {
          process.kill(pid)
        }
        catch {}
      }
    }
    rmSync(this.deps.paths.pidPath, { force: true })
  }

  private async start(signal?: AbortSignal): Promise<RunningServer> {
    const preferred = this.deps.getPort() ?? DEFAULT_PORT
    const preferredBase = `http://${this.deps.host}:${preferred}`
    if (await isHealthy(this.deps.host, preferred, signal)) {
      if (this.deps.verifyOwnership === undefined || await this.deps.verifyOwnership(preferredBase)) {
        this.adopted = true
        this.port = preferred
        this.version = await readInstalledVersion(this.deps.paths.binDir)
        this.deps.output.appendLine(`Adopted a healthy CLIProxyAPI server on port ${preferred}.`)
        return { baseUrl: preferredBase, port: preferred, ...(this.version !== undefined ? { version: this.version } : {}) }
      }
      this.deps.output.appendLine(`Port ${preferred} is held by another CLIProxyAPI; starting a separate managed server.`)
    }

    const { binaryPath, version } = await acquireBinary({
      binDir: this.deps.paths.binDir,
      requestedVersion: this.deps.requestedVersion(),
      output: this.deps.output,
      ...(signal ? { signal } : {}),
    })
    this.version = version

    const port = await getPort({ port: preferred, host: this.deps.host })
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
    await setConfigPort(this.deps.paths.configPath, port)
    const logFd = openSync(this.deps.paths.logPath, 'a')
    try {
      const child = spawn(binaryPath, ['--config', this.deps.paths.configPath], {
        cwd: this.deps.paths.root,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      })
      this.child = child
      if (child.pid !== undefined)
        writeServerPid(this.deps.paths.pidPath, child.pid)
      child.unref()
      child.on('exit', (code, sig) => {
        if (this.child === child) {
          this.child = undefined
          this.port = undefined
          this.deps.output.appendLine(`CLIProxyAPI exited unexpectedly (code=${code ?? 'null'}, signal=${sig ?? 'null'}); it will restart on next use.`)
        }
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
  try {
    const response = await ky.get(`http://${host}:${port}/healthz`, {
      timeout: HEALTH_TIMEOUT_MS,
      retry: 0,
      throwHttpErrors: false,
      signal: signal ?? null,
    })
    return response.ok
  }
  catch {
    return false
  }
}

async function waitForHealthz(host: string, port: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted)
      throw new Error('Cancelled while waiting for CLIProxyAPI to start.')
    if (await isHealthy(host, port, signal))
      return
    await sleep(STARTUP_POLL_MS)
  }
  throw new Error(`CLIProxyAPI did not become healthy on port ${port} within ${STARTUP_TIMEOUT_MS / 1000}s.`)
}
