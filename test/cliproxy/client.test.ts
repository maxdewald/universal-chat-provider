import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
})

describe('cLIProxyClient', () => {
  it('checks health without credentials and handles transport failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../../src/cliproxy/client')
    const signal = new AbortController().signal
    const client = new CLIProxyClient('http://proxy', 'secret')

    await expect(client.health(signal)).resolves.toBe(true)
    await expect(client.health()).resolves.toBe(false)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://proxy/healthz', {
      method: 'HEAD',
      signal,
    })
  })

  it('discovers models and tolerates optional metadata failure', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'http://proxy/v1/models')
        return Response.json({ data: [{ id: 'model-a' }] })
      if (url.includes('client_version'))
        return new Response('optional unavailable', { status: 503 })
      throw new Error(`Unexpected URL ${url} ${JSON.stringify(init)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../../src/cliproxy/client')
    const client = new CLIProxyClient('http://proxy', 'secret')

    const result = await client.discover()

    expect(result.available).toEqual([{ id: 'model-a' }])
    expect(result.metadata).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith('http://proxy/v1/models', {
      headers: {
        'Authorization': 'Bearer secret',
        'Content-Type': 'application/json',
      },
    })
  })

  it('reports JSON and plain-text HTTP errors without losing the body', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('client_version'))
        return Response.json({ models: [] })
      return Response.json({ error: { message: 'bad key' } }, { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../../src/cliproxy/client')
    const { ProxyHttpError } = await import('../../src/cliproxy/errors')
    const client = new CLIProxyClient('http://proxy', 'key')

    await expect(client.discover()).rejects.toMatchObject({
      message: 'bad key',
      status: 401,
      body: { error: { message: 'bad key' } },
    })

    fetchMock.mockResolvedValueOnce(new Response('proxy unavailable', { status: 503 }))
    await expect(client.streamResponse({}, callbacks(), new AbortController().signal))
      .rejects
      .toEqual(new ProxyHttpError('proxy unavailable', 503, 'proxy unavailable'))
  })

  it('streams text, thinking, usage, and assembled tool calls exactly once', async () => {
    const events = [
      event({ type: 'response.output_text.delta', delta: 'hello' }),
      'data: not-json\n\n',
      event({ type: 'response.reasoning_summary_text.delta', delta: 'think' }),
      event({
        type: 'response.output_item.added',
        item_id: 'item-1',
        item: { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"q":' },
      }),
      event({ type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '"x"}' }),
      event({
        type: 'response.output_item.done',
        item_id: 'item-1',
        item: { type: 'function_call', call_id: 'call-1', name: 'lookup' },
      }),
      event({ type: 'response.completed', response: { usage: { output_tokens: 2 } } }),
      'data: [DONE]\n\n',
      event({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'ignored', name: 'late', arguments: '{}' },
      }),
    ].join('')
    const fetchMock = vi.fn().mockResolvedValue(new Response(events, {
      headers: { 'content-type': 'text/event-stream' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../../src/cliproxy/client')
    const handlers = callbacks()
    const signal = new AbortController().signal

    await new CLIProxyClient('http://proxy', 'key').streamResponse({ model: 'x' }, handlers, signal)

    expect(fetchMock).toHaveBeenCalledWith('http://proxy/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer key',
        'Content-Type': 'application/json',
      },
      body: '{"model":"x"}',
      signal,
    })
    expect(handlers.onText).toHaveBeenCalledWith('hello')
    expect(handlers.onThinking).toHaveBeenCalledWith('think')
    expect(handlers.onToolCall).toHaveBeenCalledTimes(1)
    expect(handlers.onToolCall).toHaveBeenCalledWith('call-1', 'lookup', { q: 'x' })
    expect(handlers.onUsage).toHaveBeenCalledWith({ output_tokens: 2 })
  })

  it('forwards prompt cache keys as CLIProxyAPI session hints', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(event({ type: 'response.completed' })))
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../../src/cliproxy/client')

    await new CLIProxyClient('http://proxy', 'key').streamResponse(
      { model: 'x', prompt_cache_key: 'universal-chat-provider-cache-key' },
      callbacks(),
      new AbortController().signal,
    )

    const init = fetchMock.mock.calls[0]?.[1]
    const headers = init?.headers as Record<string, string>
    expect(headers).toEqual({
      'Authorization': 'Bearer key',
      'Content-Type': 'application/json',
      'Session_id': 'universal-chat-provider-cache-key',
    })
  })

  it('emits completed pending calls and preserves invalid or scalar arguments', async () => {
    const body = [
      event({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'raw', name: 'raw_tool', arguments: '{bad' },
      }),
      event({
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'function_call', call_id: 'scalar', name: 'scalar_tool', arguments: '42' },
      }),
      event({ type: 'response.completed', response: {} }),
    ].join('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    const { CLIProxyClient } = await import('../../src/cliproxy/client')
    const handlers = callbacks()

    await new CLIProxyClient('http://proxy', 'key')
      .streamResponse({}, handlers, new AbortController().signal)

    expect(handlers.onToolCall).toHaveBeenCalledWith('scalar', 'scalar_tool', { value: 42 })
    expect(handlers.onToolCall).toHaveBeenCalledWith('raw', 'raw_tool', { raw: '{bad' })
  })

  it('rejects failed events and empty streaming bodies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(event({
        type: 'response.failed',
        response: { error: { message: 'generation failed' } },
      })))
      .mockResolvedValueOnce(new Response(null))
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../../src/cliproxy/client')
    const client = new CLIProxyClient('http://proxy', 'key')

    await expect(client.streamResponse({}, callbacks(), new AbortController().signal))
      .rejects
      .toThrow('generation failed')
    await expect(client.streamResponse({}, callbacks(), new AbortController().signal))
      .rejects
      .toThrow('empty streaming response')
  })
})

function callbacks() {
  return {
    onText: vi.fn(),
    onThinking: vi.fn(),
    onToolCall: vi.fn(),
    onUsage: vi.fn(),
  }
}

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}
