import type { Disposable, ExtensionContext, OutputChannel } from 'vscode'
import type { ProxyConnection } from '../provider'
import type { ManagedPaths } from './config'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import {
  ConfigurationTarget,
  env,
  ProgressLocation,
  RelativePattern,
  Uri,
  window,
  workspace,
} from 'vscode'
import { findConfigPath, normalizeBaseUrl, SECRET_KEY } from '../credentials'
import { readLocalProxyConfig } from '../local-config'
import { acquireBinary, DEFAULT_BINARY_VERSION } from './binary'
import {
  buildManagedConfig,
  DEFAULT_HOST,
  DEFAULT_PORT,
  generateSecret,
  managedPaths,
} from './config'
import { claimLease, releaseLease } from './lifecycle'
import { LOGIN_PROVIDERS, ManagementClient } from './management'
import { ManagedServer } from './server'

const MGMT_KEY_SECRET = 'universalChatProvider.managementKey'
const PORT_STATE_KEY = 'universalChatProvider.managedPort'
const LOGIN_TIMEOUT_MS = 180_000
const LOGIN_POLL_MS = 1500
const STATUS_PROBE_TIMEOUT_MS = 1500

export type ServerMode = 'managed' | 'external'
export type ServerStatus = 'external' | 'starting' | 'running' | 'error'

/** A point-in-time view of the proxy for the manage picker's status entry. */
export interface ServerStatusSnapshot {
  mode: ServerMode
  status: ServerStatus
  baseUrl: string
  /** Managed binary version, when this window spawned it (absent when adopted). */
  version?: string
  /** Connected provider accounts, when the server could be reached. */
  accounts?: number
}

/**
 * Owns the managed-server experience and exposes the {@link ProxyConnection} the
 * provider talks to. In `external` mode it falls back to user settings, so the
 * provider needs no knowledge of which mode is active.
 */
export class ServerController implements ProxyConnection {
  private readonly disposables: Disposable[] = []
  private server: ManagedServer | undefined
  private paths: ManagedPaths | undefined
  private managementKey: string | undefined
  private bootstrapPromise: Promise<void> | undefined
  private loginPrompted = false
  private refreshDebounce: ReturnType<typeof setTimeout> | undefined
  private refreshListener: (() => void) | undefined
  private statusListener: ((status: ServerStatus) => void) | undefined
  private lastStatus: ServerStatus = 'starting'

  constructor(
    private readonly context: ExtensionContext,
    private readonly output: OutputChannel,
  ) {}

  mode(): ServerMode {
    return workspace.getConfiguration('universalChatProvider').get<string>('server.mode', 'managed') === 'external'
      ? 'external'
      : 'managed'
  }

  baseUrl(): string {
    if (this.mode() === 'external')
      return normalizeBaseUrl(workspace.getConfiguration('universalChatProvider').get<string>('baseUrl', `http://${DEFAULT_HOST}:${DEFAULT_PORT}`))
    return this.server?.baseUrl()
      ?? `http://${DEFAULT_HOST}:${this.context.globalState.get<number>(PORT_STATE_KEY) ?? DEFAULT_PORT}`
  }

  /**
   * Snapshot the proxy for the manage picker's status row. Cheap by design: it
   * reports the last pushed status rather than re-probing health, and only the
   * account count touches the network (best-effort, never starting the server).
   */
  async statusSnapshot(): Promise<ServerStatusSnapshot> {
    const mode = this.mode()
    const version = this.server?.installedVersion()
    const snapshot: ServerStatusSnapshot = {
      mode,
      status: mode === 'external' ? 'external' : this.lastStatus,
      baseUrl: this.baseUrl(),
      ...(version !== undefined ? { version } : {}),
    }
    const accounts = await this.countAccounts()
    return accounts === undefined ? snapshot : { ...snapshot, accounts }
  }

  async ensureReady(_interactive: boolean): Promise<void> {
    if (this.mode() === 'external') {
      this.setStatus('external')
      return
    }
    // Called before every request; only show "starting" when the server is not
    // already up so the status bar does not flicker on each call.
    const alreadyUp = this.server?.baseUrl() !== undefined
    try {
      if (!alreadyUp)
        this.setStatus('starting')
      await this.bootstrap()
      await this.server!.ensureRunning()
      this.setStatus('running')
      void this.maybePromptLogin()
    }
    catch (error) {
      this.setStatus('error')
      this.surfaceStartupError(error)
    }
  }

