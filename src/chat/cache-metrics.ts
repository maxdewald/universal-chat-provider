import type { ExtensionContext, OutputChannel, StatusBarItem } from 'vscode'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { StatusBarAlignment, window, workspace } from 'vscode'
import { errorMessage } from '../shared/errors'
import { asRecord } from '../shared/json'

/** Opt-in: persist per-request cache metrics and show the live status bar. */
const ENABLED_SETTING = 'cacheMetrics.enabled'
/** Append-only metrics log, kept in the extension's global storage. */
const LOG_FILE = 'cache-metrics.jsonl'

export type UsageShape = 'anthropic' | 'openai' | 'unknown'

export interface UsageSummary {
  shape: UsageShape
  /** Total prompt tokens: cache read + cache write + uncached. */
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  uncachedInputTokens: number
  outputTokens: number
  /** cacheReadTokens / inputTokens, or undefined when there is no input. */
  hitRate: number | undefined
}

export interface UsageContext {
  model: string
  /** Distinguishes chat traffic from internal calls (e.g. commit messages). */
  label?: string | undefined
  /** The `Session_id` we asked the proxy to key Claude's cache on. */
  promptCacheKey?: string | undefined
  requestInitiator?: string | undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Reduce a proxy `usage` object to a single cache-focused view, regardless of
 * which provider shape it carries. The two shapes disagree on what
 * `input_tokens` means, so we must detect the shape before computing a ratio:
 *
 *   Anthropic-native — `input_tokens` is the *uncached remainder*; cache read
 *   and write are reported separately, and the total prompt is their sum.
 *
 *   OpenAI Responses / Chat Completions — `input_tokens` (or `prompt_tokens`)
 *   is the *total*, with the cached subset nested under
 *   `input_tokens_details.cached_tokens`. There is no separate write figure.
 *
 * Anything we can't classify is reported as `unknown` with no hit rate, so the
 * raw object can be surfaced for inspection rather than scored as 0% cached.
 */
export function normalizeUsage(usage: unknown): UsageSummary {
  const record = asRecord(usage) ?? {}
  const output = num(record.output_tokens ?? record.completion_tokens)

  const cacheRead = record.cache_read_input_tokens
  const cacheWrite = record.cache_creation_input_tokens
  if (cacheRead !== undefined || cacheWrite !== undefined) {
    const read = num(cacheRead)
    const write = num(cacheWrite)
    const uncached = num(record.input_tokens)
    const total = read + write + uncached
    return {
      shape: 'anthropic',
      inputTokens: total,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      uncachedInputTokens: uncached,
      outputTokens: output,
      hitRate: total > 0 ? read / total : undefined,
    }
  }

  const details = asRecord(record.input_tokens_details) ?? asRecord(record.prompt_tokens_details)
  if (details?.cached_tokens !== undefined) {
    const total = num(record.input_tokens ?? record.prompt_tokens)
    const read = num(details.cached_tokens)
    return {
      shape: 'openai',
      inputTokens: total,
      cacheReadTokens: read,
      cacheWriteTokens: 0,
      uncachedInputTokens: Math.max(0, total - read),
      outputTokens: output,
      hitRate: total > 0 ? read / total : undefined,
    }
  }

  const total = num(record.input_tokens ?? record.prompt_tokens)
  return {
    shape: 'unknown',
    inputTokens: total,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: total,
    outputTokens: output,
    hitRate: undefined,
  }
}

function formatHitRate(hitRate: number | undefined): string {
  return hitRate === undefined ? 'n/a' : `${Math.round(hitRate * 100)}%`
}

/**
 * A compact, always-logged summary line. For a recognized shape it ends with
 * the shape tag; for an unrecognized one it appends the raw object so the
 * actual fields can be inspected (the whole point of running a debug session).
 */
export function formatUsageLine(
  model: string,
  summary: UsageSummary,
  label?: string,
  raw?: unknown,
): string {
  const tag = label !== undefined && label.length > 0 ? ` (${label})` : ''
  const base = `[usage] ${model}${tag}: input=${summary.inputTokens} cached=${summary.cacheReadTokens}`
    + ` write=${summary.cacheWriteTokens} output=${summary.outputTokens} hit=${formatHitRate(summary.hitRate)}`
  if (summary.shape !== 'unknown')
    return `${base} (${summary.shape})`
  const rawRecord = asRecord(raw)
  return rawRecord !== undefined && Object.keys(rawRecord).length > 0
    ? `${base} raw=${JSON.stringify(rawRecord)}`
    : `${base} (unknown)`
}

/**
 * Observes every completion's token usage. The one-line log summary is always
 * emitted; the JSONL trail and the status-bar hit rate only when the user has
 * opted in via {@link ENABLED_SETTING}. The setting is read per request, so it
 * takes effect on the next completion without a window reload.
 */
export class CacheMetricsTracker {
  private readonly statusBar: StatusBarItem
  private readonly totals = { read: 0, write: 0, uncached: 0, output: 0, requests: 0 }
  /** Serializes appends so concurrent completions can't interleave a line. */
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly context: ExtensionContext,
    private readonly output: OutputChannel,
  ) {
    this.statusBar = window.createStatusBarItem(StatusBarAlignment.Right, 99)
    this.statusBar.command = 'universalChatProvider.showLogs'
    if (this.enabled())
      this.updateStatusBar()
    else
      this.statusBar.hide()
  }

