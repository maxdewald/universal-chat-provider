import type { ExtensionContext, OutputChannel } from 'vscode'
import type { ProviderModel } from '../../src/chat/model'
import type { StreamCallbacks } from '../../src/cliproxy/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CancellationTokenSource,
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
} from 'vscode'
import { estimateTokens } from '../../src/chat/estimate'
import { UniversalChatProvider } from '../../src/chat/provider'
import { LanguageModelThinkingPart, resetVSCodeMock, vscodeMock } from '../support/vscode'

const clientMocks = vi.hoisted(() => ({
  discover: vi.fn(),
  streamResponse: vi.fn(),
}))

vi.mock('../../src/cliproxy/client', () => ({
  CLIProxyClient: class {
    discover = clientMocks.discover
    streamResponse = clientMocks.streamResponse
  },
}))

vi.mock('../../src/chat/catalog', () => ({
  fetchCatalog: vi.fn(async () => new Map()),
}))

beforeEach(() => {
  resetVSCodeMock()
  clientMocks.discover.mockReset()
  clientMocks.streamResponse.mockReset()
  vscodeMock.settings.set('universalChatProvider.autoDetectConfig', false)
  vscodeMock.settings.set('universalChatProvider.baseUrl', 'http://proxy/')
})

describe('language model provider', () => {
  it('requires credentials and returns zero for cancelled token counting', async () => {
    const provider = createProvider()
    const token = new CancellationTokenSource()

    await expect(provider.provideLanguageModelChatResponse(
      model(),
      [],
      options(),
      { report: vi.fn() },
      token.token,
    )).rejects.toMatchObject({ code: 'NoPermissions' })

    token.cancel()
    await expect(provider.provideTokenCount(model(), 'hello', token.token)).resolves.toBe(0)
    await expect(provider.provideLanguageModelChatInformation({ silent: true }, token.token)).resolves.toEqual([])
  })

  it('translates streaming callbacks into VS Code response parts and usage logs', async () => {
    const provider = createProvider('secret')
    clientMocks.streamResponse.mockImplementation(async (_body: unknown, callbacks: StreamCallbacks) => {
      callbacks.onThinking?.('thinking')
      callbacks.onText('text')
      callbacks.onToolCall('call', 'lookup', { q: 'x' })
      callbacks.onUsage?.({ output_tokens: 3 })
    })
    const report = vi.fn()

    await provider.provideLanguageModelChatResponse(
      { ...model(), reasoningEffort: 'high' },
      [{
        role: LanguageModelChatMessageRole.User,
        content: [new LanguageModelTextPart('hello')],
        name: undefined,
      }],
      options(),
      { report },
      new CancellationTokenSource().token,
    )

    expect(clientMocks.streamResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'model-a',
        reasoning: { effort: 'high', summary: 'auto' },
      }),
      expect.any(Object),
      expect.any(AbortSignal),
    )
    const thinkingPart = report.mock.calls[0]?.[0] as LanguageModelThinkingPart
    expect(thinkingPart).toBeInstanceOf(LanguageModelThinkingPart)
    expect(thinkingPart.value).toBe('thinking')
    expect(thinkingPart.id).toEqual(expect.any(String))
    expect(report.mock.calls[1]?.[0]).toEqual(new LanguageModelTextPart('text'))
    expect(report.mock.calls[2]?.[0]).toEqual(new LanguageModelToolCallPart('call', 'lookup', { q: 'x' }))
    // The usage data part drives VS Code's context-window indicator.
    const usagePart = report.mock.calls[3]?.[0] as LanguageModelDataPart
    expect(usagePart).toBeInstanceOf(LanguageModelDataPart)
    expect(usagePart.mimeType).toBe('usage')
    expect(JSON.parse(new TextDecoder().decode(usagePart.data))).toEqual({
      prompt_tokens: 0,
      completion_tokens: 3,
      total_tokens: 3,
      prompt_tokens_details: { cached_tokens: 0 },
    })
    expect(vscodeMock.output.appendLine).toHaveBeenCalledWith(
      '[usage] model-a: effort=high input=0 cached=0 write=0 output=3 hit=n/a raw={"output_tokens":3}',
    )
  })

  it('streams reasoning deltas as thinking parts sharing one id', async () => {
    const provider = createProvider('secret')
    clientMocks.streamResponse.mockImplementation(async (_body: unknown, callbacks: StreamCallbacks) => {
      callbacks.onThinking?.('first\nsecond')
      callbacks.onThinking?.(' tail')
      callbacks.onText('answer')
    })
    const report = vi.fn()

    await provider.provideLanguageModelChatResponse(
      { ...model(), reasoningEffort: 'high' },
      [{
        role: LanguageModelChatMessageRole.User,
        content: [new LanguageModelTextPart('hello')],
        name: undefined,
      }],
      options(),
      { report },
      new CancellationTokenSource().token,
    )

    const first = report.mock.calls[0]?.[0] as LanguageModelThinkingPart
    const second = report.mock.calls[1]?.[0] as LanguageModelThinkingPart
    expect(first).toBeInstanceOf(LanguageModelThinkingPart)
    expect(first.value).toBe('first\nsecond')
    expect(second).toBeInstanceOf(LanguageModelThinkingPart)
    expect(second.value).toBe(' tail')
    expect(first.id).toBe(second.id)
    expect(report.mock.calls[2]?.[0]).toEqual(new LanguageModelTextPart('answer'))
  })

  it('sends the effort picked from the model-config dropdown and logs it', async () => {
    const provider = createProvider('secret')
    clientMocks.streamResponse.mockImplementation(async (_body: unknown, callbacks: StreamCallbacks) => {
      callbacks.onUsage?.({ output_tokens: 1 })
    })

    await provider.provideLanguageModelChatResponse(
      { ...model(), reasoningLevels: ['low', 'high', 'xhigh'], reasoningEffort: 'low' },
      [{
        role: LanguageModelChatMessageRole.User,
        content: [new LanguageModelTextPart('hello')],
        name: undefined,
      }],
      { ...options(), modelConfiguration: { reasoningEffort: 'xhigh' } } as ReturnType<typeof options>,
      { report: vi.fn() },
      new CancellationTokenSource().token,
    )

    expect(clientMocks.streamResponse).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: { effort: 'xhigh', summary: 'auto' } }),
      expect.any(Object),
      expect.any(AbortSignal),
    )
    expect(vscodeMock.output.appendLine).toHaveBeenCalledWith(
      '[usage] model-a: effort=xhigh input=0 cached=0 write=0 output=1 hit=n/a raw={"output_tokens":1}',
    )
  })

  it('uses stored utility effort only for core utility requests', async () => {
    const provider = createProvider('secret')
    await provider.updateUtilityEffort('model-a', 'high')
    clientMocks.streamResponse.mockResolvedValue(undefined)
    const message = [{ role: LanguageModelChatMessageRole.User, content: [new LanguageModelTextPart('hello')], name: undefined }]

    await provider.provideLanguageModelChatResponse(
      { ...model(), reasoningLevels: ['low', 'high'], reasoningEffort: 'low' },
      message,
      { ...options(), requestInitiator: 'core' } as ReturnType<typeof options>,
      { report: vi.fn() },
      new CancellationTokenSource().token,
    )
    await provider.provideLanguageModelChatResponse(
      { ...model(), reasoningLevels: ['low', 'high'], reasoningEffort: 'low' },
      message,
      options(),
      { report: vi.fn() },
      new CancellationTokenSource().token,
    )

    expect(clientMocks.streamResponse.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ reasoning: { effort: 'high', summary: 'auto' } }),
    )
    expect(clientMocks.streamResponse.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ reasoning: { effort: 'low', summary: 'auto' } }),
    )
  })

  it('falls back to the lowest effort for core utility requests with stale stored effort', async () => {
    const provider = createProvider('secret')
    await provider.updateUtilityEffort('model-a', 'stale')
    clientMocks.streamResponse.mockResolvedValue(undefined)

    await provider.provideLanguageModelChatResponse(
      { ...model(), reasoningLevels: ['low', 'high'], reasoningEffort: 'high' },
      [{ role: LanguageModelChatMessageRole.User, content: [new LanguageModelTextPart('hello')], name: undefined }],
      { ...options(), requestInitiator: 'core' } as ReturnType<typeof options>,
      { report: vi.fn() },
      new CancellationTokenSource().token,
    )

    expect(clientMocks.streamResponse).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: { effort: 'low', summary: 'auto' } }),
      expect.any(Object),
      expect.any(AbortSignal),
    )
  })

  it('refreshes models on startup when credentials are stored', async () => {
    const provider = createProvider('secret')
    clientMocks.discover.mockResolvedValueOnce(discovery())

    await provider.initialize()

    expect(clientMocks.discover).toHaveBeenCalledTimes(1)
  })

  it('counts tokens locally without querying the proxy', async () => {
    const provider = createProvider('secret')

    await expect(provider.provideTokenCount(
      model(),
      'hello',
      new CancellationTokenSource().token,
    )).resolves.toBe(estimateTokens('hello'))
    expect(clientMocks.streamResponse).not.toHaveBeenCalled()
  })
})

