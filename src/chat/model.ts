import type { LanguageModelChatInformation, LanguageModelConfigurationSchema } from 'vscode'
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

export interface ReasoningLevel {
  effort: string
  description?: string
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
  supported_reasoning_levels?: ReasoningLevel[]
  default_reasoning_level?: string
}

export interface ProviderModel extends LanguageModelChatInformation {
  proxyModelId: string
  totalContextTokens: number
  maximumContextTokens: number
  reasoningLevels: readonly string[]
  supportsParallelToolCalls: boolean
}

export interface ModelMappingOptions {
  defaultMaxOutputTokens: number
  onSkipped?: (id: string, reason: string) => void
}

const LEVEL_DESCRIPTIONS: Record<string, string> = {
  none: 'No reasoning applied',
  minimal: 'Minimal reasoning for fastest responses',
  low: 'Faster responses with less reasoning',
  medium: 'Balanced reasoning and speed',
  high: 'Greater reasoning depth but slower',
  xhigh: 'Highest reasoning depth but slowest',
  max: 'Absolute maximum reasoning capability',
  auto: 'Let the provider choose the reasoning depth',
}

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
    const maximumContext = positiveInteger(detail?.max_context_window ?? totalContext, totalContext)
    const reasoning = resolveReasoning(detail, catalogModel)
    const advertisedName = detail?.display_name ?? catalogModel?.display_name ?? entry.id
    let displayName = normalizeReasoningModelName(advertisedName, reasoning.levels)
    const providerName = entry.owned_by ?? catalogModel?.type ?? 'proxy'
    const displayProviderName = formatProviderName(providerName)
    if (displayName !== advertisedName) {
      const reasoningModelKey = `${providerName}\0${displayName}`.toLowerCase()
      const levelSignature = [...reasoning.levels].sort().join('\0')
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
    const editTools = toolCalling ? preferredEditTools(family, entry.id) : undefined
    const description = detail?.description ?? catalogModel?.description
    const tooltip = buildTooltip(displayName, description, displayProviderName, outputTokens, imageInput, toolCalling)

    result.push({
      id: entry.id,
      proxyModelId: entry.id,
      name: displayName,
      family,
      version: catalogModel?.version ?? entry.id,
      // The full context window. `maxInputTokens` is the only field VS Code
      // budgets against — Copilot compacts as the prompt approaches it — and is
      // a separate dimension from `maxOutputTokens`, so we advertise the whole
      // window and let Copilot headroom and the server enforce input+output.
      // Carving an output reserve out of it only made Copilot summarize early.
      maxInputTokens: totalContext,
      maxOutputTokens: outputTokens,
      totalContextTokens: totalContext,
      maximumContextTokens: maximumContext,
      reasoningLevels: reasoning.levels,
      supportsParallelToolCalls,
      detail: `${formatTokens(totalContext)} context · ${displayProviderName}`,
      tooltip,
      isBYOK: true,
      isUserSelectable: true,
      ...(reasoning.schema ? { configurationSchema: reasoning.schema } : {}),
      capabilities: {
        imageInput,
        toolCalling,
        ...(editTools ? { editTools } : {}),
      },
    })
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

function resolveReasoning(
  metadata: ProxyModelMetadata | undefined,
  catalog: CatalogModel | undefined,
): { levels: string[], schema?: LanguageModelConfigurationSchema } {
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

  if (levels.length < 2)
    return { levels }

  const descriptions = new Map(
    metadata?.supported_reasoning_levels?.map(item => [item.effort.toLowerCase(), item.description]) ?? [],
  )
  const preferredDefault = metadata?.default_reasoning_level?.toLowerCase()
  const defaultLevel = preferredDefault !== undefined && levels.includes(preferredDefault)
    ? preferredDefault
    : levels.includes('medium')
      ? 'medium'
      : levels[0]

  return {
    levels,
    schema: {
      properties: {
        reasoningEffort: {
          type: 'string',
          title: 'Thinking Effort',
          enum: levels,
          enumItemLabels: levels.map(formatLevel),
          enumDescriptions: levels.map(level => descriptions.get(level) ?? LEVEL_DESCRIPTIONS[level] ?? level),
          default: defaultLevel,
          group: 'navigation',
        },
      },
    },
  }
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

// A trailing reasoning qualifier such as " (Thinking)" or " (Low)" that some
// providers append to a model's name. Stripped both when deriving the display
// name and when comparing a description against it.
const REASONING_NAME_SUFFIX = /\s+\((?:thinking|none|minimal|low|medium|high|extra high|xhigh|max|auto)\)$/i

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

function formatLevel(value: string): string {
  return value === 'xhigh'
    ? 'Extra High'
    : capitalize(value)
}

function formatProviderName(value: string): string {
  const knownProviderNames: Record<string, string> = {
    openai: 'OpenAI',
  }
  const normalized = value.trim()
  const known = knownProviderNames[normalized.toLowerCase()]
  if (known !== undefined)
    return known
  return normalized.replace(/[a-z][\w'-]*/gi, word => capitalize(word))
}

function normalizeReasoningModelName(name: string, levels: readonly string[]): string {
  if (levels.length < 2)
    return name
  return name.replace(REASONING_NAME_SUFFIX, '')
}

// Match Copilot's own per-family edit-tool defaults: apply-patch suits OpenAI
// models, find/replace suits Claude. For other families (e.g. Gemini) we leave
// it unset so Copilot's edit-tool learning picks what the model handles best
// rather than forcing a format it edits poorly with.
function preferredEditTools(family: string, id: string): string[] | undefined {
  const key = `${family} ${id}`.toLowerCase()
  if (/gpt|openai|codex/.test(key))
    return ['apply-patch']
  if (/claude|anthropic|sonnet|opus|haiku/.test(key))
    return ['find-replace', 'multi-find-replace']
  return undefined
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
