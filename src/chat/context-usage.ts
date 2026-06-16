import { LanguageModelDataPart } from 'vscode'
import { normalizeUsage } from './cache-metrics'

// Undocumented marker Copilot reads off the response stream to drive VS Code's
// context-window indicator. The gauge reads the response's reported usage, not
// provideTokenCount; without this part it sits at 0% for extension-served models.
const USAGE_MIME = 'usage'

/** Build the usage part for the context-window indicator, or `undefined` when there is nothing to report. */
export function createContextUsagePart(usage: unknown): LanguageModelDataPart | undefined {
  const { inputTokens, outputTokens, cacheReadTokens } = normalizeUsage(usage)
  if (inputTokens <= 0 && outputTokens <= 0)
    return undefined
  return LanguageModelDataPart.json({
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: cacheReadTokens },
  }, USAGE_MIME)
}
