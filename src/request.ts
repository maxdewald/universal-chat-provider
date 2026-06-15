import type {
  LanguageModelChatRequestMessage,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode'
import type { ProviderModel } from './model'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from 'vscode'
import { normalizeToolSchema } from './tool-schema'

export function buildRequest(
  model: ProviderModel,
  messages: readonly LanguageModelChatRequestMessage[],
  options: ProvideLanguageModelChatResponseOptions,
  reasoningEffort?: string,
): Record<string, unknown> {
  const promptCacheKey = buildPromptCacheKey(model, messages, options.requestInitiator)
  const request: Record<string, unknown> = {
    model: model.proxyModelId,
    input: messages.flatMap(convertMessage),
    stream: true,
    max_output_tokens: model.maxOutputTokens,
    ...(promptCacheKey !== undefined ? { prompt_cache_key: promptCacheKey } : {}),
  }

  if (reasoningEffort !== undefined && model.reasoningLevels.includes(reasoningEffort))
    request.reasoning = { effort: reasoningEffort, summary: 'auto' }

  if (options.tools !== undefined && options.tools.length > 0) {
    request.tools = options.tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolSchema(tool.inputSchema ?? {}),
      strict: false,
    }))
    request.tool_choice = options.toolMode === LanguageModelChatToolMode.Required ? 'required' : 'auto'
    request.parallel_tool_calls = true
  }

  return request
}

export function buildPromptCacheKey(
  model: ProviderModel,
  messages: readonly LanguageModelChatRequestMessage[],
  requestInitiator?: string,
): string | undefined {
  const seed = sessionSeed(messages)
  if (seed === undefined)
    return undefined

  const hash = createHash('sha256')
    .update('universal-chat-provider:prompt-cache:v1\0')
    .update(model.proxyModelId)
    .update('\0')
    .update(requestInitiator ?? '')
    .update('\0')
    .update(seed)
    .digest('hex')
    .slice(0, 32)
  return `universal-chat-provider-${hash}`
}

export function buildTextRequest(
  model: ProviderModel,
  prompt: string,
  maxOutputTokens: number,
): Record<string, unknown> {
  return {
    model: model.proxyModelId,
    input: [{
      role: 'user',
      content: [{ type: 'input_text', text: prompt }],
    }],
    stream: true,
    max_output_tokens: Math.min(model.maxOutputTokens, maxOutputTokens),
  }
}

export function convertMessage(message: LanguageModelChatRequestMessage): Record<string, unknown>[] {
  const role = message.role === LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user'
  const content: Record<string, unknown>[] = []
  const items: Record<string, unknown>[] = []

  for (const part of message.content) {
    if (part instanceof LanguageModelTextPart) {
      content.push({
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: part.value,
      })
    }
    else if (part instanceof LanguageModelDataPart) {
      if (part.mimeType.startsWith('image/')) {
        content.push({
          type: 'input_image',
          image_url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`,
        })
      }
      else {
        content.push({
          type: role === 'assistant' ? 'output_text' : 'input_text',
          text: new TextDecoder().decode(part.data),
        })
      }
    }
    else if (part instanceof LanguageModelToolCallPart) {
      items.push({
        type: 'function_call',
        call_id: part.callId,
        name: part.name,
        arguments: JSON.stringify(part.input),
      })
    }
    else if (part instanceof LanguageModelToolResultPart) {
      items.push({
        type: 'function_call_output',
        call_id: part.callId,
        output: serializeToolResult(part),
      })
    }
  }

  if (content.length)
    items.unshift({ role, content })
  return items
}

function serializeToolResult(part: LanguageModelToolResultPart): string {
  return part.content.map((value) => {
    if (value instanceof LanguageModelTextPart)
      return value.value
    if (value instanceof LanguageModelDataPart) {
      return value.mimeType.startsWith('text/')
        ? new TextDecoder().decode(value.data)
        : `[${value.mimeType} data]`
    }
    return JSON.stringify(value)
  }).join('\n')
}

function sessionSeed(messages: readonly LanguageModelChatRequestMessage[]): string | undefined {
  const leadingUserMessages: string[] = []
  for (const message of messages) {
    if (message.role === LanguageModelChatMessageRole.Assistant)
      break

    const fingerprint = messageFingerprint(message)
    if (fingerprint !== undefined)
      leadingUserMessages.push(fingerprint)
  }

  if (leadingUserMessages.length > 0)
    return leadingUserMessages.join('\n---\n')

  const first = messages.find(message => message.role !== LanguageModelChatMessageRole.Assistant)
  return first !== undefined ? messageFingerprint(first) : undefined
}

function messageFingerprint(message: LanguageModelChatRequestMessage): string | undefined {
  const parts = message.content.map(partFingerprint).filter(value => value !== undefined)
  if (parts.length === 0)
    return undefined
  return `${message.role}:${parts.join('\n')}`
}

function partFingerprint(part: LanguageModelChatRequestMessage['content'][number]): string | undefined {
  if (part instanceof LanguageModelTextPart)
    return `text:${part.value}`
  if (part instanceof LanguageModelDataPart) {
    if (part.mimeType.startsWith('text/'))
      return `data:${part.mimeType}:${new TextDecoder().decode(part.data)}`
    return `data:${part.mimeType}:${createHash('sha256').update(part.data).digest('hex')}`
  }
  if (part instanceof LanguageModelToolResultPart)
    return `tool-result:${part.callId}:${serializeToolResult(part)}`
  if (part instanceof LanguageModelToolCallPart)
    return `tool-call:${part.callId}:${part.name}:${JSON.stringify(part.input)}`
  return undefined
}
