import type {
  ProxyModelListEntry,
  ProxyModelMetadata,
} from '../chat/model'
import { isPlainObject } from 'moderndash'
import { asRecord, asString } from '../shared/json'
import { ProxyHttpError } from './errors'
import { parseServerSentEvents } from './sse'

export interface DiscoveryResult {
  available: ProxyModelListEntry[]
  metadata: ProxyModelMetadata[]
}

export interface StreamCallbacks {
  onText: (delta: string) => void
  onThinking?: (delta: string) => void
  onToolCall: (callId: string, name: string, input: object) => void
  onUsage?: (usage: unknown) => void
}

interface PendingToolCall {
  callId: string
  name: string
  arguments: string
}

export class CLIProxyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/healthz`, {
        method: 'HEAD',
        ...(signal ? { signal } : {}),
      })
      return response.ok
    }
    catch {
      return false
    }
  }

  async discover(signal?: AbortSignal): Promise<DiscoveryResult> {
    const [available, metadata] = await Promise.all([
      this.getJson<{ data?: ProxyModelListEntry[] }>('/v1/models', signal)
        .then(payload => payload.data ?? []),
      this.getJson<{ models?: ProxyModelMetadata[] }>('/v1/models?client_version=0.114.0', signal)
        .then(payload => payload.models ?? [])
        .catch(() => []),
    ])
    return { available, metadata }
  }

  async streamResponse(
    body: Record<string, unknown>,
    callbacks: StreamCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: this.headers(body),
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok)
      throw await responseError(response)
    if (!response.body)
      throw new Error('CLIProxyAPI returned an empty streaming response.')

    const pending = new Map<string, PendingToolCall>()
    const emitted = new Set<string>()

    for await (const event of parseServerSentEvents(response.body)) {
      if (event.data === '[DONE]')
        break

      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>
      }
      catch {
        continue
      }
      const type = asString(payload.type) ?? event.event

      if (type === 'response.output_text.delta') {
        const delta = asString(payload.delta)
        if (delta !== undefined && delta.length > 0)
          callbacks.onText(delta)
      }
      else if (type === 'response.reasoning_summary_text.delta') {
        const delta = asString(payload.delta)
        if (delta !== undefined && delta.length > 0)
          callbacks.onThinking?.(delta)
      }
      else if (type === 'response.output_item.added') {
        const item = asRecord(payload.item)
        if (item?.type === 'function_call') {
          const key = toolKey(payload, item)
          pending.set(key, {
            callId: asString(item.call_id) ?? key,
            name: asString(item.name) ?? 'unknown_tool',
            arguments: asString(item.arguments) ?? '',
          })
        }
      }
      else if (type === 'response.function_call_arguments.delta') {
        const key = toolKey(payload)
        const current = pending.get(key)
        if (current)
          current.arguments += asString(payload.delta) ?? ''
      }
      else if (type === 'response.output_item.done') {
        const item = asRecord(payload.item)
        if (item?.type === 'function_call') {
          const key = toolKey(payload, item)
          const current = pending.get(key) ?? {
            callId: asString(item.call_id) ?? key,
            name: asString(item.name) ?? 'unknown_tool',
            arguments: '',
          }
          current.arguments = asString(item.arguments) ?? current.arguments
          emitToolCall(current, callbacks, emitted)
        }
      }
      else if (type === 'response.completed') {
        for (const call of pending.values())
          emitToolCall(call, callbacks, emitted)
        callbacks.onUsage?.(asRecord(payload.response)?.usage)
      }
      else if (type === 'response.failed' || type === 'error') {
        const error = asRecord(payload.error) ?? asRecord(asRecord(payload.response)?.error)
        throw new Error(asString(error?.message) ?? 'CLIProxyAPI response failed.')
      }
    }
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok)
      throw await responseError(response)
    return await response.json() as T
  }

  private headers(body?: Record<string, unknown>): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }

    const promptCacheKey = asString(body?.prompt_cache_key)
    if (promptCacheKey !== undefined && promptCacheKey.length > 0) {
      headers.Session_id = promptCacheKey
    }

    return headers
  }
}

async function responseError(response: Response): Promise<ProxyHttpError> {
  const text = await response.text().catch(() => '')
  let body: unknown = text
  try {
    body = JSON.parse(text) as unknown
  }
  catch {}
  const message = isPlainObject(body)
    ? asString(body.error) ?? asString(asRecord(body.error)?.message)
    : typeof body === 'string' && body.trim() ? body.trim() : undefined
  return new ProxyHttpError(message ?? `CLIProxyAPI request failed with HTTP ${response.status}.`, response.status, body)
}

function emitToolCall(
  call: PendingToolCall,
  callbacks: StreamCallbacks,
  emitted: Set<string>,
): void {
  if (emitted.has(call.callId))
    return
  emitted.add(call.callId)
  let input: object = {}
  if (call.arguments.trim()) {
    try {
      const parsed: unknown = JSON.parse(call.arguments)
      input = isPlainObject(parsed) ? parsed : { value: parsed }
    }
    catch {
      input = { raw: call.arguments }
    }
  }
  callbacks.onToolCall(call.callId, call.name, input)
}

function toolKey(payload: Record<string, unknown>, item?: Record<string, unknown>): string {
  return asString(payload.item_id)
    ?? asString(item?.id)
    ?? asString(item?.call_id)
    ?? `output-${String(payload.output_index ?? 'unknown')}`
}
