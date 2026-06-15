import type { LanguageModelChatRequestMessage } from 'vscode'
import { estimateTokenCount } from 'tokenx'
import { describe, expect, it } from 'vitest'
import {
  LanguageModelChatMessageRole,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from 'vscode'
import { estimateTokens } from '../../src/chat/estimate'

// Framing overhead constants mirrored from estimate.ts.
const MESSAGE_BASE = 4
const PART_BASE = 3
const IMAGE_TOKENS = 256

function message(content: LanguageModelChatRequestMessage['content']): LanguageModelChatRequestMessage {
  return { role: LanguageModelChatMessageRole.User, name: undefined, content }
}

describe('estimateTokens', () => {
  it('counts a raw string with tokenx', () => {
    expect(estimateTokens('Hello, world!')).toBe(estimateTokenCount('Hello, world!'))
  })

  it('adds framing overhead around text parts of a message', () => {
    const result = estimateTokens(message([new LanguageModelTextPart('Hello, world!')]))
    expect(result).toBe(MESSAGE_BASE + PART_BASE + estimateTokenCount('Hello, world!'))
  })

  it('charges a flat allowance for image data parts and counts non-image data as text', () => {
    const image = estimateTokens(message([LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), 'image/png')]))
    expect(image).toBe(MESSAGE_BASE + PART_BASE + IMAGE_TOKENS)

    const text = estimateTokens(message([LanguageModelDataPart.text('plain text', 'text/plain')]))
    expect(text).toBe(MESSAGE_BASE + PART_BASE + estimateTokenCount('plain text'))
  })

  it('counts tool calls and tool results as serialized text', () => {
    const call = estimateTokens(message([new LanguageModelToolCallPart('id', 'lookup', { q: 'x' })]))
    expect(call).toBe(MESSAGE_BASE + PART_BASE + estimateTokenCount(`lookup(${JSON.stringify({ q: 'x' })})`))

    const result = estimateTokens(message([new LanguageModelToolResultPart('id', [new LanguageModelTextPart('answer')])]))
    expect(result).toBe(MESSAGE_BASE + PART_BASE + estimateTokenCount('answer'))
  })
})
