import { describe, expect, it } from 'vitest'
import { LanguageModelDataPart } from 'vscode'
import { createContextUsagePart } from '../../src/chat/context-usage'

describe('createContextUsagePart', () => {
  it('returns nothing when usage has no tokens', () => {
    expect(createContextUsagePart({})).toBeUndefined()
  })

  it.each([
    [
      'Anthropic',
      { input_tokens: 300, cache_read_input_tokens: 700, cache_creation_input_tokens: 0, output_tokens: 50 },
      { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 700 } },
    ],
    [
      'OpenAI',
      { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 40 },
      { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040, prompt_tokens_details: { cached_tokens: 800 } },
    ],
  ])('normalizes %s usage', (_name, usage, expected) => {
    const part = createContextUsagePart(usage)

    expect(part).toBeInstanceOf(LanguageModelDataPart)
    expect(part?.mimeType).toBe('usage')
    expect(JSON.parse(new TextDecoder().decode(part?.data))).toEqual(expected)
  })
})