function createProvider(apiKey?: string): UniversalChatProvider {
  if (apiKey !== undefined)
    vscodeMock.secrets.set('universalChatProvider.apiKey', apiKey)
  const context = {
    subscriptions: [],
    globalState: {
      get: <T>(key: string, fallback?: T): T => (vscodeMock.settings.get(key) ?? fallback) as T,
      update: async (key: string, value: unknown) => {
        vscodeMock.settings.set(key, value)
      },
    },
    secrets: {
      get: async (key: string) => vscodeMock.secrets.get(key),
      store: async (key: string, value: string) => {
        vscodeMock.secrets.set(key, value)
      },
      delete: async (key: string) => {
        vscodeMock.secrets.delete(key)
      },
      onDidChange: () => ({ dispose() {} }),
    },
  } as unknown as ExtensionContext
  return new UniversalChatProvider(
    context,
    vscodeMock.output as unknown as OutputChannel,
  )
}

function model(): ProviderModel {
  return {
    id: 'model-a',
    proxyModelId: 'model-a',
    name: 'Model A',
    family: 'test',
    version: '1',
    maxInputTokens: 100,
    maxOutputTokens: 20,
    reasoningLevels: ['low', 'high'],
    supportsParallelToolCalls: true,
    capabilities: {
      imageInput: false,
      toolCalling: true,
    },
  }
}

function options() {
  return {
    toolMode: LanguageModelChatToolMode.Auto,
  }
}

function discovery() {
  return {
    available: [{ id: 'model-a', owned_by: 'test', context_length: 128_000, max_completion_tokens: 20 }],
    metadata: [],
  }
}