  record(usage: unknown, context: UsageContext): void {
    const summary = normalizeUsage(usage)
    this.output.appendLine(formatUsageLine(context.model, summary, context.label, usage))
    if (!this.enabled()) {
      this.statusBar.hide()
      return
    }
    this.accumulate(summary)
    this.updateStatusBar()
    this.append(summary, context, usage)
  }

  dispose(): void {
    this.statusBar.dispose()
  }

  /** Resolves once every queued metric append has been flushed to disk. */
  async flush(): Promise<void> {
    await this.writes
  }

  private enabled(): boolean {
    return workspace.getConfiguration('universalChatProvider').get<boolean>(ENABLED_SETTING, false)
  }

  private accumulate(summary: UsageSummary): void {
    this.totals.read += summary.cacheReadTokens
    this.totals.write += summary.cacheWriteTokens
    this.totals.uncached += summary.uncachedInputTokens
    this.totals.output += summary.outputTokens
    this.totals.requests += 1
  }

  private updateStatusBar(): void {
    const { read, write, uncached, output, requests } = this.totals
    const input = read + write + uncached
    const pct = input > 0 ? Math.round((read / input) * 100) : 0
    this.statusBar.text = `$(database) ${pct}% cached`
    this.statusBar.tooltip = `Prompt cache hit rate this session: ${pct}%\n`
      + `cache read ${read} · cache write ${write} · uncached ${uncached} · output ${output}\n`
      + `${requests} request${requests === 1 ? '' : 's'} — logged to ${LOG_FILE}`
    this.statusBar.show()
  }

  private append(summary: UsageSummary, context: UsageContext, raw: unknown): void {
    const entry = {
      ts: new Date().toISOString(),
      model: context.model,
      label: context.label,
      requestInitiator: context.requestInitiator,
      promptCacheKey: context.promptCacheKey,
      shape: summary.shape,
      inputTokens: summary.inputTokens,
      cacheReadTokens: summary.cacheReadTokens,
      cacheWriteTokens: summary.cacheWriteTokens,
      uncachedInputTokens: summary.uncachedInputTokens,
      outputTokens: summary.outputTokens,
      hitRate: summary.hitRate ?? null,
      raw: raw ?? null,
    }
    const directory = this.context.globalStorageUri.fsPath
    const file = join(directory, LOG_FILE)
    this.writes = this.writes
      .then(async () => {
        await mkdir(directory, { recursive: true })
        await appendFile(file, `${JSON.stringify(entry)}\n`)
      })
      .catch(error => this.output.appendLine(`[cache-metrics] write failed: ${errorMessage(error)}`))
  }
}
