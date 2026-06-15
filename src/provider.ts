import type {
  CancellationToken,
  ExtensionContext,
  LanguageModelChatProvider,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart2,
  OutputChannel,
  PrepareLanguageModelChatModelOptions,
  Progress,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode'
import type { LocalProxyConfig } from './local-config'
import type { ProviderModel } from './model'
import {
  EventEmitter,
  LanguageModelError,
  LanguageModelTextPart,
  LanguageModelThinkingPart,
  LanguageModelToolCallPart,
  window,
  workspace,
} from 'vscode'
import { configureConnection, CredentialStore, normalizeBaseUrl } from './credentials'
import { mapProxyModels } from './model'
import { CLIProxyClient, ProxyHttpError } from './proxy-client'
import { buildRequest, buildTextRequest } from './request'
import { countTokens } from './tokenizer'

/**
 * Resolves the proxy connection. The default reads user settings (the external
 * BYO server); the managed controller implements the same shape and additionally
 * starts/supervises a bundled server before reporting its URL.
 */
export interface ProxyConnection {
  ensureReady: (interactive: boolean) => Promise<void>
  baseUrl: () => string
}

class SettingsConnection implements ProxyConnection {
  async ensureReady(): Promise<void> {}

  baseUrl(): string {
    return normalizeBaseUrl(
      workspace.getConfiguration('universalChatProvider').get<string>('baseUrl', 'http://127.0.0.1:8317'),
    )
  }
}

export class UniversalChatProvider implements LanguageModelChatProvider<ProviderModel> {
  private readonly changeEmitter = new EventEmitter<void>()
  private readonly credentials: CredentialStore
  private cachedModels: ProviderModel[] = []
  private cachedFingerprint = ''
  private refreshPromise: Promise<ProviderModel[]> | undefined
  private onboardingShown = false
  private credentialRecoveryShown = false

  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event

  constructor(
    context: ExtensionContext,
    private readonly output: OutputChannel,
    private readonly connection: ProxyConnection = new SettingsConnection(),
  ) {
    this.credentials = new CredentialStore(context)
  }

  dispose(): void {
    this.changeEmitter.dispose()
  }

  async initialize(): Promise<void> {
    await this.connection.ensureReady(false)
    if (await this.credentials.get() === undefined) {
      await this.showOnboarding()
      return
    }
    await this.forceRefresh(false)
  }

  async provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    token: CancellationToken,
  ): Promise<ProviderModel[]> {
    if (token.isCancellationRequested)
      return []
    return this.refresh(!options.silent, token)
  }

  async provideLanguageModelChatResponse(
    model: ProviderModel,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart2>,
    token: CancellationToken,
  ): Promise<void> {
    await this.connection.ensureReady(false)
    const apiKey = await this.credentials.get()
    if (apiKey === undefined)
      throw LanguageModelError.NoPermissions('Configure a CLIProxyAPI API key first.')

    const controller = new AbortController()
    const cancellation = token.onCancellationRequested(() => controller.abort())
    const client = new CLIProxyClient(this.connection.baseUrl(), apiKey)
    const reasoningEffort = stringValue(options.modelConfiguration?.reasoningEffort)

    try {
      await client.streamResponse(
        buildRequest(model, messages, options, reasoningEffort),
        {
          onText: delta => progress.report(new LanguageModelTextPart(delta)),
          onThinking: delta => progress.report(new LanguageModelThinkingPart(delta)),
          onToolCall: (callId, name, input) =>
            progress.report(new LanguageModelToolCallPart(callId, name, input)),
          onUsage: usage => this.output.appendLine(`[usage] ${model.proxyModelId}: ${JSON.stringify(usage)}`),
        },
        controller.signal,
      )
    }
    catch (error) {
      if (token.isCancellationRequested)
        return
      if (error instanceof ProxyHttpError && (error.status === 401 || error.status === 403))
        void this.showCredentialRecovery()
      throw mapProviderError(error)
    }
    finally {
      cancellation.dispose()
    }
  }

  async provideTokenCount(
    _model: ProviderModel,
    value: string | LanguageModelChatRequestMessage,
    token: CancellationToken,
  ): Promise<number> {
    if (token.isCancellationRequested)
      return 0
    return countTokens(value)
  }

  async forceRefresh(interactive = true): Promise<ProviderModel[]> {
    if (this.refreshPromise !== undefined)
      await this.refreshPromise
    return this.refresh(interactive)
  }

  async getModels(
    interactive: boolean,
    token?: CancellationToken,
  ): Promise<readonly ProviderModel[]> {
    return this.refresh(interactive, token)
  }

  async completeText(
    model: ProviderModel,
    prompt: string,
    maxOutputTokens: number,
    token?: CancellationToken,
  ): Promise<string | undefined> {
    if (token?.isCancellationRequested)
      return undefined

    await this.connection.ensureReady(false)
    const apiKey = await this.credentials.get()
    if (apiKey === undefined)
      throw LanguageModelError.NoPermissions('Configure a CLIProxyAPI API key first.')

    const controller = new AbortController()
    const cancellation = token?.onCancellationRequested(() => controller.abort())
    const client = new CLIProxyClient(this.connection.baseUrl(), apiKey)
    let text = ''

    try {
      await client.streamResponse(
        buildTextRequest(model, prompt, maxOutputTokens),
        {
          onText: delta => text += delta,
          onToolCall: () => {},
          onUsage: usage =>
            this.output.appendLine(`[usage] ${model.proxyModelId} (commit message): ${JSON.stringify(usage)}`),
        },
        controller.signal,
      )
      return token?.isCancellationRequested ? undefined : text
    }
    catch (error) {
      if (token?.isCancellationRequested)
        return undefined
      if (error instanceof ProxyHttpError && (error.status === 401 || error.status === 403))
        void this.showCredentialRecovery()
      throw mapProviderError(error)
    }
    finally {
      cancellation?.dispose()
    }
  }

  async importConfig(): Promise<void> {
    await this.importAndRefresh(true)
  }

  async configure(): Promise<void> {
    if (!await configureConnection())
      return
    if (await this.credentials.get() === undefined && await this.credentials.prompt() === undefined)
      return
    this.credentialRecoveryShown = false
    if (this.refreshPromise === undefined)
      await this.forceRefresh(true)
  }

  async clearCredentials(): Promise<void> {
    await this.credentials.clear()
    this.cachedModels = []
    this.cachedFingerprint = ''
    this.changeEmitter.fire()
    await this.showOnboarding(true)
  }

  private async refresh(interactive: boolean, token?: CancellationToken): Promise<ProviderModel[]> {
    if (this.refreshPromise !== undefined)
      return this.refreshPromise
    this.refreshPromise = this.doRefresh(interactive, token).finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  private async doRefresh(interactive: boolean, token?: CancellationToken): Promise<ProviderModel[]> {
    await this.connection.ensureReady(interactive)
    let apiKey = await this.credentials.get()
    if (apiKey === undefined && interactive)
      apiKey = await this.acquireApiKey()
    if (apiKey === undefined)
      return []

    const controller = new AbortController()
    const cancellation = token?.onCancellationRequested(() => controller.abort())
    try {
      const client = new CLIProxyClient(this.connection.baseUrl(), apiKey)
      const discovery = await client.discover(controller.signal)
      const settings = workspace.getConfiguration('universalChatProvider')
      const models = mapProxyModels(discovery.available, discovery.metadata, discovery.catalog, {
        defaultMaxOutputTokens: settings.get<number>('defaultMaxOutputTokens', 16_384),
      })
      const fingerprint = JSON.stringify(models)
      if (fingerprint !== this.cachedFingerprint) {
        this.cachedFingerprint = fingerprint
        this.cachedModels = models
        this.changeEmitter.fire()
      }
      this.credentialRecoveryShown = false
      this.output.appendLine(`Discovered ${models.length} CLIProxyAPI chat models at ${this.connection.baseUrl()}.`)
      return this.cachedModels
    }
    catch (error) {
      this.output.appendLine(`Model discovery failed: ${errorMessage(error)}`)
      const rejectedCredentials = error instanceof ProxyHttpError && (error.status === 401 || error.status === 403)
      if (rejectedCredentials)
        void this.showCredentialRecovery()
      else if (interactive)
        void window.showErrorMessage(`CLIProxyAPI model discovery failed: ${errorMessage(error)}`)
      return this.cachedModels
    }
    finally {
      cancellation?.dispose()
    }
  }

  private async acquireApiKey(): Promise<string | undefined> {
    await this.showOnboarding()
    return this.credentials.get()
  }

  private async showOnboarding(force = false): Promise<void> {
    if (this.onboardingShown && !force)
      return
    this.onboardingShown = true

    let config: LocalProxyConfig | undefined
    try {
      config = await this.credentials.inspectLocalConfig()
    }
    catch (error) {
      this.output.appendLine(`Could not inspect CLIProxyAPI config: ${errorMessage(error)}`)
    }

    if (config?.apiKey !== undefined) {
      const choice = await window.showInformationMessage(
        'A local CLIProxyAPI config was found. Import its API key to load models?',
        'Import API Key',
        'Configure',
      )
      if (choice === 'Import API Key') {
        await this.importAndRefresh(true)
      }
      else if (choice === 'Configure') {
        await this.configure()
      }
      return
    }

    const choice = await window.showInformationMessage(
      'CLIProxyAPI setup is incomplete. Configure a connection to load local models.',
      'Configure Connection',
      'Retry',
    )
    if (choice === 'Configure Connection')
      await this.configure()
    else if (choice === 'Retry')
      await this.showOnboarding(true)
  }

  private async showCredentialRecovery(): Promise<void> {
    if (this.credentialRecoveryShown)
      return
    this.credentialRecoveryShown = true
    const choice = await window.showWarningMessage(
      'CLIProxyAPI rejected the stored API key. Re-import it from the local config or configure the connection.',
      'Re-import API Key',
      'Configure',
    )
    if (choice === 'Re-import API Key') {
      await this.importAndRefresh(false)
    }
    else if (choice === 'Configure') {
      await this.configure()
    }
  }

  private async importAndRefresh(showSuccess: boolean): Promise<void> {
    if (await this.credentials.importFromConfig(true) === undefined)
      return

    this.credentialRecoveryShown = false
    if (this.refreshPromise === undefined)
      await this.forceRefresh(false)
    if (showSuccess)
      void window.showInformationMessage('CLIProxyAPI API key imported and models refreshed.')
  }
}

function mapProviderError(error: unknown): Error {
  if (error instanceof ProxyHttpError) {
    if (error.status === 401 || error.status === 403)
      return LanguageModelError.NoPermissions(error.message)
    if (error.status === 404)
      return LanguageModelError.NotFound(error.message)
    if (error.status === 429)
      return LanguageModelError.Blocked(error.message)
  }
  return error instanceof Error ? error : new Error(String(error))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
