import type {
  CancellationToken,
  Event,
  ExtensionContext,
  LanguageModelChatProvider,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart2,
  OutputChannel,
  PrepareLanguageModelChatModelOptions,
  Progress,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode'
import type { ProxyConnection } from '../cliproxy/connection'
import type { CompletionDeps } from './completion'
import type { ProviderModel } from './model'
import {
  LanguageModelTextPart,
  LanguageModelThinkingPart,
  LanguageModelToolCallPart,
} from 'vscode'
import { SettingsConnection } from '../cliproxy/connection'
import { CredentialStore } from '../cliproxy/credentials'
import { asString } from '../shared/json'
import { CacheMetricsTracker } from './cache-metrics'
import { streamCompletion } from './completion'
import { createContextUsagePart } from './context-usage'
import { CredentialFlows } from './credential-flows'
import { estimateTokens } from './estimate'
import { ModelRegistry } from './model-registry'
import { buildRequest, buildTextRequest } from './request'

export class UniversalChatProvider implements LanguageModelChatProvider<ProviderModel> {
  private readonly credentials: CredentialStore
  private readonly registry: ModelRegistry
  private readonly credentialFlows: CredentialFlows
  private readonly cacheMetrics: CacheMetricsTracker

  constructor(
    context: ExtensionContext,
    private readonly output: OutputChannel,
    private readonly connection: ProxyConnection = new SettingsConnection(),
  ) {
    this.credentials = new CredentialStore(context)
    this.registry = new ModelRegistry(connection, this.credentials, output, {
      acquireApiKey: async () => this.credentialFlows.acquireApiKey(),
      onCredentialsRejected: () => void this.credentialFlows.showCredentialRecovery(),
      onCredentialsAccepted: () => this.credentialFlows.markCredentialsAccepted(),
    })
    this.credentialFlows = new CredentialFlows(this.credentials, this.registry, output)
    this.cacheMetrics = new CacheMetricsTracker(context, output)
  }

  get onDidChangeLanguageModelChatInformation(): Event<void> {
    return this.registry.onDidChange
  }

  dispose(): void {
    this.registry.dispose()
    this.cacheMetrics.dispose()
  }

  async initialize(): Promise<void> {
    await this.connection.ensureReady(false)
    if (await this.credentials.get() === undefined) {
      await this.credentialFlows.showOnboarding()
      return
    }
    await this.registry.forceRefresh(false)
  }

  async provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    token: CancellationToken,
  ): Promise<ProviderModel[]> {
    if (token.isCancellationRequested)
      return []
    return this.registry.refresh(!options.silent, token)
  }

  async provideLanguageModelChatResponse(
    model: ProviderModel,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart2>,
    token: CancellationToken,
  ): Promise<void> {
    const reasoningEffort = asString(options.modelConfiguration?.reasoningEffort)
    const request = buildRequest(model, messages, options, reasoningEffort)
    await streamCompletion(
      this.completionDeps(),
      request,
      {
        onText: delta => progress.report(new LanguageModelTextPart(delta)),
        onThinking: delta => progress.report(new LanguageModelThinkingPart(delta)),
        onToolCall: (callId, name, input) =>
          progress.report(new LanguageModelToolCallPart(callId, name, input)),
        onUsage: (usage) => {
          this.cacheMetrics.record(usage, {
            model: model.proxyModelId,
            promptCacheKey: asString(request.prompt_cache_key),
            requestInitiator: options.requestInitiator,
          })
          const part = createContextUsagePart(usage)
          if (part !== undefined)
            progress.report(part)
        },
      },
      token,
    )
  }

  async provideTokenCount(
    _model: ProviderModel,
    value: string | LanguageModelChatRequestMessage,
    token: CancellationToken,
  ): Promise<number> {
    if (token.isCancellationRequested)
      return 0
    return estimateTokens(value)
  }

  async getModels(interactive: boolean, token?: CancellationToken): Promise<readonly ProviderModel[]> {
    return this.registry.refresh(interactive, token)
  }

  async forceRefresh(interactive = true): Promise<ProviderModel[]> {
    return this.registry.forceRefresh(interactive)
  }

  async completeText(
    model: ProviderModel,
    prompt: string,
    maxOutputTokens: number,
    token?: CancellationToken,
  ): Promise<string | undefined> {
    if (token?.isCancellationRequested)
      return undefined

    let text = ''
    await streamCompletion(
      this.completionDeps(),
      buildTextRequest(model, prompt, maxOutputTokens),
      {
        onText: (delta) => { text += delta },
        onToolCall: () => {},
        onUsage: usage => this.cacheMetrics.record(usage, {
          model: model.proxyModelId,
          label: 'commit message',
        }),
      },
      token,
    )
    return token?.isCancellationRequested ? undefined : text
  }

  async configure(): Promise<void> {
    return this.credentialFlows.configure()
  }

  async importConfig(): Promise<void> {
    return this.credentialFlows.importConfig()
  }

  async clearCredentials(): Promise<void> {
    return this.credentialFlows.clearCredentials()
  }

  private completionDeps(): CompletionDeps {
    return {
      connection: this.connection,
      credentials: this.credentials,
      onCredentialsRejected: () => void this.credentialFlows.showCredentialRecovery(),
    }
  }
}
