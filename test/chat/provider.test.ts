import type { ExtensionContext, OutputChannel } from 'vscode'
import type { ProviderModel } from '../../src/chat/model'
import type { StreamCallbacks } from '../../src/cliproxy/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CancellationTokenSource,
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
  LanguageModelDataPart,
  LanguageModelError,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
} from 'vscode'
import { estimateTokens } from '../../src/chat/estimate'
import { UniversalChatProvider } from '../../src/chat/provider'

import { ProxyHttpError } from '../../src/cliproxy/errors'
import { resetVSCodeMock, vscodeMock, window } from '../support/vscode'

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
    expect(report.mock.calls[0]?.[0]).toEqual(new LanguageModelTextPart('> **Thinking**\n> thinking'))
    expect(report.mock.calls[1]?.[0]).toEqual(new LanguageModelTextPart('\n\n'))
    expect(report.mock.calls[2]?.[0]).toEqual(new LanguageModelTextPart('text'))
    expect(report.mock.calls[3]?.[0]).toEqual(new LanguageModelToolCallPart('call', 'lookup', { q: 'x' }))
    // The usage data part drives VS Code's context-window indicator.
    const usagePart = report.mock.calls[4]?.[0] as LanguageModelDataPart
    expect(usagePart).toBeInstanceOf(LanguageModelDataPart)
    expect(usagePart.mimeType).toBe('usage')
    expect(JSON.parse(new TextDecoder().decode(usagePart.data))).toEqual({
      prompt_tokens: 0,
      completion_tokens: 3,
      total_tokens: 3,
      prompt_tokens_details: { cached_tokens: 0 },
    })
    expect(vscodeMock.output.appendLine).toHaveBeenCalledWith(
      '[usage] model-a: input=0 cached=0 write=0 output=3 hit=n/a raw={"output_tokens":3}',
    )
  })

  it('shows multiline reasoning as text', async () => {
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

    const parts: unknown[] = []
    for (const call of report.mock.calls)
      parts.push(call[0])
    expect(parts).toEqual([
      new LanguageModelTextPart('> **Thinking**\n> first\n> second'),
      new LanguageModelTextPart(' tail'),
      new LanguageModelTextPart('\n\n'),
      new LanguageModelTextPart('answer'),
    ])
  })

  it('hides reasoning when configured off', async () => {
    vscodeMock.settings.set('universalChatProvider.showReasoning', false)
    const provider = createProvider('secret')
    clientMocks.streamResponse.mockImplementation(async (_body: unknown, callbacks: StreamCallbacks) => {
      callbacks.onThinking?.('hidden')
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

    const parts: unknown[] = []
    for (const call of report.mock.calls)
      parts.push(call[0])
    expect(parts).toEqual([
      new LanguageModelTextPart('answer'),
    ])
  })

  it('maps HTTP errors and suppresses errors after cancellation', async () => {
    const provider = createProvider('secret')
    clientMocks.streamResponse.mockRejectedValueOnce(new ProxyHttpError('missing', 404))
    await expect(provider.provideLanguageModelChatResponse(
      model(),
      [],
      options(),
      { report: vi.fn() },
      new CancellationTokenSource().token,
    )).rejects.toEqual(LanguageModelError.NotFound('missing'))

    const token = new CancellationTokenSource()
    clientMocks.streamResponse.mockImplementationOnce(async (_body, _callbacks, signal: AbortSignal) => {
      token.cancel()
      expect(signal.aborted).toBe(true)
      throw new Error('aborted')
    })
    await expect(provider.provideLanguageModelChatResponse(
      model(),
      [],
      options(),
      { report: vi.fn() },
      token.token,
    )).resolves.toBeUndefined()
  })

  it('maps permission and rate-limit errors and offers credential recovery once', async () => {
    const provider = createProvider('secret')
    clientMocks.streamResponse
      .mockRejectedValueOnce(new ProxyHttpError('bad key', 401))
      .mockRejectedValueOnce(new ProxyHttpError('slow down', 429))
    window.showWarningMessage.mockResolvedValue(undefined)

    await expect(provider.provideLanguageModelChatResponse(
      model(),
      [],
      options(),
      { report: vi.fn() },
      new CancellationTokenSource().token,
    )).rejects.toMatchObject({ code: 'NoPermissions', message: 'bad key' })
    await vi.waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledTimes(1))

    await expect(provider.provideLanguageModelChatResponse(
      model(),
      [],
      options(),
      { report: vi.fn() },
      new CancellationTokenSource().token,
    )).rejects.toMatchObject({ code: 'Blocked', message: 'slow down' })
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1)
  })

  it('deduplicates refreshes, caches models, and fires only when data changes', async () => {
    const provider = createProvider('secret')
    let resolveDiscovery!: (value: ReturnType<typeof discovery>) => void
    clientMocks.discover.mockReturnValueOnce(new Promise(resolve => resolveDiscovery = resolve))
    const changes = vi.fn()
    provider.onDidChangeLanguageModelChatInformation(changes)
    const token = new CancellationTokenSource().token

    const first = provider.provideLanguageModelChatInformation({ silent: true }, token)
    const second = provider.provideLanguageModelChatInformation({ silent: false }, token)
    await vi.waitFor(() => expect(clientMocks.discover).toHaveBeenCalledTimes(1))
    expect(clientMocks.discover).toHaveBeenCalledTimes(1)
    resolveDiscovery(discovery())
    await expect(first).resolves.toHaveLength(1)
    await expect(second).resolves.toHaveLength(1)
    expect(changes).toHaveBeenCalledTimes(1)

    clientMocks.discover.mockResolvedValueOnce(discovery())
    await provider.forceRefresh(false)
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('retains cached models on discovery failure and reports interactive errors', async () => {
    const provider = createProvider('secret')
    clientMocks.discover.mockResolvedValueOnce(discovery())
    await provider.forceRefresh(false)
    clientMocks.discover.mockRejectedValueOnce(new Error('offline'))

    await expect(provider.forceRefresh(true)).resolves.toHaveLength(1)
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      'CLIProxyAPI model discovery failed: offline',
    )
    expect(vscodeMock.output.appendLine).toHaveBeenCalledWith('Model discovery failed: offline')
  })

  it('handles rejected discovery credentials without a generic error prompt', async () => {
    const provider = createProvider('secret')
    clientMocks.discover.mockRejectedValueOnce(new ProxyHttpError('bad key', 403))
    window.showWarningMessage.mockResolvedValue(undefined)

    await expect(provider.forceRefresh(true)).resolves.toEqual([])
    await vi.waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledTimes(1))
    expect(window.showErrorMessage).not.toHaveBeenCalled()
  })

  it('configures a missing credential, refreshes explicitly, and counts tokens', async () => {
    const provider = createProvider()
    window.showInputBox
      .mockResolvedValueOnce('http://new-proxy/')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(' entered-key ')
    clientMocks.discover.mockResolvedValue(discovery())

    await provider.configure()
    expect(vscodeMock.secrets.get('universalChatProvider.apiKey')).toBe('entered-key')
    expect(vscodeMock.settings.get('universalChatProvider.baseUrl')).toBe('http://new-proxy')
    expect(clientMocks.discover).toHaveBeenCalledTimes(1)

    // Token counts are a purely local `tokenx` estimate; the proxy is never queried.
    await expect(provider.provideTokenCount(
      model(),
      'hello',
      new CancellationTokenSource().token,
    )).resolves.toBe(estimateTokens('hello'))
  })

  it('finishes an interactive refresh when configuration occurs during onboarding', async () => {
    const provider = createProvider()
    window.showInformationMessage.mockResolvedValueOnce('Configure Connection')
    window.showInputBox
      .mockResolvedValueOnce('http://new-proxy/')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('entered-key')
    clientMocks.discover.mockResolvedValueOnce(discovery())

    await expect(provider.provideLanguageModelChatInformation(
      { silent: false },
      new CancellationTokenSource().token,
    )).resolves.toHaveLength(1)

    expect(clientMocks.discover).toHaveBeenCalledTimes(1)
    expect(vscodeMock.secrets.get('universalChatProvider.apiKey')).toBe('entered-key')
  })

  it('does nothing when connection configuration is cancelled', async () => {
    const provider = createProvider()
    window.showInputBox.mockResolvedValueOnce(undefined)

    await provider.configure()
    expect(clientMocks.discover).not.toHaveBeenCalled()
  })

  it('shows onboarding once and clears credentials', async () => {
    const provider = createProvider()
    window.showInformationMessage.mockResolvedValue(undefined)

    await provider.initialize()
    await provider.initialize()
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1)

    const changes = vi.fn()
    provider.onDidChangeLanguageModelChatInformation(changes)
    await provider.clearCredentials()
    expect(changes).toHaveBeenCalledTimes(1)
    expect(window.showInformationMessage).toHaveBeenCalledTimes(2)
    provider.dispose()
  })

  it('refreshes models on startup when credentials are stored', async () => {
    const provider = createProvider('secret')
    clientMocks.discover.mockResolvedValueOnce(discovery())

    await provider.initialize()

    expect(clientMocks.discover).toHaveBeenCalledTimes(1)
  })
})

function createProvider(apiKey?: string): UniversalChatProvider {
  if (apiKey !== undefined)
    vscodeMock.secrets.set('universalChatProvider.apiKey', apiKey)
  const context = {
    subscriptions: [],
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
    available: [{ id: 'model-a', owned_by: 'test', context_length: 128_000 }],
    metadata: [],
  }
}
