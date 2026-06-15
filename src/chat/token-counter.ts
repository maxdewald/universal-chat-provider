import type { CancellationToken, LanguageModelChatRequestMessage, OutputChannel } from 'vscode'
import type { ProxyConnection } from '../cliproxy/connection'
import type { CredentialStore } from '../cliproxy/credentials'
import type { ProviderModel } from './model'
import { createHash } from 'node:crypto'
import { CLIProxyClient } from '../cliproxy/client'
import { errorMessage } from '../shared/errors'
import { estimateTokens } from './estimate'
import { buildCountPayload, fingerprintCountValue } from './request'

/** Most-recent counts to keep resident; token counts of fixed content never change. */
const MAX_CACHE_ENTRIES = 4096
/** Cap concurrent count requests so prompt building can't flood the proxy. */
const MAX_CONCURRENCY = 8
/** Give up on a single count so a slow proxy can never stall the cache. */
const REQUEST_TIMEOUT_MS = 15_000

export interface TokenCounterDeps {
  connection: ProxyConnection
  credentials: CredentialStore
  output: OutputChannel
}

/**
 * Token counts for VS Code's context-window budgeting. VS Code calls
 * `provideTokenCount` constantly while it assembles and re-renders a prompt, so
 * this must answer instantly and never block: it returns a fast local estimate
 * (`tokenx`), or an exact value once we have one cached.
 *
 * Exact counts come from the proxy's `count_tokens` endpoint (each provider's
 * real tokenizer) and are fetched in the background — once per unique piece of
 * content, coalesced and concurrency-capped — then cached for the rest of the
 * session. The first sighting of new content is served by the estimate; the
 * exact value replaces it on the next count. Budgeting tolerates this staleness:
 * it only decides when to compress, and the server enforces the real limit.
 */
export class TokenCounter {
  private readonly cache = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly deps: TokenCounterDeps) {}

  count(
    model: ProviderModel,
    value: string | LanguageModelChatRequestMessage,
    token?: CancellationToken,
  ): number {
    if (token?.isCancellationRequested)
      return 0

    const key = this.cacheKey(model, value)
    const exact = this.cache.get(key)
    if (exact !== undefined)
      return exact

    this.warm(key, model, value)
    return estimateTokens(value)
  }

  /** Resolve once every in-flight background count has settled (tests, shutdown). */
  async whenIdle(): Promise<void> {
    await Promise.all(this.inFlight.values())
  }

  /**
   * Fetch the exact count in the background and cache it. Deliberately detached
   * from the caller's cancellation token: the call already returned an estimate,
   * so this should run to completion (bounded by its own timeout) and cache the
   * content once, rather than being abandoned and re-fetched on the next render.
   */
  private warm(
    key: string,
    model: ProviderModel,
    value: string | LanguageModelChatRequestMessage,
  ): void {
    if (this.inFlight.has(key))
      return

    const request = this.fetchCount(model, value)
      .then((count) => {
        if (count !== undefined)
          this.remember(key, count)
      })
      .finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, request)
  }

  private async fetchCount(
    model: ProviderModel,
    value: string | LanguageModelChatRequestMessage,
  ): Promise<number | undefined> {
    return this.withSlot(async () => {
      let apiKey: string | undefined
      try {
        await this.deps.connection.ensureReady(false)
        apiKey = await this.deps.credentials.get()
      }
      catch {
        return undefined
      }
      if (apiKey === undefined)
        return undefined

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const client = new CLIProxyClient(this.deps.connection.baseUrl(), apiKey)
        return await client.countInputTokens(buildCountPayload(model, value), controller.signal)
      }
      catch (error) {
        this.deps.output.appendLine(`[token-count] ${model.proxyModelId}: ${errorMessage(error)}`)
        return undefined
      }
      finally {
        clearTimeout(timeout)
      }
    })
  }

  private remember(key: string, count: number): void {
    this.cache.set(key, count)
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined)
        this.cache.delete(oldest)
    }
  }

  private cacheKey(model: ProviderModel, value: string | LanguageModelChatRequestMessage): string {
    return createHash('sha256')
      .update(model.proxyModelId)
      .update('\0')
      .update(fingerprintCountValue(value))
      .digest('hex')
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENCY)
      await new Promise<void>(resolve => this.waiters.push(resolve))
    this.active++
    try {
      return await task()
    }
    finally {
      this.active--
      this.waiters.shift()?.()
    }
  }
}
