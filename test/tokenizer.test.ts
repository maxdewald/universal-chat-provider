import { describe, expect, it } from 'vitest'
import {
  LanguageModelChatMessageRole,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
} from 'vscode'
import { countTokens } from '../src/tokenizer'

describe('token counting', () => {
  it('counts strings and structured messages without returning zero', () => {
    expect(countTokens('hello world')).toBeGreaterThan(0)

    const plain = countTokens({
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelTextPart('hello')],
      name: undefined,
    })
    const named = countTokens({
      role: LanguageModelChatMessageRole.User,
      content: [
        new LanguageModelTextPart('hello'),
        LanguageModelDataPart.text('more'),
        new LanguageModelToolCallPart('call', 'tool', { value: true }),
      ],
      name: 'user',
    })
    expect(named).toBeGreaterThan(plain)
  })

  it('uses a fixed image estimate and tokenizes non-image binary data as text', () => {
    const image = countTokens({
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png')],
      name: undefined,
    })
    const text = countTokens({
      role: LanguageModelChatMessageRole.User,
      content: [LanguageModelDataPart.text('abc')],
      name: undefined,
    })
    expect(image).toBeGreaterThan(text)
  })
})
