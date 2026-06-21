import { describe, expect, it } from 'vitest'
import { mapProxyModels } from '../../src/chat/model'

describe('model mapping', () => {
  it('creates one entry with a reasoning-effort selector', () => {
    const models = mapProxyModels(
      [{ id: 'gpt-5.4', owned_by: 'openai' }],
      [{
        slug: 'gpt-5.4',
        display_name: 'GPT-5.4',
        context_window: 400_000,
        max_context_window: 1_000_000,
        supported_reasoning_levels: [
          { effort: 'low' },
          { effort: 'medium' },
          { effort: 'high' },
        ],
        input_modalities: ['text', 'image'],
      }],
      new Map([['gpt-5.4', {
        id: 'gpt-5.4',
        max_completion_tokens: 128_000,
        supported_parameters: ['tools'],
      }]]),
      {},
    )

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      proxyModelId: 'gpt-5.4',
      maxInputTokens: 400_000,
      maxOutputTokens: 128_000,
      capabilities: { imageInput: true, toolCalling: true },
      reasoningLevels: ['low', 'medium', 'high'],
      reasoningEffort: 'high',
    })
    expect(models[0]?.configurationSchema).toEqual({
      properties: {
        reasoningEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          enumItemLabels: ['Low', 'Medium', 'High'],
          default: 'high',
          description: 'Thinking Effort',
          group: 'navigation',
        },
      },
    })
  })

  it('keeps every provider model while filtering media-only endpoints', () => {
    const models = mapProxyModels(
      [
        { id: 'claude-sonnet', owned_by: 'anthropic', context_length: 200_000, max_completion_tokens: 8192 },
        { id: 'grok-code', owned_by: 'xai', context_length: 256_000, max_completion_tokens: 8192 },
        { id: 'image-generation', owned_by: 'openai', context_length: 4096, max_completion_tokens: 8192 },
      ],
      [],
      new Map(),
      {},
    )

    expect(models.map(model => model.id)).toEqual(['claude-sonnet', 'grok-code'])
  })

  it('dedups reasoning aliases into a single survivor with a selector', () => {
    const levels = [
      { effort: 'low' },
      { effort: 'high' },
    ]
    const models = mapProxyModels(
      [
        { id: 'atlas-3-pro-high', owned_by: 'antigravity', context_length: 1_000_000, max_completion_tokens: 65_536 },
        { id: 'atlas-3-pro-low', owned_by: 'antigravity', context_length: 1_000_000, max_completion_tokens: 65_536 },
        { id: 'claude-opus-thinking', owned_by: 'antigravity', context_length: 200_000, max_completion_tokens: 64_000 },
      ],
      [
        {
          slug: 'atlas-3-pro-high',
          display_name: 'Atlas 3 Pro (High)',
          supported_reasoning_levels: levels,
        },
        {
          slug: 'atlas-3-pro-low',
          display_name: 'Atlas 3 Pro (Low)',
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
      {},
    )

    // claude-opus keeps one entry; the two Atlas aliases dedupe to one survivor.
    expect(models.map(model => model.name)).toEqual([
      'Atlas 3 Pro',
      'Claude Opus',
    ])
    expect(models.map(model => model.reasoningLevels)).toEqual([
      ['low', 'high'],
      ['low', 'medium', 'high'],
    ])
    expect(models.find(model => model.name === 'Atlas 3 Pro')?.proxyModelId).toBe('atlas-3-pro-high')
  })

  it('dedups a suffixed alias against an already-unsuffixed sibling', () => {
    const levels = [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }]
    const models = mapProxyModels(
      [
        { id: 'atlas-3-flash-agent', owned_by: 'antigravity', context_length: 1_000_000, max_completion_tokens: 65_536 },
        { id: 'atlas-3.5-flash-low', owned_by: 'antigravity', context_length: 1_000_000, max_completion_tokens: 65_536 },
      ],
      [
        { slug: 'atlas-3-flash-agent', display_name: 'Atlas 3.5 Flash', supported_reasoning_levels: levels },
        { slug: 'atlas-3.5-flash-low', display_name: 'Atlas 3.5 Flash (Low)', supported_reasoning_levels: levels },
      ],
      new Map(),
      {},
    )

    expect(models.map(model => model.name)).toEqual(['Atlas 3.5 Flash'])
    expect(models[0]).toMatchObject({
      proxyModelId: 'atlas-3-flash-agent',
      reasoningEffort: 'high',
      reasoningLevels: ['low', 'medium', 'high'],
    })
  })

  it('logs unresolved display-name collisions with every candidate id', () => {
    const collisions: string[] = []
    const levels = [{ effort: 'low' }, { effort: 'high' }]
    const models = mapProxyModels(
      [
        { id: 'model-a', owned_by: 'proxy', context_length: 128_000, max_completion_tokens: 8192 },
        { id: 'model-b', owned_by: 'proxy', context_length: 128_000, max_completion_tokens: 8192 },
      ],
      [
        { slug: 'model-a', display_name: 'Model (Low)', supported_reasoning_levels: levels },
        { slug: 'model-b', display_name: 'Model (High)', supported_reasoning_levels: levels },
      ],
      new Map(),
      { onCollision: message => collisions.push(message) },
    )

    expect(models.map(model => model.proxyModelId)).toEqual(['model-a'])
    expect(collisions).toEqual([
      'Model display collision for Proxy "Model": model-a, model-b; keeping model-a.',
    ])
  })

  it('keeps fixed reasoning names when no selector can be offered', () => {
    const [model] = mapProxyModels(
      [{ id: 'fixed-high', owned_by: 'proxy', context_length: 128_000, max_completion_tokens: 8192 }],
      [{
        slug: 'fixed-high',
        display_name: 'Fixed Model (High)',
        supported_reasoning_levels: [{ effort: 'high' }],
      }],
      new Map(),
      {},
    )

    expect(model?.name).toBe('Fixed Model (High)')
    expect(model?.reasoningEffort).toBeUndefined()
  })

  it('keeps distinct aliases when their reasoning choices differ', () => {
    const models = mapProxyModels(
      [
        { id: 'model-high', owned_by: 'proxy', context_length: 128_000, max_completion_tokens: 8192 },
        { id: 'model-low', owned_by: 'proxy', context_length: 128_000, max_completion_tokens: 8192 },
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
      {},
    )

    // Distinct aliases stay distinct: each survives as its own selector entry.
    expect(models).toHaveLength(2)
    expect(new Set(models.map(model => model.proxyModelId))).toEqual(new Set(['model-high', 'model-low']))
    expect(new Set(models.map(model => model.name))).toEqual(new Set(['Model (High)', 'Model (Low)']))
  })

  it('humanizes ids only when no display name is available', () => {
    const [model] = mapProxyModels(
      [{ id: 'mystery-model_low', owned_by: 'proxy', context_length: 128_000, max_completion_tokens: 8192 }],
      [],
      new Map(),
      {},
    )

    expect(model?.name).toBe('Mystery Model Low')
  })

  it('derives reasoning levels and capability fallbacks from the catalog', () => {
    const models = mapProxyModels(
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
      {},
    )

    const model = models[0]
    expect(models).toHaveLength(1)
    expect(model).toMatchObject({
      name: 'Catalog Model',
      family: 'vendor',
      version: 'v1',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 50_000,
      reasoningLevels: ['none', 'low', 'medium', 'high', 'auto'],
      reasoningEffort: 'auto',
      detail: '1M context · Vendor',
      capabilities: {
        imageInput: true,
        toolCalling: false,
      },
    })
  })

  it('shows the CLI app in model details and tooltips', () => {
    const models = mapProxyModels(
      [
        { id: 'gpt', owned_by: 'openai', context_length: 128_000, max_completion_tokens: 8192 },
        { id: 'atlas', owned_by: 'antigravity', context_length: 128_000, max_completion_tokens: 8192 },
        { id: 'sonnet', owned_by: 'anthropic', context_length: 128_000, max_completion_tokens: 8192 },
        { id: 'grok', owned_by: 'xai', context_length: 128_000, max_completion_tokens: 8192 },
        { id: 'mystery', owned_by: 'acme-labs', context_length: 128_000, max_completion_tokens: 8192 },
      ],
      [],
      new Map(),
      {},
    )

    const detail = Object.fromEntries(models.map(model => [model.id, model.detail]))
    expect(detail).toMatchObject({
      gpt: '128K context · Codex',
      atlas: '128K context · Antigravity',
      sonnet: '128K context · Claude Code',
      grok: '128K context · Grok',
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
      {},
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
      [{ id: 'atlas-flash', owned_by: 'antigravity', context_length: 1_000_000, max_completion_tokens: 65_536 }],
      [{
        slug: 'atlas-flash',
        display_name: 'Atlas 3.1 Flash Lite',
        description: 'Atlas 3.1 Flash Lite',
        input_modalities: ['text', 'image'],
        supports_parallel_tool_calls: true,
      }],
      new Map(),
      {},
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
      {},
    )

    expect(model?.name).toBe('Claude Opus 4.6')
    expect(model?.tooltip).toBe('Antigravity via CLIProxyAPI\n\n64K max output · Vision · Tools')
  })

  it('falls back to the spec lines when no description is available', () => {
    const [model] = mapProxyModels(
      [{ id: 'mystery', owned_by: 'proxy', context_length: 128_000, max_completion_tokens: 8192 }],
      [],
      new Map(),
      {},
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
        ['tiny', { id: 'tiny', max_completion_tokens: -5, outputTokenLimit: 8 }],
        ['picture', { id: 'picture', type: 'openai-image' }],
        ['audio-only', { id: 'audio-only', supportedOutputModalities: ['audio'] }],
      ]),
      {},
    )

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'tiny',
      maxInputTokens: 128_000,
      maxOutputTokens: 8,
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
      { onSkipped: id => skipped.push(id) },
    )

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'sized',
      maxOutputTokens: 32_000,
      maxInputTokens: 256_000,
    })
    expect(skipped).toEqual(['unsized'])
  })

  it('drops models with no output token limit, reporting the skip', () => {
    const skipped: { id: string, reason: string }[] = []
    const models = mapProxyModels(
      [
        { id: 'sized', owned_by: 'openai', context_length: 256_000, max_completion_tokens: 32_000 },
        { id: 'no-output', owned_by: 'openai', context_length: 256_000 },
      ],
      [],
      new Map(),
      { onSkipped: (id, reason) => skipped.push({ id, reason }) },
    )

    expect(models.map(model => model.id)).toEqual(['sized'])
    expect(skipped).toEqual([{ id: 'no-output', reason: 'no output token limit reported by the proxy' }])
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
      {},
    )

    // `maxInputTokens` is a separate dimension from output; carving a reserve out
    // of it only made Copilot compact early, so input always gets the full window.
    expect(haiku).toMatchObject({ id: 'claude-haiku', maxInputTokens: 200_000 })
    expect(over).toMatchObject({ id: 'over-reported', maxInputTokens: 100_000 })
  })
})
