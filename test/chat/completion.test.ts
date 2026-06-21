import type { CompletionDeps } from '../../src/chat/completion'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CancellationTokenSource } from 'vscode'
import { streamCompletion } from '../../src/chat/completion'
import { ProxyHttpError } from '../../src/cliproxy/errors'

const clientMocks = vi.hoisted(() => ({
  streamResponse: vi.fn(),
}))

vi.mock('../../src/cliproxy/client', () => ({
  CLIProxyClient: class {
    streamResponse = clientMocks.streamResponse
  },
}))

beforeEach(() => {
  clientMocks.streamResponse.mockReset()
})

describe('streamCompletion', () => {
  it('requires credentials', async () => {
    await expect(streamCompletion(deps(), {}, callbacks())).rejects.toMatchObject({
      code: 'NoPermissions',
      message: 'Configure a CLIProxyAPI API key first.',
    })
    expect(clientMocks.streamResponse).not.toHaveBeenCalled()
  })

  it('resolves quietly when cancellation aborts the stream', async () => {
    const token = new CancellationTokenSource()
    clientMocks.streamResponse.mockImplementationOnce(async (_body, _callbacks, signal: AbortSignal) => {
      token.cancel()
      expect(signal.aborted).toBe(true)
      throw new Error('aborted')
    })

    await expect(streamCompletion(deps('key'), {}, callbacks(), token.token)).resolves.toBeUndefined()
  })

  it.each([
    [401, 'NoPermissions', true],
    [403, 'NoPermissions', true],
    [404, 'NotFound', false],
    [429, 'Blocked', false],
  ])('maps HTTP %s errors', async (status, code, recovers) => {
    const rejected = vi.fn()
    clientMocks.streamResponse.mockRejectedValueOnce(new ProxyHttpError('failed', status))

    await expect(
      streamCompletion(deps('key', rejected), {}, callbacks()),
    ).rejects.toMatchObject({ code, message: 'failed' })
    expect(rejected).toHaveBeenCalledTimes(recovers ? 1 : 0)
  })
})

function deps(apiKey?: string, onCredentialsRejected = vi.fn()): CompletionDeps {
  return {
    connection: {
      ensureReady: vi.fn(async () => {}),
      baseUrl: () => 'http://proxy',
    },
    credentials: {
      get: vi.fn(async () => apiKey),
    },
    onCredentialsRejected,
  } as unknown as CompletionDeps
}

function callbacks() {
  return {
    onText: vi.fn(),
    onToolCall: vi.fn(),
  }
}
