import type {
  CancellationToken,
  Event,
  ExtensionContext,
  LanguageModelChatProvider,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart,
  OutputChannel,
  PrepareLanguageModelChatModelOptions,
  Progress,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode'
import type { ProxyConnection } from '../cliproxy/connection'
import type { CompletionDeps } from './completion'
import type { ProviderModel } from './model'
import * as vscode from 'vscode'
import {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
} from 'vscode'
import { SettingsConnection } from '../cliproxy/connection'
import { CredentialStore } from '../cliproxy/credentials'
import { asRecord, asString } from '../shared/json'
import { CacheMetricsTracker } from './cache-metrics'
import { streamCompletion } from './completion'
import { createContextUsagePart } from './context-usage'
import { CredentialFlows } from './credential-flows'
import { estimateTokens } from './estimate'
import { ModelRegistry } from './model-registry'
import { buildRequest } from './request'
import { lowestReasoningEffort } from './utility-model-nudge'

const UTILITY_EFFORTS_KEY = 'universalChatProvider.utilityReasoningEfforts'

// LanguageModelThinkingPart renders reasoning as a collapsible block that shrinks
// once the answer streams in. Its type is still proposed, but the runtime class is
// ungated on stable, so we reach for it directly and type the result as a regular
// response part.
const LanguageModelThinkingPart = (vscode as unknown as {
  LanguageModelThinkingPart: new (value: string, id?: string) => LanguageModelResponsePart
}).LanguageModelThinkingPart

export class UniversalChatProvider implements LanguageModelChatProvider<ProviderModel> {
  private readonly credentials: CredentialStore
  private readonly registry: ModelRegistry
  private readonly credentialFlows: CredentialFlows
  private readonly cacheMetrics: CacheMetricsTracker

  constructor(
    private readonly context: ExtensionContext,
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
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    // modelConfiguration carries the reasoning effort the user picked from the
    // model's configurationSchema dropdown; fall back to the model's default.
    const requestOptions = options as { modelConfiguration?: { reasoningEffort?: string }, requestInitiator?: string }
    const storedUtilityEffort = this.getUtilityEffort(model.id)
    const utilityEffort = storedUtilityEffort !== undefined && model.reasoningLevels.includes(storedUtilityEffort)
      ? storedUtilityEffort
      : lowestReasoningEffort(model.reasoningLevels)
    const chosenEffort = requestOptions.requestInitiator === 'core'
      ? utilityEffort ?? requestOptions.modelConfiguration?.reasoningEffort ?? model.reasoningEffort
      : requestOptions.modelConfiguration?.reasoningEffort ?? model.reasoningEffort
    const request = buildRequest(model, messages, options, chosenEffort)
    await streamCompletion(
      this.completionDeps(),
      request,
      {
        onText: (delta) => {
          progress.report(new LanguageModelTextPart(delta))
        },
        onThinking: (delta) => {
          progress.report(new LanguageModelThinkingPart(delta, 'thinking'))
        },
        onToolCall: (callId, name, input) =>
          progress.report(new LanguageModelToolCallPart(callId, name, input)),
        onUsage: (usage) => {
          this.cacheMetrics.record(usage, {
            model: model.proxyModelId,
            promptCacheKey: asString(request.prompt_cache_key),
            reasoningEffort: asString(asRecord(request.reasoning)?.effort),
            inputItems: request.input as readonly unknown[],
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

  getUtilityEffort(modelId: string): string | undefined {
    return this.context.globalState.get<Record<string, string>>(UTILITY_EFFORTS_KEY, {})[modelId]
  }

  async updateUtilityEffort(modelId: string, effort: string | undefined): Promise<void> {
    const next = { ...this.context.globalState.get<Record<string, string>>(UTILITY_EFFORTS_KEY, {}) }
    if (effort === undefined)
      delete next[modelId]
    else
      next[modelId] = effort
    await this.context.globalState.update(UTILITY_EFFORTS_KEY, next)
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
