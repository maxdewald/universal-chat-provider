import { describe, expect, it } from 'vitest'
import { flattenCatalog } from '../../src/chat/catalog'
import { mapProxyModels } from '../../src/chat/model'

describe('model mapping', () => {
  it('creates one selectable model with a native reasoning selector', () => {
    const models = mapProxyModels(
      [{ id: 'gpt-5.4', owned_by: 'openai' }],
      [{
        slug: 'gpt-5.4',
        display_name: 'GPT-5.4',
        context_window: 400_000,
        max_context_window: 1_000_000,
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast' },
          { effort: 'medium', description: 'Balanced' },
          { effort: 'high', description: 'Deep' },
        ],
        default_reasoning_level: 'medium',
        input_modalities: ['text', 'image'],
      }],
      new Map([['gpt-5.4', {
        id: 'gpt-5.4',
        max_completion_tokens: 128_000,
        supported_parameters: ['tools'],
      }]]),
      { defaultMaxOutputTokens: 16_384 },
    )

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'gpt-5.4',
      maxInputTokens: 400_000,
      maxOutputTokens: 128_000,
      totalContextTokens: 400_000,
      maximumContextTokens: 1_000_000,
      reasoningLevels: ['low', 'medium', 'high'],
      capabilities: {
        imageInput: true,
        toolCalling: true,
      },
    })
    const model = models[0]
    expect(model).toBeDefined()
    expect(model!.configurationSchema?.properties?.reasoningEffort).toMatchObject({
      enum: ['low', 'medium', 'high'],
      enumItemLabels: ['Low', 'Medium', 'High'],
      default: 'medium',
      group: 'navigation',
    })
  })

  it('keeps every provider model while filtering media-only endpoints', () => {
    const models = mapProxyModels(
      [
        { id: 'claude-sonnet', owned_by: 'anthropic', context_length: 200_000 },
        { id: 'gemini-pro', owned_by: 'google', context_length: 1_000_000 },
        { id: 'image-generation', owned_by: 'openai', context_length: 4096 },
      ],
      [],
      new Map(),
      { defaultMaxOutputTokens: 8192 },
    )

    expect(models.map(model => model.id)).toEqual(['claude-sonnet', 'gemini-pro'])
  })

  it('collapses configurable reasoning aliases into one unsuffixed model', () => {
    const levels = [
      { effort: 'low' },
      { effort: 'high' },
    ]
    const models = mapProxyModels(
      [
        { id: 'gemini-3-pro-high', owned_by: 'antigravity', context_length: 1_000_000 },
        { id: 'gemini-3-pro-low', owned_by: 'antigravity', context_length: 1_000_000 },
        { id: 'claude-opus-thinking', owned_by: 'antigravity', context_length: 200_000 },
      ],
      [
        {
          slug: 'gemini-3-pro-high',
          display_name: 'Gemini 3 Pro (High)',
          supported_reasoning_levels: levels,
        },
        {
          slug: 'gemini-3-pro-low',
          display_name: 'Gemini 3 Pro (Low)',
          supported_reasoning_levels: levels,
        },
        {
          slug: 'claude-opus-thinking',
          display_name: 'Claude Opus (Thinking)',
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'medium' },
            { effort: 'high' },
          ],
        },
      ],
      new Map(),
      { defaultMaxOutputTokens: 8192 },
    )

    expect(models).toHaveLength(2)
    expect(models).toMatchObject([
      {
        id: 'claude-opus-thinking',
        proxyModelId: 'claude-opus-thinking',
        name: 'Claude Opus',
        reasoningLevels: ['low', 'medium', 'high'],
      },
      {
        id: 'gemini-3-pro-high',
        proxyModelId: 'gemini-3-pro-high',
        name: 'Gemini 3 Pro',
        reasoningLevels: ['low', 'high'],
      },
    ])
  })

  it('keeps fixed reasoning names when no selector can be offered', () => {
    const [model] = mapProxyModels(
      [{ id: 'fixed-high', owned_by: 'proxy', context_length: 128_000 }],
      [{
        slug: 'fixed-high',
        display_name: 'Fixed Model (High)',
        supported_reasoning_levels: [{ effort: 'high' }],
      }],
      new Map(),
      { defaultMaxOutputTokens: 8192 },
    )

    expect(model?.name).toBe('Fixed Model (High)')
    expect(model?.configurationSchema).toBeUndefined()
  })

  it('keeps distinct aliases when their reasoning choices differ', () => {
    const models = mapProxyModels(
      [
        { id: 'model-high', owned_by: 'proxy', context_length: 128_000 },
        { id: 'model-low', owned_by: 'proxy', context_length: 128_000 },
      ],
      [
        {
          slug: 'model-high',
          display_name: 'Model (High)',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        },
        {
          slug: 'model-low',
          display_name: 'Model (Low)',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
        },
      ],
      new Map(),
      { defaultMaxOutputTokens: 8192 },
    )

    expect(models.map(model => model.name)).toEqual(['Model', 'Model (Low)'])
  })

  it('flattens provider catalogs and prefers richer duplicate metadata', () => {
    const catalog = flattenCatalog({
      openai: [{ id: 'shared', context_length: 128_000 }],
      aliases: [{ id: 'shared', context_length: 128_000, thinking: { levels: ['low', 'high'] } }],
    })

    expect(catalog.get('shared')?.thinking?.levels).toEqual(['low', 'high'])
  })

  it('derives reasoning levels and capability fallbacks from the catalog', () => {
    const [model] = mapProxyModels(
      [{ id: 'vendor/model' }],
      [],
      new Map([['vendor/model', {
        id: 'vendor/model',
        type: 'vendor',
        display_name: 'Catalog Model',
        version: 'v1',
        inputTokenLimit: 1_000_000,
        outputTokenLimit: 50_000,
        supportedInputModalities: ['TEXT', 'IMAGE'],
        supported_parameters: [],
        thinking: {
          zero_allowed: true,
          dynamic_allowed: true,
          max: 10,
        },
      }]]),
      { defaultMaxOutputTokens: 10 },
    )

    expect(model).toMatchObject({
      name: 'Catalog Model',
      family: 'vendor',
      version: 'v1',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 50_000,
      reasoningLevels: ['none', 'auto', 'low', 'medium', 'high'],
      detail: '1M context · Vendor',
      capabilities: {
        imageInput: true,
        toolCalling: false,
      },
    })
    expect(model?.configurationSchema?.properties?.reasoningEffort).toMatchObject({
      default: 'medium',
      enumItemLabels: ['None', 'Auto', 'Low', 'Medium', 'High'],
    })
  })

  it('shows the CLI app in model details and tooltips', () => {
    const models = mapProxyModels(
      [
        { id: 'gpt', owned_by: 'openai', context_length: 128_000 },
        { id: 'gemini', owned_by: 'antigravity', context_length: 128_000 },
        { id: 'sonnet', owned_by: 'anthropic', context_length: 128_000 },
        { id: 'flash', owned_by: 'google', context_length: 128_000 },
        { id: 'mystery', owned_by: 'acme-labs', context_length: 128_000 },
      ],
      [],
      new Map(),
      { defaultMaxOutputTokens: 8192 },
    )

    const detail = Object.fromEntries(models.map(model => [model.id, model.detail]))
    expect(detail).toMatchObject({
      gpt: '128K context · Codex',
      gemini: '128K context · Antigravity',
      sonnet: '128K context · Claude Code',
      flash: '128K context · Gemini',
      // Unknown providers fall back to title-casing.
      mystery: '128K context · Acme-labs',
    })
    expect(models.find(model => model.id === 'gpt')?.tooltip).toContain('Codex via CLIProxyAPI')
  })

  it('leads the tooltip with the model description and a compact spec line', () => {
    const [model] = mapProxyModels(
      [{ id: 'claude-opus', owned_by: 'antigravity', context_length: 200_000, max_completion_tokens: 64_000 }],
      [{
        slug: 'claude-opus',
        display_name: 'Claude Opus 4.6',
        description: 'Premium model combining maximum intelligence with practical performance',
        input_modalities: ['text', 'image'],
        supports_parallel_tool_calls: true,
      }],
      new Map(),
      { defaultMaxOutputTokens: 8192 },
    )

    expect(model?.tooltip).toBe(
      'Premium model combining maximum intelligence with practical performance.\n\n'
      + 'Antigravity via CLIProxyAPI\n\n'
      + '64K max output · Vision · Tools',
    )
    // The card already shows the name and context window, so the tooltip never repeats them.
    expect(model?.tooltip).not.toContain('Claude Opus 4.6')
    expect(model?.tooltip).not.toContain('200K')
  })

  it('omits the description line when it merely restates the model name', () => {
    const [model] = mapProxyModels(
      [{ id: 'gemini-flash', owned_by: 'antigravity', context_length: 1_000_000, max_completion_tokens: 65_536 }],
      [{
        slug: 'gemini-flash',
        display_name: 'Gemini 3.1 Flash Lite',
        description: 'Gemini 3.1 Flash Lite',
        input_modalities: ['text', 'image'],
        supports_parallel_tool_calls: true,
      }],
      new Map(),
      { defaultMaxOutputTokens: 8192 },
    )

    expect(model?.tooltip).toBe('Antigravity via CLIProxyAPI\n\n65.5K max output · Vision · Tools')
  })

  it('omits descriptions that restate the name with a reasoning suffix', () => {
    const [model] = mapProxyModels(
      [{ id: 'claude-opus-4-6-thinking', owned_by: 'antigravity', context_length: 200_000, max_completion_tokens: 64_000 }],
      [{
        slug: 'claude-opus-4-6-thinking',
        display_name: 'Claude Opus 4.6 (Thinking)',
        description: 'Claude Opus 4.6 (Thinking)',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
        input_modalities: ['text', 'image'],
        supports_parallel_tool_calls: true,
      }],
      new Map(),
      { defaultMaxOutputTokens: 8192 },
    )

    expect(model?.name).toBe('Claude Opus 4.6')
    expect(model?.tooltip).toBe('Antigravity via CLIProxyAPI\n\n64K max output · Vision · Tools')
  })

  it('falls back to the spec lines when no description is available', () => {
    const [model] = mapProxyModels(
      [{ id: 'mystery', owned_by: 'proxy', context_length: 128_000, max_completion_tokens: 8192 }],
      [],
      new Map(),
      { defaultMaxOutputTokens: 8192 },
    )

    expect(model?.tooltip).toBe('Proxy via CLIProxyAPI\n\n8.2K max output · Tools')
  })

  it('deduplicates IDs, applies safe numeric fallbacks, and filters catalog media models', () => {
    const models = mapProxyModels(
      [
        { id: '' },
        { id: 'tiny', context_length: 128_000 },
        { id: 'tiny', context_length: 128_000 },
        { id: 'picture' },
        { id: 'audio-only' },
      ],
      [{ slug: 'tiny', context_window: -1, max_context_window: Number.NaN }],
      new Map([
        ['tiny', { id: 'tiny', max_completion_tokens: -5 }],
        ['picture', { id: 'picture', type: 'openai-image' }],
        ['audio-only', { id: 'audio-only', supportedOutputModalities: ['audio'] }],
      ]),
      { defaultMaxOutputTokens: 8 },
    )

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'tiny',
      maxInputTokens: 128_000,
      maxOutputTokens: 8,
      totalContextTokens: 128_000,
      maximumContextTokens: 128_000,
    })
  })

  it('prefers the proxy context window and drops models with none, reporting the skip', () => {
    const skipped: string[] = []
    const models = mapProxyModels(
      [
        { id: 'sized', owned_by: 'openai', context_length: 256_000, max_completion_tokens: 32_000 },
        { id: 'unsized', owned_by: 'openai' },
      ],
      [{ slug: 'sized', context_window: 999 }],
      new Map(),
      { defaultMaxOutputTokens: 8192, onSkipped: id => skipped.push(id) },
    )

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'sized',
      totalContextTokens: 256_000,
      maxOutputTokens: 32_000,
      maxInputTokens: 256_000,
    })
    expect(skipped).toEqual(['unsized'])
  })

  it('advertises the full context window as input regardless of the reported output cap', () => {
    const [haiku, over] = mapProxyModels(
      [
        // Output cap equal to the window ("whole window usable for output").
        { id: 'claude-haiku', owned_by: 'antigravity', context_length: 200_000, max_completion_tokens: 200_000 },
        // Output cap larger than the window.
        { id: 'over-reported', owned_by: 'antigravity', context_length: 100_000, max_completion_tokens: 500_000 },
      ],
      [],
      new Map(),
      { defaultMaxOutputTokens: 16_384 },
    )

    // `maxInputTokens` is a separate dimension from output; carving a reserve out
    // of it only made Copilot compact early, so input always gets the full window.
    expect(haiku).toMatchObject({ id: 'claude-haiku', totalContextTokens: 200_000, maxInputTokens: 200_000 })
    expect(over).toMatchObject({ id: 'over-reported', totalContextTokens: 100_000, maxInputTokens: 100_000 })
  })

  it('ignores malformed catalog sections', () => {
    expect(flattenCatalog(null)).toEqual(new Map())
    expect(flattenCatalog({
      invalid: 'not an array',
      entries: [null, {}, { id: 1 }, { id: 'valid', outputTokenLimit: 20 }],
    })).toEqual(new Map([['valid', { id: 'valid', outputTokenLimit: 20 }]]))
  })
})
