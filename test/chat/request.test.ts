import type { ProviderModel } from '../../src/chat/model'
import { describe, expect, it } from 'vitest'
import {
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from 'vscode'
import { buildPromptCacheKey, buildRequest, buildTextRequest, convertMessage } from '../../src/chat/request'

const model = {
  proxyModelId: 'proxy-model',
  maxOutputTokens: 4096,
  reasoningLevels: ['low', 'high'],
} as unknown as ProviderModel

describe('response request conversion', () => {
  it('serializes text, image, data, tool calls, and tool results in order', () => {
    const messages = [
      {
        role: LanguageModelChatMessageRole.Assistant,
        content: [
          new LanguageModelTextPart('answer'),
          new LanguageModelToolCallPart('call-1', 'lookup', { q: 'x' }),
        ],
        name: undefined,
      },
      {
        role: LanguageModelChatMessageRole.User,
        content: [
          new LanguageModelDataPart(new Uint8Array([1, 2]), 'image/png'),
          LanguageModelDataPart.text('notes', 'text/plain'),
          new LanguageModelToolResultPart('call-1', [
            new LanguageModelTextPart('done'),
            LanguageModelDataPart.text('details'),
            new LanguageModelDataPart(new Uint8Array([3]), 'application/octet-stream'),
            { value: 1 },
          ]),
        ],
        name: undefined,
      },
    ]

    expect(messages.flatMap(convertMessage)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
      },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,AQI=' },
          { type: 'input_text', text: 'notes' },
        ],
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'done\ndetails\n[application/octet-stream data]\n{"value":1}',
      },
    ])
  })

  it('adds supported reasoning and tool options', () => {
    const request = buildRequest(
      model,
      [{
        role: LanguageModelChatMessageRole.User,
        content: [new LanguageModelTextPart('hello')],
        name: undefined,
      }],
      {
        requestInitiator: 'test',
        toolMode: LanguageModelChatToolMode.Required,
        tools: [{
          name: 'lookup',
          description: 'Look up a value',
          inputSchema: {
            $comment: 'tool metadata',
            type: 'object',
            properties: {
              q: {
                type: 'string',
                enumDescriptions: ['Query text'],
              },
            },
          },
        }],
      },
      'high',
    )

    expect(request).toEqual({
      model: 'proxy-model',
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      }],
      stream: true,
      max_output_tokens: 4096,
      prompt_cache_key: buildPromptCacheKey(model, [{
        role: LanguageModelChatMessageRole.User,
        content: [new LanguageModelTextPart('hello')],
        name: undefined,
      }], 'test'),
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [{
        type: 'function',
        name: 'lookup',
        description: 'Look up a value',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        strict: false,
      }],
      tool_choice: 'required',
      parallel_tool_calls: true,
    })
  })

  it('keeps prompt cache keys stable across turns in the same chat seed', () => {
    const firstTurn = [{
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelTextPart('hello')],
      name: undefined,
    }]
    const secondTurn = [
      ...firstTurn,
      {
        role: LanguageModelChatMessageRole.Assistant,
        content: [new LanguageModelTextPart('hi')],
        name: undefined,
      },
      {
        role: LanguageModelChatMessageRole.User,
        content: [new LanguageModelTextPart('next')],
        name: undefined,
      },
    ]

    const key = buildPromptCacheKey(model, firstTurn, 'test')

    expect(key).toMatch(/^universal-chat-provider-[a-f0-9]{32}$/)
    expect(buildPromptCacheKey(model, secondTurn, 'test')).toBe(key)
    expect(buildRequest(model, firstTurn, {
      requestInitiator: 'test',
      toolMode: LanguageModelChatToolMode.Auto,
    }).prompt_cache_key).toBe(key)
  })

  it('omits unsupported reasoning and supplies a default tool schema', () => {
    const request = buildRequest(model, [], {
      requestInitiator: 'test',
      toolMode: LanguageModelChatToolMode.Auto,
      tools: [{ name: 'empty', description: 'No input' }],
    }, 'medium')

    expect(request).not.toHaveProperty('reasoning')
    expect(request).not.toHaveProperty('prompt_cache_key')
    expect(request).toMatchObject({
      tools: [{
        name: 'empty',
        parameters: { type: 'object', properties: {} },
      }],
      tool_choice: 'auto',
    })
  })

  it('builds a bounded plain-text request for internal features', () => {
    expect(buildTextRequest(model, 'Generate a commit message.', 512)).toEqual({
      model: 'proxy-model',
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'Generate a commit message.' }],
      }],
      stream: true,
      max_output_tokens: 512,
    })
  })
})
