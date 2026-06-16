import type { Disposable, ExtensionContext, OutputChannel } from 'vscode'
import type { ProxyConnection } from './connection'
import type { ManagedPaths } from './managed/config'
import type { ManagedServer } from './managed/server'
import type { ManagementEndpoint } from './management-client'
import type { ServerMode, ServerStatus, ServerStatusSnapshot } from './status'
import { rm } from 'node:fs/promises'
import {
  ConfigurationTarget,
  ProgressLocation,
  window,
  workspace,
} from 'vscode'
import { errorMessage } from '../shared/errors'
import { AccountsService } from './accounts'
import { findConfigPath, normalizeBaseUrl, SECRET_KEY } from './credentials'
import { readLocalProxyConfig } from './local-config'
import { acquireBinary, DEFAULT_BINARY_VERSION } from './managed/binary'
import { MGMT_KEY_SECRET, PORT_STATE_KEY, provisionManagedState, watchAuthDir } from './managed/bootstrap'
import { DEFAULT_HOST, DEFAULT_PORT } from './managed/config'
import { releaseLease } from './managed/leases'
import { LogTailer } from './managed/log-tailer'
import { listReleaseVersions, pickSuggestedUpdate } from './managed/updates'
import { ManagementClient } from './management-client'
import { buildStatusSnapshot } from './status'

export type { ServerMode, ServerStatus, ServerStatusSnapshot } from './status'

/** globalState key holding the one version the user chose to skip suggesting. */
const DISMISSED_UPDATE_KEY = 'universalChatProvider.dismissedUpdateVersion'

export class ServerController implements ProxyConnection {
  private readonly disposables: Disposable[] = []
  private readonly accounts: AccountsService
  private server: ManagedServer | undefined
  private paths: ManagedPaths | undefined
  private managementKey: string | undefined
  private logTailer: LogTailer | undefined
  private bootstrapPromise: Promise<void> | undefined
  private refreshDebounce: ReturnType<typeof setTimeout> | undefined
  private refreshListener: (() => void) | undefined
  private statusListener: ((status: ServerStatus) => void) | undefined
  private lastStatus: ServerStatus = 'starting'
  private updateCheckStarted = false

  constructor(
    private readonly context: ExtensionContext,
    private readonly output: OutputChannel,
    private readonly serverOutput: OutputChannel,
  ) {
    this.accounts = new AccountsService({
      resolveManagement: async start => this.resolveManagement(start),
      currentManagement: () => this.currentManagement(),
      onAccountsChanged: () => this.notifyAccountsChanged(),
    })
  }

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