  setRefreshListener(listener: () => void): void {
    this.refreshListener = listener
  }

  setStatusListener(listener: (status: ServerStatus) => void): void {
    this.statusListener = listener
  }

  /** Open the provider OAuth login flow against whichever server is active. */
  async login(): Promise<void> {
    const management = await this.resolveManagement(true)
    if (management === undefined)
      return

    const picked = await window.showQuickPick(
      LOGIN_PROVIDERS.map(provider => ({ label: provider.label, detail: provider.detail, provider })),
      { title: 'Connect a CLIProxyAPI Account', placeHolder: 'Choose a provider to sign in with' },
    )
    if (picked === undefined)
      return

    const client = new ManagementClient(management.baseUrl, management.key)
    let url: string
    let before: number
    try {
      before = (await client.listAuthFiles()).length
      url = (await client.requestAuthUrl(picked.provider.endpoint)).url
    }
    catch (error) {
      void window.showErrorMessage(`Could not start ${picked.provider.label} login: ${errorMessage(error)}`)
      return
    }

    const opened = await env.openExternal(Uri.parse(url))
    if (!opened) {
      void window.showWarningMessage(`Open this URL to finish signing in: ${url}`)
      return
    }

    const connected = await window.withProgress(
      { location: ProgressLocation.Notification, cancellable: true, title: `Waiting for ${picked.provider.label} sign-in…` },
      async (_progress, token) => {
        const deadline = Date.now() + LOGIN_TIMEOUT_MS
        while (Date.now() < deadline && !token.isCancellationRequested) {
          await delay(LOGIN_POLL_MS)
          const files = await client.listAuthFiles().catch(() => [])
          if (files.length > before)
            return true
        }
        return false
      },
    )

    if (connected) {
      void window.showInformationMessage(`${picked.provider.label} account connected.`)
      this.notifyAccountsChanged()
    }
    else {
      void window.showWarningMessage(`${picked.provider.label} sign-in did not complete. Check Show Logs and try again.`)
    }
  }

  /** List connected accounts and optionally remove one. */
  async manageAccounts(): Promise<void> {
    const management = await this.resolveManagement(false)
    if (management === undefined)
      return
    const client = new ManagementClient(management.baseUrl, management.key)
    const files = await client.listAuthFiles().catch((error): undefined => {
      void window.showErrorMessage(`Could not list accounts: ${errorMessage(error)}`)
      return undefined
    })
    if (files === undefined)
      return
    if (files.length === 0) {
      const choice = await window.showInformationMessage('No accounts are connected.', 'Add Account')
      if (choice === 'Add Account')
        await this.login()
      return
    }

    const picked = await window.showQuickPick(
      files.map(file => ({ label: file.name, ...(file.type !== undefined ? { description: file.type } : {}) })),
      { title: 'Connected Accounts', placeHolder: 'Select an account to remove' },
    )
    if (picked === undefined)
      return
    const confirm = await window.showWarningMessage(`Remove the account ${picked.label}?`, { modal: true }, 'Remove')
    if (confirm !== 'Remove')
      return
    try {
      await client.deleteAuthFile(picked.label)
      void window.showInformationMessage(`Removed ${picked.label}.`)
      this.notifyAccountsChanged()
    }
    catch (error) {
      void window.showErrorMessage(`Could not remove ${picked.label}: ${errorMessage(error)}`)
    }
  }

  async updateBinary(): Promise<void> {
    if (this.mode() === 'external') {
      void window.showInformationMessage('Binary updates apply only to the managed server.')
      return
    }
    try {
      await this.bootstrap()
      await window.withProgress(
        { location: ProgressLocation.Notification, title: 'Updating CLIProxyAPI…' },
        async () => {
          await acquireBinary({ binDir: this.paths!.binDir, requestedVersion: this.requestedVersion(), output: this.output })
          await this.server!.restart()
        },
      )
      this.setStatus('running')
      void window.showInformationMessage('CLIProxyAPI updated and restarted.')
      this.notifyAccountsChanged()
    }
    catch (error) {
      void window.showErrorMessage(`Could not update CLIProxyAPI: ${errorMessage(error)}`)
    }
  }

