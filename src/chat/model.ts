import type { LanguageModelChatInformation } from 'vscode'
import type { CatalogModel } from './catalog'
import { capitalize, unique } from 'moderndash'

export interface ProxyModelListEntry {
  id: string
  owned_by?: string
  /** Context window reported by the proxy's own `/v1/models` (OpenAI format). */
  context_length?: number
  /** Maximum output tokens reported by the proxy's own `/v1/models`. */
  max_completion_tokens?: number
}

export interface ProxyModelMetadata {
  slug: string
  display_name?: string
  description?: string
  context_window?: number
  max_context_window?: number
  visibility?: string
  supported_in_api?: boolean
  input_modalities?: string[]
  supports_parallel_tool_calls?: boolean
  supported_reasoning_levels?: { effort: string }[]
}

export interface ProviderModel extends LanguageModelChatInformation {
  proxyModelId: string
  reasoningLevels: readonly string[]
  reasoningEffort?: string
  supportsParallelToolCalls: boolean
}

export interface ModelMappingOptions {
  defaultMaxOutputTokens: number
  onSkipped?: (id: string, reason: string) => void
}

// A trailing reasoning qualifier such as " (Thinking)" or " (Low)" that some
// providers append to a model's name. Stripped both when deriving the display
// name and when comparing a description against it.
const REASONING_NAME_SUFFIX = /\s+\((?:thinking|none|minimal|low|medium|high|extra high|xhigh|max|auto)\)$/i

export function mapProxyModels(
  available: readonly ProxyModelListEntry[],
  metadata: readonly ProxyModelMetadata[],
  catalog: ReadonlyMap<string, CatalogModel>,
  options: ModelMappingOptions,
): ProviderModel[] {
  const metadataById = new Map(metadata.map(model => [model.slug, model]))
  const seen = new Set<string>()
  const seenReasoningModels = new Map<string, string>()
  const result: ProviderModel[] = []

  for (const entry of available) {
    if (!entry.id || seen.has(entry.id))
      continue
    seen.add(entry.id)

    const detail = metadataById.get(entry.id)
    const catalogModel = catalog.get(entry.id)
    if (isMediaOnly(entry.id, catalogModel))
      continue

    // Context size comes from the proxy first (its `/v1/models` reports an exact
    // `context_length` for every chat model), then enhanced metadata, then the
    // shared catalog. We never invent a number: a model the proxy cannot size is
    // dropped rather than shown with a guessed window that would compress early.
    const totalContext = firstPositiveInteger(
      entry.context_length,
      detail?.context_window,
      catalogModel?.context_length,
      catalogModel?.inputTokenLimit,
    )
    if (totalContext === undefined) {
      options.onSkipped?.(entry.id, 'no context window reported by the proxy')
      continue
    }

    const outputTokens = positiveInteger(
      entry.max_completion_tokens
      ?? catalogModel?.max_completion_tokens
      ?? catalogModel?.outputTokenLimit
      ?? options.defaultMaxOutputTokens,
      options.defaultMaxOutputTokens,
    )
    const levels = resolveReasoning(detail, catalogModel)
    const advertisedName = detail?.display_name ?? catalogModel?.display_name ?? entry.id
    let displayName = normalizeReasoningModelName(advertisedName, levels)
    const providerName = entry.owned_by ?? catalogModel?.type ?? 'proxy'
    const displayProviderName = formatProviderName(providerName)
    // Dedupe same-base-name ids that share a reasoning-level set (e.g. Gemini 3.5
    // Flash aliases). A different level set keeps its qualifier and stays distinct.
    if (levels.length >= 2) {
      const reasoningModelKey = `${providerName}\0${displayName}`.toLowerCase()
      const levelSignature = [...levels].sort().join('\0')
      const existingSignature = seenReasoningModels.get(reasoningModelKey)
      if (existingSignature === levelSignature)
        continue
      if (existingSignature === undefined)
        seenReasoningModels.set(reasoningModelKey, levelSignature)
      else
        displayName = advertisedName
    }
    const imageInput = detail?.input_modalities?.includes('image')
      ?? catalogModel?.supportedInputModalities?.some(value => value.toLowerCase() === 'image')
      ?? false
    // `supports_parallel_tool_calls` is the only tool-related flag the proxy
    // reports, so its presence (true or false) means the model does tool calls;
    // its value only decides whether several may run in one turn.
    const parallelToolCalls = detail?.supports_parallel_tool_calls
    const supportsParallelToolCalls = parallelToolCalls ?? true
    const toolCalling = parallelToolCalls !== undefined
      || (catalogModel?.supported_parameters?.includes('tools') ?? true)
    const family = catalogModel?.type ?? inferFamily(entry.id)
    const description = detail?.description ?? catalogModel?.description
    const tooltip = buildTooltip(displayName, description, displayProviderName, outputTokens, imageInput, toolCalling)

    const baseModel = {
      proxyModelId: entry.id,
      family,
      version: catalogModel?.version ?? entry.id,
      // The full context window. `maxInputTokens` is the only field VS Code
      // budgets against — Copilot compacts as the prompt approaches it — and is
      // a separate dimension from `maxOutputTokens`, so we advertise the whole
      // window and let Copilot headroom and the server enforce input+output.
      // Carving an output reserve out of it only made Copilot summarize early.
      maxInputTokens: totalContext,
      maxOutputTokens: outputTokens,
      supportsParallelToolCalls,
      detail: `${formatTokens(totalContext)} context · ${displayProviderName}`,
      tooltip,
      capabilities: {
        imageInput,
        toolCalling,
      },
    }

    // Stable VS Code has no per-model config UI, so the reasoning effort is
    // chosen through the model picker: one selectable entry per level.
    if (levels.length >= 2) {
      for (const level of levels) {
        result.push({
          ...baseModel,
          id: `${entry.id}:${level}`,
          name: `${displayName} (${formatLevel(level)})`,
          reasoningLevels: [level],
          reasoningEffort: level,
        })
      }
    }
    else {
      result.push({ ...baseModel, id: entry.id, name: displayName, reasoningLevels: levels })
    }
  }

  return result.sort((a, b) => {
    const baseA = a.name.replace(REASONING_NAME_SUFFIX, '')
    const baseB = b.name.replace(REASONING_NAME_SUFFIX, '')
    return baseA === baseB
      ? effortRank(a.reasoningEffort) - effortRank(b.reasoningEffort)
      : baseA.localeCompare(baseB)
  })
}

