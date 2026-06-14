import { beforeEach, describe, expect, it, vi } from 'vitest'

const catalogUrl = 'https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json'

beforeEach(() => {
  vi.resetModules()
})

describe('cLIProxyClient', () => {
  it('checks health without credentials and handles transport failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../src/proxy-client')
    const signal = new AbortController().signal
    const client = new CLIProxyClient('http://proxy', 'secret')

    await expect(client.health(signal)).resolves.toBe(true)
    await expect(client.health()).resolves.toBe(false)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://proxy/healthz', {
      method: 'HEAD',
      signal,
    })
  })

  it('discovers models, tolerates optional metadata failure, and caches the catalog', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'http://proxy/v1/models')
        return Response.json({ data: [{ id: 'model-a' }] })
      if (url.includes('client_version'))
        return new Response('optional unavailable', { status: 503 })
      if (url === catalogUrl)
        return Response.json({ provider: [{ id: 'model-a', context_length: 10 }] })
      throw new Error(`Unexpected URL ${url} ${JSON.stringify(init)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../src/proxy-client')
    const client = new CLIProxyClient('http://proxy', 'secret')

    const first = await client.discover()
    const second = await client.discover()

    expect(first.available).toEqual([{ id: 'model-a' }])
    expect(first.metadata).toEqual([])
    expect(first.catalog.get('model-a')?.context_length).toBe(10)
    expect(second.catalog).toBe(first.catalog)
    expect(fetchMock.mock.calls.filter(([url]) => url === catalogUrl)).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith('http://proxy/v1/models', {
      headers: {
        'Authorization': 'Bearer secret',
        'Content-Type': 'application/json',
      },
    })
  })

  it('returns an empty catalog when its request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === catalogUrl)
        throw new Error('offline')
      return Response.json(url.includes('client_version') ? { models: [] } : { data: [] })
    }))
    const { CLIProxyClient } = await import('../src/proxy-client')

    await expect(new CLIProxyClient('http://proxy', 'key').discover())
      .resolves
      .toMatchObject({ catalog: new Map() })
  })

  it('reports JSON and plain-text HTTP errors without losing the body', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === catalogUrl)
        return new Response(null, { status: 404 })
      if (url.includes('client_version'))
        return Response.json({ models: [] })
      return Response.json({ error: { message: 'bad key' } }, { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient, ProxyHttpError } = await import('../src/proxy-client')
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
    const { CLIProxyClient } = await import('../src/proxy-client')
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
    const { CLIProxyClient } = await import('../src/proxy-client')
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
    const { CLIProxyClient } = await import('../src/proxy-client')
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
