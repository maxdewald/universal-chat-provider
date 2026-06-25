import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
})

describe('cLIProxyClient', () => {
  it('discovers models and tolerates optional metadata failure', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      if (request.url === 'http://proxy/v1/models')
        return Response.json({ data: [{ id: 'model-a' }] })
      if (request.url.includes('client_version'))
        return new Response('optional unavailable', { status: 503 })
      throw new Error(`Unexpected URL ${request.url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../../src/cliproxy/client')
    const client = new CLIProxyClient('http://proxy', 'secret')

    const result = await client.discover()

    expect(result.available).toEqual([{ id: 'model-a' }])
    expect(result.metadata).toEqual([])
    const modelsRequest = fetchMock.mock.calls.find(([request]) => request.url === 'http://proxy/v1/models')?.[0]
    expect(modelsRequest?.method).toBe('GET')
    expect(modelsRequest?.headers.get('authorization')).toBe('Bearer secret')
    expect(modelsRequest?.headers.get('content-type')).toBe('application/json')
  })

  it('reports JSON and plain-text HTTP errors without losing the body', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      if (request.url.includes('client_version'))
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
    const fetchMock = vi.fn<(request: Request) => Promise<Response>>().mockResolvedValue(new Response(events, {
      headers: { 'content-type': 'text/event-stream' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../../src/cliproxy/client')
    const handlers = callbacks()
    const signal = new AbortController().signal

    await new CLIProxyClient('http://proxy', 'key').streamResponse({ model: 'x' }, handlers, signal)

    const request = fetchMock.mock.calls[0]![0]
    expect(request.url).toBe('http://proxy/v1/responses')
    expect(request.method).toBe('POST')
    expect(request.headers.get('authorization')).toBe('Bearer key')
    expect(request.headers.get('content-type')).toBe('application/json')
    expect(handlers.onText).toHaveBeenCalledWith('hello')
    expect(handlers.onThinking).toHaveBeenCalledWith('think')
    expect(handlers.onToolCall).toHaveBeenCalledTimes(1)
    expect(handlers.onToolCall).toHaveBeenCalledWith('call-1', 'lookup', { q: 'x' })
    expect(handlers.onUsage).toHaveBeenCalledWith({ output_tokens: 2 })
  })

  it('forwards prompt cache keys as CLIProxyAPI session hints', async () => {
    const fetchMock = vi.fn<(request: Request) => Promise<Response>>()
      .mockResolvedValue(new Response(event({ type: 'response.completed' })))
    vi.stubGlobal('fetch', fetchMock)
    const { CLIProxyClient } = await import('../../src/cliproxy/client')

    await new CLIProxyClient('http://proxy', 'key').streamResponse(
      { model: 'x', prompt_cache_key: 'universal-chat-provider-cache-key' },
      callbacks(),
      new AbortController().signal,
    )

    const { headers } = fetchMock.mock.calls[0]![0]
    expect(headers.get('authorization')).toBe('Bearer key')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('session_id')).toBe('universal-chat-provider-cache-key')
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

  it('preserves nested error event metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(event({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'too long',
        param: 'input',
      },
    }))))
    const { CLIProxyClient } = await import('../../src/cliproxy/client')

    await expect(new CLIProxyClient('http://proxy', 'key')
      .streamResponse({}, callbacks(), new AbortController().signal))
      .rejects
      .toMatchObject({
        message: 'too long',
        details: {
          errorType: 'invalid_request_error',
          code: 'context_length_exceeded',
          param: 'input',
        },
      })
  })

  it('preserves response failed metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(event({
      type: 'response.failed',
      response: {
        id: 'resp_1',
        status: 'failed',
        error: {
          code: 'context_length_exceeded',
          message: 'too long',
        },
      },
    }))))
    const { CLIProxyClient } = await import('../../src/cliproxy/client')

    await expect(new CLIProxyClient('http://proxy', 'key')
      .streamResponse({}, callbacks(), new AbortController().signal))
      .rejects
      .toMatchObject({
        message: 'too long',
        details: {
          code: 'context_length_exceeded',
          responseId: 'resp_1',
          responseStatus: 'failed',
        },
      })
  })

  it('preserves top-level stream error metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(event({
      type: 'error',
      code: 'upstream_error',
      message: 'upstream failed',
    }))))
    const { CLIProxyClient } = await import('../../src/cliproxy/client')

    await expect(new CLIProxyClient('http://proxy', 'key')
      .streamResponse({}, callbacks(), new AbortController().signal))
      .rejects
      .toMatchObject({
        message: 'upstream failed',
        details: { code: 'upstream_error' },
      })
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