  async restartServer(): Promise<void> {
    if (this.mode() === 'external') {
      void window.showInformationMessage('The managed server is not active in external mode.')
      return
    }
    try {
      await this.bootstrap()
      await this.server!.restart()
      this.setStatus('running')
      void window.showInformationMessage('Managed CLIProxyAPI restarted.')
      this.notifyAccountsChanged()
    }
    catch (error) {
      this.setStatus('error')
      void window.showErrorMessage(`Could not restart CLIProxyAPI: ${errorMessage(error)}`)
    }
  }

  /** Stop the server and discard generated config + secrets (keeps accounts). */
  async resetServer(): Promise<void> {
    const confirm = await window.showWarningMessage(
      'Reset the managed CLIProxyAPI server? Generated config and keys are recreated; connected accounts are kept.',
      { modal: true },
      'Reset',
    )
    if (confirm !== 'Reset')
      return
    await this.server?.stop()
    if (this.paths !== undefined)
      await rm(this.paths.configPath, { force: true })
    await this.context.secrets.delete(SECRET_KEY)
    await this.context.secrets.delete(MGMT_KEY_SECRET)
    this.bootstrapPromise = undefined
    this.loginPrompted = false
    this.managementKey = undefined
    await this.ensureReady(true)
  }

  dispose(): void {
    if (this.refreshDebounce !== undefined)
      clearTimeout(this.refreshDebounce)
    for (const disposable of this.disposables.splice(0))
      disposable.dispose()
    // Release this window's lease. When it was the last one the shared sidecar
    // is no longer used, so stop it; otherwise let it run for the other windows.
    if (this.paths !== undefined && releaseLease(this.paths.leaseDir))
      this.server?.shutdown()
    else
      this.server?.dispose()
  }

  private requestedVersion(): string {
    return workspace.getConfiguration('universalChatProvider').get<string>('server.version', DEFAULT_BINARY_VERSION).trim()
      || DEFAULT_BINARY_VERSION
  }

  private async bootstrap(): Promise<void> {
    if (this.bootstrapPromise === undefined) {
      this.bootstrapPromise = this.doBootstrap().catch((error: unknown) => {
        this.bootstrapPromise = undefined
        throw error
      })
    }
    return this.bootstrapPromise
  }

  private async doBootstrap(): Promise<void> {
    const paths = managedPaths(this.context.globalStorageUri.fsPath)
    this.paths = paths
    await mkdir(paths.root, { recursive: true })
    await mkdir(paths.authDir, { recursive: true })
    // Register this window so the last one to close knows to stop the sidecar.
    claimLease(paths.leaseDir)

    const apiKey = await this.ensureSecret(SECRET_KEY)
    this.managementKey = await this.ensureSecret(MGMT_KEY_SECRET)

    if (!(await exists(paths.configPath))) {
      const port = this.context.globalState.get<number>(PORT_STATE_KEY) ?? DEFAULT_PORT
      await writeFile(paths.configPath, buildManagedConfig({
        host: DEFAULT_HOST,
        port,
        apiKey,
        managementKey: this.managementKey,
        authDir: paths.authDir,
      }))
      this.output.appendLine(`Wrote managed CLIProxyAPI config to ${paths.configPath}.`)
    }

    this.server = new ManagedServer({
      paths,
      output: this.output,
      host: DEFAULT_HOST,
      requestedVersion: this.requestedVersion(),
      getPort: () => this.context.globalState.get<number>(PORT_STATE_KEY),
      setPort: port => this.context.globalState.update(PORT_STATE_KEY, port),
      verifyOwnership: async baseUrl => this.isOwnServer(baseUrl),
    })
    this.setupWatcher(paths)
  }

  /** A healthy server is ours only if it accepts our management key. */
  private async isOwnServer(baseUrl: string): Promise<boolean> {
    if (this.managementKey === undefined)
      return false
    try {
      await new ManagementClient(baseUrl, this.managementKey).listAuthFiles()
      return true
    }
    catch {
      return false
    }
  }

  private async ensureSecret(key: string): Promise<string> {
    const existing = await this.context.secrets.get(key)
    if (existing !== undefined && existing.length > 0)
      return existing
    const value = generateSecret()
    await this.context.secrets.store(key, value)
    return value
  }