  async statusSnapshot(): Promise<ServerStatusSnapshot> {
    return buildStatusSnapshot({
      mode: this.mode(),
      lastStatus: this.lastStatus,
      baseUrl: this.baseUrl(),
      version: this.server?.installedVersion(),
      management: await this.managementForStatus(),
    })
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
      void this.accounts.maybePromptLogin()
      void this.maybeSuggestUpdate()
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

  async login(): Promise<void> {
    return this.accounts.login()
  }

  async manageAccounts(): Promise<void> {
    return this.accounts.manageAccounts()
  }

  async updateBinary(): Promise<void> {
    if (this.mode() === 'external') {
      void window.showInformationMessage('Binary updates apply only to the managed server.')
      return
    }
    await this.applyBinaryUpdate(this.requestedVersion())
  }

  /** Acquire `version`, restart the managed server, and surface the outcome. */
  private async applyBinaryUpdate(version: string): Promise<void> {
    try {
      await this.bootstrap()
      await window.withProgress(
        { location: ProgressLocation.Notification, title: 'Updating CLIProxyAPI…' },
        async () => {
          await acquireBinary({ binDir: this.paths!.binDir, requestedVersion: version, output: this.output })
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

  /**
   * Best-effort, once per window: when a newer release within the running
   * binary's major version exists, offer to install it. Never throws.
   */
  private async maybeSuggestUpdate(): Promise<void> {
    if (this.updateCheckStarted)
      return
    const config = workspace.getConfiguration('universalChatProvider')
    if (this.mode() === 'external' || !config.get<boolean>('server.suggestUpdates', true))
      return
    const requested = this.requestedVersion()
    if (requested.toLowerCase() === 'latest')
      return
    const installed = this.server?.installedVersion()
    if (installed === undefined)
      return
    // Claim the once-per-window slot before the first await so concurrent
    // ensureReady calls cannot double-fire the prompt.
    this.updateCheckStarted = true

    let target: string | null
    try {
      target = pickSuggestedUpdate(installed, await listReleaseVersions())
    }
    catch (error) {
      this.output.appendLine(`CLIProxyAPI update check failed: ${errorMessage(error)}`)
      return
    }
    if (target === null || target === this.context.globalState.get<string>(DISMISSED_UPDATE_KEY))
      return

    const update = 'Update'
    const skip = 'Skip This Version'
    const choice = await window.showInformationMessage(
      `CLIProxyAPI ${target} is available (you're on ${installed}).`,
      update,
      skip,
    )
    if (choice === update) {
      await config.update('server.version', target, ConfigurationTarget.Global)
      await this.applyBinaryUpdate(target)
    }
    else if (choice === skip) {
      await this.context.globalState.update(DISMISSED_UPDATE_KEY, target)
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
    this.accounts.reset()
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
    const state = await provisionManagedState({
      context: this.context,
      output: this.output,
      requestedVersion: this.requestedVersion(),
      verifyOwnership: async baseUrl => this.isOwnServer(baseUrl),
    })
    this.paths = state.paths
    this.server = state.server
    this.managementKey = state.managementKey
    this.disposables.push(...watchAuthDir(state.paths.authDir, () => this.scheduleRefresh()))
    // Follow the shared server log into its own channel. The path is stable for
    // the window's lifetime, so one tailer survives re-bootstraps (e.g. reset).
    if (this.logTailer === undefined) {
      this.logTailer = new LogTailer(state.paths.logPath, this.serverOutput).start()
      this.disposables.push(this.logTailer)
    }
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

  private scheduleRefresh(): void {
    if (this.refreshDebounce !== undefined)
      clearTimeout(this.refreshDebounce)
    this.refreshDebounce = setTimeout(() => this.notifyAccountsChanged(), 750)
  }

  private notifyAccountsChanged(): void {
    this.refreshListener?.()
  }

  private async resolveManagement(start: boolean): Promise<ManagementEndpoint | undefined> {
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
      const endpoint = this.currentManagement()
      if (endpoint === undefined) {
        void window.showWarningMessage('The managed CLIProxyAPI server is not ready yet. Try again in a moment.')
        return undefined
      }
      return endpoint
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

  private currentManagement(): ManagementEndpoint | undefined {
    const baseUrl = this.server?.baseUrl()
    if (baseUrl === undefined || this.managementKey === undefined)
      return undefined
    return { baseUrl, key: this.managementKey }
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

  private async managementForStatus(): Promise<ManagementEndpoint | undefined> {
    if (this.mode() === 'external') {
      const key = await this.externalManagementKey()
      return key === undefined ? undefined : { baseUrl: this.baseUrl(), key }
    }
    return this.currentManagement()
  }

  private surfaceStartupError(error: unknown): void {
    this.output.appendLine(`Managed CLIProxyAPI failed to start: ${errorMessage(error)}`)
    void window.showWarningMessage(
      `CLIProxyAPI could not start: ${errorMessage(error)}`,
      'Retry',
      'Show Logs',
      'Show Server Output',
      'Use External Server',
    ).then(async (choice) => {
      if (choice === 'Retry')
        await this.ensureReady(true)
      else if (choice === 'Show Logs')
        this.output.show(true)
      else if (choice === 'Show Server Output')
        this.serverOutput.show(true)
      else if (choice === 'Use External Server')
        await workspace.getConfiguration('universalChatProvider').update('server.mode', 'external', ConfigurationTarget.Global)
    })
  }
}