const EFFORT_RANK: Record<string, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, auto: 7 }

function effortRank(level: string | undefined): number {
  return level === undefined ? -1 : EFFORT_RANK[level] ?? 99
}

function formatLevel(value: string): string {
  return value === 'xhigh' ? 'Extra High' : capitalize(value)
}

function resolveReasoning(
  metadata: ProxyModelMetadata | undefined,
  catalog: CatalogModel | undefined,
): string[] {
  const describedLevels = metadata?.supported_reasoning_levels
    ?.map(item => item.effort.trim().toLowerCase())
    .filter(Boolean)
  let levels = normalizedUnique(describedLevels ?? catalog?.thinking?.levels ?? [])

  if (levels.length === 0 && catalog?.thinking) {
    if (catalog.thinking.zero_allowed)
      levels.push('none')
    if (catalog.thinking.dynamic_allowed)
      levels.push('auto')
    if ((catalog.thinking.max ?? 0) > 0)
      levels.push('low', 'medium', 'high')
    levels = normalizedUnique(levels)
  }

  return levels
}

function isMediaOnly(id: string, model: CatalogModel | undefined): boolean {
  if (model?.type === 'openai-image')
    return true
  const outputs = model?.supportedOutputModalities?.map(value => value.toLowerCase())
  if (outputs !== undefined && outputs.length > 0 && !outputs.includes('text'))
    return true
  return /(?:^|[-_/])(?:image|video)(?:$|[-_/])/.test(id.toLowerCase())
}

// The hover renders `name` as the title, the input/output budget as "Max
// context", and the reasoning selector as a "Thinking Effort" chip on its own.
// The tooltip fills the remaining space with, at most, three stacked lines that
// never repeat what the card already shows:
//   <description, unless it just restates the name>
//   <provider> via CLIProxyAPI
//   <output> max output · Vision · Tools
function buildTooltip(
  name: string,
  description: string | undefined,
  provider: string,
  output: number,
  imageInput: boolean,
  toolCalling: boolean,
): string {
  const capabilities = [`${formatTokens(output)} max output`]
  if (imageInput)
    capabilities.push('Vision')
  if (toolCalling)
    capabilities.push('Tools')

  const lines = [`${provider} via CLIProxyAPI`, capabilities.join(' · ')]
  const summary = description?.trim()
  if (summary !== undefined && summary.length > 0 && !isNameEcho(summary, name))
    lines.unshift(endWithSentencePunctuation(summary))
  return lines.join('\n\n')
}

function endWithSentencePunctuation(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

// Many proxied providers fill `description` with nothing more than the model's
// own name (e.g. "Claude Opus 4.6 (Thinking)"), which the card already shows as
// the title. Treat those as no description so the tooltip never echoes the name.
function isNameEcho(description: string, name: string): boolean {
  const normalize = (text: string): string =>
    text.trim().replace(/[.!?]+$/, '').replace(REASONING_NAME_SUFFIX, '').trim().toLowerCase()
  return normalize(description) === normalize(name)
}

function formatTokens(value: number): string {
  if (value >= 1_000_000)
    return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000)
    return `${Number((value / 1_000).toFixed(1))}K`
  return String(value)
}

// The proxy reports the company in `owned_by` (e.g. "anthropic", "google"); show
// the CLI app instead. Only values that need renaming are listed — the rest
// (e.g. "kimi" → "Kimi") title-case correctly on their own.
function formatProviderName(value: string): string {
  const apps: Record<string, string> = {
    anthropic: 'Claude Code',
    openai: 'Codex',
    google: 'Gemini',
    antigravity: 'Antigravity',
    xai: 'Grok',
  }
  const normalized = value.trim()
  return apps[normalized.toLowerCase()]
    ?? normalized.replace(/[a-z][\w'-]*/gi, word => capitalize(word))
}

function normalizeReasoningModelName(name: string, levels: readonly string[]): string {
  if (levels.length < 2)
    return name
  return name.replace(REASONING_NAME_SUFFIX, '')
}

function inferFamily(id: string): string {
  const family = id.split(/[/:]/, 1)[0]
  return family !== undefined && family.length > 0 ? family : id
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function firstPositiveInteger(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (value !== undefined && Number.isFinite(value) && value > 0)
      return Math.floor(value)
  }
  return undefined
}

function normalizedUnique(values: readonly string[]): string[] {
  return unique(values.map(value => value.trim().toLowerCase()).filter(Boolean))
}
