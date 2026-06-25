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
import type { QuotaReport } from '../cliproxy/quota'
import type { CompletionDeps } from './completion'
import type { ProviderModel } from './model'
import * as vscode from 'vscode'
import {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
} from 'vscode'
import { SettingsConnection } from '../cliproxy/connection'
import { CredentialStore } from '../cliproxy/credentials'
import { remainingForModel } from '../cliproxy/quota'
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

const LanguageModelThinkingPart = (vscode as unknown as {
  LanguageModelThinkingPart: new (value: string, id?: string) => LanguageModelResponsePart
}).LanguageModelThinkingPart

export class UniversalChatProvider implements LanguageModelChatProvider<ProviderModel> {
  private readonly credentials: CredentialStore
  private readonly registry: ModelRegistry
  private readonly credentialFlows: CredentialFlows
  private readonly cacheMetrics: CacheMetricsTracker
  private quotaReports: QuotaReport[] = []
  private lastUsedModel: { proxyModelId: string, proxyOwner: string, name: string } | undefined
  // Fired after each request so the host can re-render the status bar for the active model and
  // refresh quota (throttled) once the spend has landed. Wired by the extension entrypoint.
  onActivity: (() => void) | undefined

  constructor(
    private readonly context: ExtensionContext,
    private readonly output: OutputChannel,
    private readonly connection: ProxyConnection = new SettingsConnection(),
    private readonly onSignIn?: () => Promise<void>,
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

  setQuotas(reports: QuotaReport[]): void {
    this.quotaReports = reports
  }

  // Remaining quota for the model in the most recent request, or undefined when no model has run
  // yet or its provider exposes no quota. Drives the status-bar low-quota warning.
  currentModelQuota(): { name: string, remainingPercent: number } | undefined {
    if (this.lastUsedModel === undefined)
      return undefined
    const remaining = remainingForModel(this.quotaReports, this.lastUsedModel)
    return remaining === undefined ? undefined : { name: this.lastUsedModel.name, remainingPercent: remaining }
  }

  // Structured quota for the menu: Codex as its account windows (5h/7d), Antigravity per model.
  quotaSections(): Array<{ title: string, entries: Array<{ name: string, remainingPercent: number | undefined }> }> {
    const sections: Array<{ title: string, entries: Array<{ name: string, remainingPercent: number | undefined }> }> = []
    const codex = this.quotaReports.find(report => report.provider === 'codex' && report.error === undefined)
    if (codex !== undefined && codex.windows.length > 0)
      sections.push({ title: 'Codex', entries: codex.windows.map(window => ({ name: window.label, remainingPercent: window.remainingPercent })) })

    const claude = this.quotaReports.find(report => report.provider === 'claude' && report.error === undefined)
    if (claude !== undefined && claude.windows.length > 0)
      sections.push({ title: 'Claude', entries: claude.windows.map(window => ({ name: window.label, remainingPercent: window.remainingPercent })) })

    const antigravity = this.quotaReports.find(report => report.provider === 'antigravity' && report.error === undefined)
    const models = antigravity?.models
    if (models !== undefined) {
      const entries = this.registry.snapshot()
        .filter(model => model.proxyOwner.toLowerCase() === 'antigravity' && models[model.proxyModelId] !== undefined)
        .map(model => ({ name: model.name, remainingPercent: models[model.proxyModelId]! }))
        .sort((a, b) => (a.remainingPercent ?? 101) - (b.remainingPercent ?? 101))
      if (entries.length > 0)
        sections.push({ title: 'Antigravity', entries })
    }
    return sections
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
    // Interactive resolve (silent:false) only happens when the user picks us in "Add Models",
    // so open the account login flow first; the refresh then shows whatever they connected.
    if (!options.silent && this.onSignIn !== undefined) {
      await this.onSignIn()
      return this.registry.forceRefresh(false)
    }
    return this.registry.refresh(!options.silent, token)
  }

  async provideLanguageModelChatResponse(
    model: ProviderModel,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    this.lastUsedModel = { proxyModelId: model.proxyModelId, proxyOwner: model.proxyOwner, name: model.name }
    const requestOptions = options as { modelConfiguration?: { reasoningEffort?: string }, requestInitiator?: string }
    const storedUtilityEffort = this.getUtilityEffort(model.id)
    const utilityEffort = storedUtilityEffort !== undefined && model.reasoningLevels.includes(storedUtilityEffort)
      ? storedUtilityEffort
      : lowestReasoningEffort(model.reasoningLevels)
    const chosenEffort = requestOptions.requestInitiator === 'core'
      ? utilityEffort ?? requestOptions.modelConfiguration?.reasoningEffort ?? model.reasoningEffort
      : requestOptions.modelConfiguration?.reasoningEffort ?? model.reasoningEffort
    const request = buildRequest(model, messages, options, chosenEffort)
    try {
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
    finally {
      // Spend just happened — let the host refresh quota (throttled) so the warning stays current.
      this.onActivity?.()
    }
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
