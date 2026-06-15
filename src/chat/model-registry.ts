import type { CancellationToken, Event, OutputChannel } from 'vscode'
import type { ProxyConnection } from '../cliproxy/connection'
import type { CredentialStore } from '../cliproxy/credentials'
import type { ProviderModel } from './model'
import { EventEmitter, window, workspace } from 'vscode'
import { CLIProxyClient } from '../cliproxy/client'
import { ProxyHttpError } from '../cliproxy/errors'
import { errorMessage } from '../shared/errors'
import { fetchCatalog } from './catalog'
import { mapProxyModels } from './model'

export interface ModelRegistryHooks {
  acquireApiKey: () => Promise<string | undefined>
  onCredentialsRejected: () => void
  onCredentialsAccepted: () => void
}

/**
 * Discovers chat models from the proxy, maps them, caches the result, and fires
 * a change event only when the model set actually changes. Refreshes are
 * deduplicated: concurrent callers share one in-flight discovery.
 */
export class ModelRegistry {
  private readonly changeEmitter = new EventEmitter<void>()
  private cachedModels: ProviderModel[] = []
  private cachedFingerprint = ''
  private refreshPromise: Promise<ProviderModel[]> | undefined

  readonly onDidChange: Event<void> = this.changeEmitter.event

  constructor(
    private readonly connection: ProxyConnection,
    private readonly credentials: CredentialStore,
    private readonly output: OutputChannel,
    private readonly hooks: ModelRegistryHooks,
  ) {}

  dispose(): void {
    this.changeEmitter.dispose()
  }

  isRefreshing(): boolean {
    return this.refreshPromise !== undefined
  }

  reset(): void {
    this.cachedModels = []
    this.cachedFingerprint = ''
    this.changeEmitter.fire()
  }

  async refresh(interactive: boolean, token?: CancellationToken): Promise<ProviderModel[]> {
    if (this.refreshPromise !== undefined)
      return this.refreshPromise
    this.refreshPromise = this.doRefresh(interactive, token).finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  async forceRefresh(interactive = true): Promise<ProviderModel[]> {
    if (this.refreshPromise !== undefined)
      await this.refreshPromise
    return this.refresh(interactive)
  }

  private async doRefresh(interactive: boolean, token?: CancellationToken): Promise<ProviderModel[]> {
    await this.connection.ensureReady(interactive)
    let apiKey = await this.credentials.get()
    if (apiKey === undefined && interactive)
      apiKey = await this.hooks.acquireApiKey()
    if (apiKey === undefined)
      return []

    const controller = new AbortController()
    const cancellation = token?.onCancellationRequested(() => controller.abort())
    try {
      const client = new CLIProxyClient(this.connection.baseUrl(), apiKey)
      const [discovery, catalog] = await Promise.all([
        client.discover(controller.signal),
        fetchCatalog(controller.signal),
      ])
      const settings = workspace.getConfiguration('universalChatProvider')
      const models = mapProxyModels(discovery.available, discovery.metadata, catalog, {
        defaultMaxOutputTokens: settings.get<number>('defaultMaxOutputTokens', 16_384),
        onSkipped: (id, reason) => this.output.appendLine(`Skipped model ${id}: ${reason}.`),
      })
      const fingerprint = JSON.stringify(models)
      if (fingerprint !== this.cachedFingerprint) {
        this.cachedFingerprint = fingerprint
        this.cachedModels = models
        this.changeEmitter.fire()
        this.output.appendLine(`Discovered ${models.length} CLIProxyAPI chat models at ${this.connection.baseUrl()}.`)
      }
      this.hooks.onCredentialsAccepted()
      return this.cachedModels
    }
    catch (error) {
      this.output.appendLine(`Model discovery failed: ${errorMessage(error)}`)
      const rejectedCredentials = error instanceof ProxyHttpError && (error.status === 401 || error.status === 403)
      if (rejectedCredentials)
        this.hooks.onCredentialsRejected()
      else if (interactive)
        void window.showErrorMessage(`CLIProxyAPI model discovery failed: ${errorMessage(error)}`)
      return this.cachedModels
    }
    finally {
      cancellation?.dispose()
    }
  }
}
