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
import { asString } from '../shared/json'
import { CacheMetricsTracker } from './cache-metrics'
import { streamCompletion } from './completion'
import { createContextUsagePart } from './context-usage'
import { CredentialFlows } from './credential-flows'
import { estimateTokens } from './estimate'
import { ModelRegistry } from './model-registry'
import { buildRequest } from './request'

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
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    const request = buildRequest(model, messages, options, model.reasoningEffort)
    const reasoning = new ReasoningTextFallback(
      vscode.workspace.getConfiguration('universalChatProvider').get<boolean>('showReasoning', true),
    )
    await streamCompletion(
      this.completionDeps(),
      request,
      {
        onText: (delta) => {
          const separator = reasoning.close()
          if (separator !== undefined)
            progress.report(new LanguageModelTextPart(separator))
          progress.report(new LanguageModelTextPart(delta))
        },
        onThinking: (delta) => {
          const text = reasoning.format(delta)
          if (text !== undefined)
            progress.report(new LanguageModelTextPart(text))
        },
        onToolCall: (callId, name, input) =>
          progress.report(new LanguageModelToolCallPart(callId, name, input)),
        onUsage: (usage) => {
          this.cacheMetrics.record(usage, {
            model: model.proxyModelId,
            promptCacheKey: asString(request.prompt_cache_key),
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

class ReasoningTextFallback {
  private open = false

  constructor(private readonly enabled: boolean) {}

  format(delta: string): string | undefined {
    if (!this.enabled || delta.length === 0)
      return undefined
    const prefix = this.open ? '' : '> **Thinking**\n> '
    this.open = true
    return `${prefix}${delta.replace(/\n/g, '\n> ')}`
  }

  close(): string | undefined {
    if (!this.open)
      return undefined
    this.open = false
    return '\n\n'
  }
}
