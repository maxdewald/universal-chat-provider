import type { LanguageModelChatInformation, LanguageModelConfigurationSchema } from 'vscode'
import { capitalize, isPlainObject, unique } from 'moderndash'

export interface ProxyModelListEntry {
  id: string
  owned_by?: string
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

export interface CatalogThinking {
  min?: number
  max?: number
  zero_allowed?: boolean
  dynamic_allowed?: boolean
  levels?: string[]
}

export interface CatalogModel {
  id: string
  type?: string
  display_name?: string
  description?: string
  version?: string
  context_length?: number
  max_completion_tokens?: number
  inputTokenLimit?: number
  outputTokenLimit?: number
  supported_parameters?: string[]
  supportedInputModalities?: string[]
  supportedOutputModalities?: string[]
  thinking?: CatalogThinking
}

export interface ProviderModel extends LanguageModelChatInformation {
  proxyModelId: string
  totalContextTokens: number
  maximumContextTokens: number
  reasoningLevels: readonly string[]
}

export interface ModelMappingOptions {
  defaultMaxOutputTokens: number
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

export function flattenCatalog(payload: unknown): Map<string, CatalogModel> {
  const result = new Map<string, CatalogModel>()
  if (!isPlainObject(payload))
    return result

  for (const value of Object.values(payload)) {
    if (!Array.isArray(value))
      continue
    for (const candidate of value) {
      if (!isPlainObject(candidate) || typeof candidate.id !== 'string')
        continue
      const current = result.get(candidate.id)
      const model = candidate as unknown as CatalogModel
      if (!current || scoreCatalogModel(model) > scoreCatalogModel(current))
        result.set(model.id, model)
    }
  }
  return result
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

    const outputTokens = positiveInteger(
      catalogModel?.max_completion_tokens
      ?? catalogModel?.outputTokenLimit
      ?? options.defaultMaxOutputTokens,
      options.defaultMaxOutputTokens,
    )
    const totalContext = positiveInteger(
      detail?.context_window
      ?? catalogModel?.context_length
      ?? catalogModel?.inputTokenLimit
      ?? 128_000,
      128_000,
    )
    const maximumContext = positiveInteger(detail?.max_context_window ?? totalContext, totalContext)
    const maxInputTokens = Math.max(1, totalContext - Math.min(outputTokens, totalContext - 1))
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
    const tooltip = buildTooltip(displayName, displayProviderName, totalContext, maximumContext, outputTokens, reasoning.levels)
    const imageInput = detail?.input_modalities?.includes('image')
      ?? catalogModel?.supportedInputModalities?.some(value => value.toLowerCase() === 'image')
      ?? false
    const toolCalling = detail?.supports_parallel_tool_calls
      ?? catalogModel?.supported_parameters?.includes('tools')
      ?? true

    result.push({
      id: entry.id,
      proxyModelId: entry.id,
      name: displayName,
      family: catalogModel?.type ?? inferFamily(entry.id),
      version: catalogModel?.version ?? entry.id,
      maxInputTokens,
      maxOutputTokens: outputTokens,
      totalContextTokens: totalContext,
      maximumContextTokens: maximumContext,
      reasoningLevels: reasoning.levels,
      detail: `${formatTokens(totalContext)} context · ${displayProviderName}`,
      tooltip,
      isBYOK: true,
      isUserSelectable: true,
      ...(reasoning.schema ? { configurationSchema: reasoning.schema } : {}),
      capabilities: {
        imageInput,
        toolCalling,
        ...(toolCalling ? { editTools: ['apply-patch'] } : {}),
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

function buildTooltip(
  name: string,
  provider: string,
  context: number,
  maximumContext: number,
  output: number,
  reasoning: readonly string[],
): string {
  const contextText = maximumContext > context
    ? `${formatTokens(context)} active / ${formatTokens(maximumContext)} maximum context`
    : `${formatTokens(context)} context`
  const reasoningText = reasoning.length > 0 ? ` Reasoning: ${reasoning.map(formatLevel).join(', ')}.` : ''
  return `${name} via CLIProxyAPI (${provider}). ${contextText}; ${formatTokens(output)} maximum output.${reasoningText}`
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
  return name.replace(/\s+\((?:thinking|none|minimal|low|medium|high|extra high|xhigh|max|auto)\)$/i, '')
}

function inferFamily(id: string): string {
  const family = id.split(/[/:]/, 1)[0]
  return family !== undefined && family.length > 0 ? family : id
}

function scoreCatalogModel(model: CatalogModel): number {
  return Number((model.context_length ?? model.inputTokenLimit ?? 0) > 0)
    + Number((model.max_completion_tokens ?? model.outputTokenLimit ?? 0) > 0)
    + Number(model.thinking !== undefined)
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function normalizedUnique(values: readonly string[]): string[] {
  return unique(values.map(value => value.trim().toLowerCase()).filter(Boolean))
}
