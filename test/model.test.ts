import { describe, expect, it } from 'vitest'
import { flattenCatalog, mapProxyModels } from '../src/model'

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
      maxInputTokens: 272_000,
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
        { id: 'claude-sonnet', owned_by: 'anthropic' },
        { id: 'gemini-pro', owned_by: 'google' },
        { id: 'image-generation', owned_by: 'openai' },
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
        { id: 'gemini-3-pro-high', owned_by: 'antigravity' },
        { id: 'gemini-3-pro-low', owned_by: 'antigravity' },
        { id: 'claude-opus-thinking', owned_by: 'antigravity' },
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
      [{ id: 'fixed-high', owned_by: 'proxy' }],
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
        { id: 'model-high', owned_by: 'proxy' },
        { id: 'model-low', owned_by: 'proxy' },
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
      maxInputTokens: 950_000,
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

  it('capitalizes provider names in model details and tooltips', () => {
    const models = mapProxyModels(
      [
        { id: 'gpt', owned_by: 'openai' },
        { id: 'gemini', owned_by: 'antigravity' },
      ],
      [],
      new Map(),
      { defaultMaxOutputTokens: 8192 },
    )

    expect(models).toMatchObject([
      {
        id: 'gemini',
        detail: '128K context · Antigravity',
      },
      {
        id: 'gpt',
        detail: '128K context · OpenAI',
      },
    ])
    expect(models[0]?.tooltip).toContain('(Antigravity)')
    expect(models[1]?.tooltip).toContain('(OpenAI)')
  })

  it('deduplicates IDs, applies safe numeric fallbacks, and filters catalog media models', () => {
    const models = mapProxyModels(
      [
        { id: '' },
        { id: 'tiny' },
        { id: 'tiny' },
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
      maxInputTokens: 127_992,
      maxOutputTokens: 8,
      totalContextTokens: 128_000,
      maximumContextTokens: 128_000,
    })
  })

  it('ignores malformed catalog sections', () => {
    expect(flattenCatalog(null)).toEqual(new Map())
    expect(flattenCatalog({
      invalid: 'not an array',
      entries: [null, {}, { id: 1 }, { id: 'valid', outputTokenLimit: 20 }],
    })).toEqual(new Map([['valid', { id: 'valid', outputTokenLimit: 20 }]]))
  })
})
