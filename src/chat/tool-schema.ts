import { isObject } from '../shared/json'

// Tool schemas from Copilot/MCP carry constraints the model relies on (enum,
// anyOf, $ref/$defs, formats, defaults), and CLIProxyAPI forwards them to the
// OpenAI and Claude backends verbatim — so we pass them through unchanged.
//
// Gemini is the exception: Google's API 400s the whole request on JSON Schema
// fields it doesn't recognise, and CLIProxyAPI doesn't yet strip them on the
// OpenAI -> Gemini hop (router-for-me/CLIProxyAPI#3512). Until that ships we drop
// the offending annotation/meta keywords ourselves, but only for Gemini models.
const GEMINI_UNSUPPORTED_KEYS = new Set([
  '$schema',
  '$comment',
  '$id',
  '$anchor',
  'enumDescriptions',
  'enumItemLabels',
  'markdownDescription',
  'markdownEnumDescriptions',
])

export function sanitizeGeminiToolSchema(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(sanitizeGeminiToolSchema)
  if (!isObject(value))
    return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !GEMINI_UNSUPPORTED_KEYS.has(key))
      .map(([key, child]) => [key, sanitizeGeminiToolSchema(child)]),
  )
}
