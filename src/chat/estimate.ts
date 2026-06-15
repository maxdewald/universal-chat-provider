import type { LanguageModelChatRequestMessage } from 'vscode'
import { estimateTokenCount } from 'tokenx'
import {
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from 'vscode'
import { serializeToolResult } from './request'

/** Per-message and per-part framing overhead, mirroring chat encodings. */
const MESSAGE_BASE_TOKENS = 4
const PART_BASE_TOKENS = 3
/** Flat allowance for an image part, which carries no countable text. */
const IMAGE_TOKENS = 256

/**
 * A fast, local token estimate for a single string or message, via `tokenx`'s
 * heuristic counter (no tokenizer vocab, no network). `provideTokenCount` must
 * answer instantly while VS Code assembles a prompt, so this stands in right
 * away while the exact per-provider count is fetched from the proxy in the
 * background. Estimates only steer when VS Code compresses context — the server
 * enforces the real limit regardless.
 */
export function estimateTokens(value: string | LanguageModelChatRequestMessage): number {
  if (typeof value === 'string')
    return estimateTokenCount(value)

  let total = MESSAGE_BASE_TOKENS
  for (const part of value.content) {
    total += PART_BASE_TOKENS
    if (part instanceof LanguageModelTextPart)
      total += estimateTokenCount(part.value)
    else if (part instanceof LanguageModelDataPart)
      total += part.mimeType.startsWith('image/') ? IMAGE_TOKENS : estimateTokenCount(new TextDecoder().decode(part.data))
    else if (part instanceof LanguageModelToolCallPart)
      total += estimateTokenCount(`${part.name}(${JSON.stringify(part.input)})`)
    else if (part instanceof LanguageModelToolResultPart)
      total += estimateTokenCount(serializeToolResult(part))
  }
  return total
}
