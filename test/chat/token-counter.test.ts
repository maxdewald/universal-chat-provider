import type { OutputChannel } from 'vscode'
import type { ProviderModel } from '../../src/chat/model'
import type { TokenCounterDeps } from '../../src/chat/token-counter'
import type { CredentialStore } from '../../src/cliproxy/credentials'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CancellationTokenSource } from 'vscode'
import { estimateTokens } from '../../src/chat/estimate'
import { TokenCounter } from '../../src/chat/token-counter'
import { vscodeMock } from '../support/vscode'

const clientMocks = vi.hoisted(() => ({ countInputTokens: vi.fn() }))

vi.mock('../../src/cliproxy/client', () => ({
  CLIProxyClient: class {
    countInputTokens = clientMocks.countInputTokens
  },
}))

const model = { proxyModelId: 'model-a' } as ProviderModel

beforeEach(() => {
  clientMocks.countInputTokens.mockReset()
  clientMocks.countInputTokens.mockResolvedValue(11)
  vscodeMock.output.appendLine.mockReset()
})

describe('token counter', () => {
  it('answers instantly with a local estimate, then serves the exact proxy count once cached', async () => {
    const counter = new TokenCounter(deps())

    expect(counter.count(model, 'hello')).toBe(estimateTokens('hello'))
    await counter.whenIdle()
    expect(counter.count(model, 'hello')).toBe(11)

    expect(counter.count(model, 'different')).toBe(estimateTokens('different'))
    await counter.whenIdle()
    expect(counter.count(model, 'different')).toBe(11)

    expect(clientMocks.countInputTokens).toHaveBeenCalledTimes(2)
  })

  it('coalesces identical content into a single background count', async () => {
    const counter = new TokenCounter(deps())

    counter.count(model, 'hello')
    counter.count(model, 'hello')
    await counter.whenIdle()

    expect(clientMocks.countInputTokens).toHaveBeenCalledTimes(1)
    expect(counter.count(model, 'hello')).toBe(11)
  })

  it('keeps serving the estimate and retries when a background count fails, without caching it', async () => {
    clientMocks.countInputTokens
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(9)
    const counter = new TokenCounter(deps())

    expect(counter.count(model, 'hello')).toBe(estimateTokens('hello'))
    await counter.whenIdle()
    expect(vscodeMock.output.appendLine).toHaveBeenCalledWith('[token-count] model-a: offline')

    // The failure was not cached: still the estimate, and a fresh fetch is started.
    expect(counter.count(model, 'hello')).toBe(estimateTokens('hello'))
    await counter.whenIdle()
    expect(counter.count(model, 'hello')).toBe(9)
  })

  it('returns the estimate without calling the proxy when no credentials are stored', async () => {
    const counter = new TokenCounter(deps({ apiKey: undefined }))

    expect(counter.count(model, 'hello')).toBe(estimateTokens('hello'))
    await counter.whenIdle()
    expect(clientMocks.countInputTokens).not.toHaveBeenCalled()
  })

  it('returns 0 for an already-cancelled token without counting', async () => {
    const counter = new TokenCounter(deps())
    const source = new CancellationTokenSource()
    source.cancel()

    expect(counter.count(model, 'hello', source.token)).toBe(0)
    await counter.whenIdle()
    expect(clientMocks.countInputTokens).not.toHaveBeenCalled()
  })
})

function deps(options: { apiKey: string | undefined } = { apiKey: 'key' }): TokenCounterDeps {
  return {
    connection: { ensureReady: async () => {}, baseUrl: () => 'http://proxy' },
    credentials: { get: async () => options.apiKey } as unknown as CredentialStore,
    output: vscodeMock.output as unknown as OutputChannel,
  }
}
