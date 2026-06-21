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
  // configurationSchema is part of VS Code's proposed chatProvider API but ships
  // ungated in stable, so we set it here and let the model picker render a
  // reasoning-effort dropdown from it.
  configurationSchema?: ModelConfigurationSchema
}

interface ModelConfigurationSchema {
  properties: {
    reasoningEffort: {
      type: 'string'
      enum: readonly string[]
      enumItemLabels: readonly string[]
      default: string
      description: string
      group: 'navigation'
    }
  }
}

export interface ModelMappingOptions {
  onSkipped?: (id: string, reason: string) => void
  onCollision?: (message: string) => void
}

// A trailing reasoning qualifier such as " (Thinking)" or " (Low)" that some
// providers append to a model's name. Stripped both when deriving the display
// name and when comparing a description against it.
const REASONING_NAME_SUFFIX = /\s+\((?:thinking|none|minimal|low|medium|high|extra high|xhigh|max|auto)\)$/i

interface ModelCandidate {
  entry: ProxyModelListEntry
  detail: ProxyModelMetadata | undefined
  catalogModel: CatalogModel | undefined
  providerName: string
  advertisedName: string
  baseName: string
  levels: string[]
  levelSignature: string
  totalContext: number
  outputTokens: number
}

export function mapProxyModels(
  available: readonly ProxyModelListEntry[],
  metadata: readonly ProxyModelMetadata[],
  catalog: ReadonlyMap<string, CatalogModel>,
  options: ModelMappingOptions,
): ProviderModel[] {
  const metadataById = new Map(metadata.map(model => [model.slug, model]))
  const seen = new Set<string>()
  const candidates: ModelCandidate[] = []

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

    // Output limit mirrors the context rule above: proxy first, then catalog.
    const outputTokens = firstPositiveInteger(
      entry.max_completion_tokens,
      catalogModel?.max_completion_tokens,
      catalogModel?.outputTokenLimit,
    )
    if (outputTokens === undefined) {
      options.onSkipped?.(entry.id, 'no output token limit reported by the proxy')
      continue
    }
    const levels = resolveReasoning(detail, catalogModel)
    const advertisedName = displayModelName(entry.id, detail, catalogModel)
    const baseName = normalizeReasoningModelName(advertisedName, levels)
    const providerName = entry.owned_by ?? catalogModel?.type ?? 'proxy'
    candidates.push({
      entry,
      detail,
      catalogModel,
      providerName,
      advertisedName,
      baseName,
      levels,
      levelSignature: [...levels].sort().join('\0'),
      totalContext,
      outputTokens,
    })
  }

  const winners = chooseDisplayModelWinners(candidates, options)
  const ambiguousNames = ambiguousDisplayNames(winners)
  return winners.map(candidate => toProviderModel(candidate, ambiguousNames.has(displayBaseKey(candidate)))).sort((a, b) => {
    const baseA = a.name.replace(REASONING_NAME_SUFFIX, '')
    const baseB = b.name.replace(REASONING_NAME_SUFFIX, '')
    return baseA === baseB
      ? effortRank(a.reasoningEffort) - effortRank(b.reasoningEffort)
      : baseA.localeCompare(baseB)
  })
}

function chooseDisplayModelWinners(candidates: readonly ModelCandidate[], options: ModelMappingOptions): ModelCandidate[] {
  const byDisplay = new Map<string, ModelCandidate[]>()
  for (const candidate of candidates) {
    const key = displayDedupeKey(candidate)
    const existing = byDisplay.get(key)
    if (existing === undefined)
      byDisplay.set(key, [candidate])
    else
      existing.push(candidate)
  }

  return Array.from(byDisplay.values(), group => chooseDisplayModelWinner(group, options))
}

function chooseDisplayModelWinner(candidates: readonly ModelCandidate[], options: ModelMappingOptions): ModelCandidate {
  const first = candidates[0]!
  if (candidates.length === 1)
    return first

  options.onCollision?.(formatCollision(first, candidates))
  return first
}

function formatCollision(kept: ModelCandidate, candidates: readonly ModelCandidate[]): string {
  return `Model display collision for ${formatProviderName(kept.providerName)} "${kept.baseName}": ${candidates.map(candidate => candidate.entry.id).join(', ')}; keeping ${kept.entry.id}.`
}

function ambiguousDisplayNames(candidates: readonly ModelCandidate[]): Set<string> {
  const seen = new Set<string>()
  const ambiguous = new Set<string>()
  for (const candidate of candidates) {
    const key = displayBaseKey(candidate)
    if (seen.has(key))
      ambiguous.add(key)
    else
      seen.add(key)
  }
  return ambiguous
}

function displayDedupeKey(candidate: ModelCandidate): string {
  return `${displayBaseKey(candidate)}\0${candidate.levelSignature}`
}

function displayBaseKey(candidate: ModelCandidate): string {
  return `${candidate.providerName}\0${candidate.baseName}`.toLowerCase()
}

function toProviderModel(candidate: ModelCandidate, useAdvertisedName: boolean): ProviderModel {
  const { entry, detail, catalogModel, providerName, levels, totalContext, outputTokens } = candidate
  const name = useAdvertisedName ? candidate.advertisedName : candidate.baseName
  const displayProviderName = formatProviderName(providerName)
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
  const tooltip = buildTooltip(name, description, displayProviderName, outputTokens, imageInput, toolCalling)

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

  // A model with multiple reasoning levels gets a single picker entry; the
  // level is chosen through a "Thinking Effort" dropdown that VS Code renders
  // from configurationSchema and echoes back as options.modelConfiguration.
  if (levels.length >= 2) {
    const ordered = [...levels].sort((a, b) => effortRank(a) - effortRank(b))
    const defaultLevel = ordered[ordered.length - 1]!
    return {
      ...baseModel,
      id: entry.id,
      name,
      reasoningLevels: ordered,
      reasoningEffort: defaultLevel,
      configurationSchema: {
        properties: {
          reasoningEffort: {
            type: 'string',
            enum: ordered,
            enumItemLabels: ordered.map(formatLevel),
            default: defaultLevel,
            description: 'Thinking Effort',
            group: 'navigation',
          },
        },
      },
    }
  }

  return { ...baseModel, id: entry.id, name, reasoningLevels: levels }
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

// The proxy reports the company in `owned_by`; show the CLI app instead. Only
// values that need renaming are listed — the rest (e.g. "kimi" → "Kimi")
// title-case correctly on their own.
function formatProviderName(value: string): string {
  const apps: Record<string, string> = {
    anthropic: 'Claude Code',
    openai: 'Codex',
    antigravity: 'Antigravity',
    xai: 'Grok',
  }
  const normalized = value.trim()
  return apps[normalized.toLowerCase()]
    ?? normalized.replace(/[a-z][\w'-]*/gi, word => capitalize(word))
}

function displayModelName(id: string, metadata: ProxyModelMetadata | undefined, catalog: CatalogModel | undefined): string {
  return metadata?.display_name ?? catalog?.display_name ?? humanizeModelId(id)
}

function humanizeModelId(id: string): string {
  return id.replace(/[-_/]+/g, ' ').replace(/[a-z][\w.]*/gi, word => capitalize(word))
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