  private setupWatcher(paths: ManagedPaths): void {
    const watcher = workspace.createFileSystemWatcher(new RelativePattern(Uri.file(paths.authDir), '**'))
    const handler = (): void => this.scheduleRefresh()
    this.disposables.push(
      watcher,
      watcher.onDidCreate(handler),
      watcher.onDidChange(handler),
      watcher.onDidDelete(handler),
    )
  }

  private scheduleRefresh(): void {
    if (this.refreshDebounce !== undefined)
      clearTimeout(this.refreshDebounce)
    this.refreshDebounce = setTimeout(() => this.notifyAccountsChanged(), 750)
  }

  private notifyAccountsChanged(): void {
    this.refreshListener?.()
  }

  private async maybePromptLogin(): Promise<void> {
    if (this.loginPrompted || this.managementKey === undefined || this.server === undefined)
      return
    this.loginPrompted = true
    try {
      const client = new ManagementClient(this.server.baseUrl()!, this.managementKey)
      if ((await client.listAuthFiles()).length > 0)
        return
      const choice = await window.showInformationMessage(
        'CLIProxyAPI is running but no model accounts are connected yet.',
        'Add Account',
        'Later',
      )
      if (choice === 'Add Account')
        await this.login()
    }
    catch {}
  }

  private async resolveManagement(start: boolean): Promise<{ baseUrl: string, key: string } | undefined> {
    if (this.mode() === 'managed') {
      if (start) {
        await this.ensureReady(true)
      }
      else {
        try {
          await this.bootstrap()
          await this.server!.ensureRunning()
        }
        catch {}
      }
      if (this.server?.baseUrl() === undefined || this.managementKey === undefined) {
        void window.showWarningMessage('The managed CLIProxyAPI server is not ready yet. Try again in a moment.')
        return undefined
      }
      return { baseUrl: this.server.baseUrl()!, key: this.managementKey }
    }

    const key = await this.externalManagementKey()
    if (key === undefined) {
      void window.showWarningMessage(
        'To manage accounts on your own server, set remote-management.secret-key (plaintext) in its config.yaml.',
      )
      return undefined
    }
    return { baseUrl: this.baseUrl(), key }
  }

  private async externalManagementKey(): Promise<string | undefined> {
    const override = await this.context.secrets.get(MGMT_KEY_SECRET)
    if (override !== undefined && override.length > 0)
      return override
    const configPath = await findConfigPath()
    if (configPath === undefined)
      return undefined
    try {
      return (await readLocalProxyConfig(configPath)).managementKey
    }
    catch {
      return undefined
    }
  }

  private setStatus(status: ServerStatus): void {
    this.lastStatus = status
    this.statusListener?.(status)
  }

  /**
   * Best-effort count of connected accounts for the status row. Returns
   * undefined whenever the server is unreachable or no management key is known,
   * and never starts a managed server just to answer.
   */
  private async countAccounts(): Promise<number | undefined> {
    const management = await this.managementForStatus()
    if (management === undefined)
      return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS)
    try {
      const files = await new ManagementClient(management.baseUrl, management.key).listAuthFiles(controller.signal)
      return files.length
    }
    catch {
      return undefined
    }
    finally {
      clearTimeout(timer)
    }
  }

  /** Management endpoint for a status probe, only when one is already known. */
  private async managementForStatus(): Promise<{ baseUrl: string, key: string } | undefined> {
    if (this.mode() === 'external') {
      const key = await this.externalManagementKey()
      return key === undefined ? undefined : { baseUrl: this.baseUrl(), key }
    }
    const baseUrl = this.server?.baseUrl()
    if (baseUrl === undefined || this.managementKey === undefined)
      return undefined
    return { baseUrl, key: this.managementKey }
  }

  private surfaceStartupError(error: unknown): void {
    this.output.appendLine(`Managed CLIProxyAPI failed to start: ${errorMessage(error)}`)
    void window.showWarningMessage(
      `CLIProxyAPI could not start: ${errorMessage(error)}`,
      'Retry',
      'Show Logs',
      'Use External Server',
    ).then(async (choice) => {
      if (choice === 'Retry')
        await this.ensureReady(true)
      else if (choice === 'Show Logs')
        this.output.show(true)
      else if (choice === 'Use External Server')
        await workspace.getConfiguration('universalChatProvider').update('server.mode', 'external', ConfigurationTarget.Global)
    })
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
