import type { BeforeErrorHook, KyInstance } from 'ky'
import type {
  ProxyModelListEntry,
  ProxyModelMetadata,
} from '../chat/model'
import type { ProxyStreamErrorDetails } from './errors'
import ky, { isHTTPError } from 'ky'
import { isPlainObject } from 'moderndash'
import { asRecord, asString } from '../shared/json'
import { ProxyHttpError, ProxyStreamError } from './errors'
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

const toProxyHttpError: BeforeErrorHook = ({ error }) => {
  if (!isHTTPError(error))
    return error
  const body = error.data
  const message = isPlainObject(body)
    ? asString(body.error) ?? asString(asRecord(body.error)?.message)
    : typeof body === 'string' && body.trim() ? body.trim() : undefined
  return new ProxyHttpError(
    message ?? `CLIProxyAPI request failed with HTTP ${error.response.status}.`,
    error.response.status,
    body,
  )
}

export class CLIProxyClient {
  private readonly fetcher: KyInstance

  constructor(baseUrl: string, apiKey: string) {
    // ponytail: retry:0/timeout:false keep the old raw-fetch behavior (streaming must
    // not time out); ky folds away the auth header, base url, and !ok error parsing.
    this.fetcher = ky.create({
      prefix: baseUrl,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      retry: 0,
      timeout: false,
      hooks: { beforeError: [toProxyHttpError] },
    })
  }

  async discover(signal?: AbortSignal): Promise<DiscoveryResult> {
    const [available, metadata] = await Promise.all([
      this.fetcher.get('/v1/models', { signal: signal ?? null }).json<{ data?: ProxyModelListEntry[] }>().then(payload => payload.data ?? []),
      this.fetcher.get('/v1/models?client_version=0.114.0', { signal: signal ?? null }).json<{ models?: ProxyModelMetadata[] }>().then(payload => payload.models ?? []).catch(() => []),
    ])
    return { available, metadata }
  }

  async streamResponse(
    body: Record<string, unknown>,
    callbacks: StreamCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    const promptCacheKey = asString(body.prompt_cache_key)
    const sessionHeader = promptCacheKey !== undefined && promptCacheKey.length > 0
      ? { Session_id: promptCacheKey }
      : {}
    const response = await this.fetcher.post('/v1/responses', {
      json: body,
      headers: sessionHeader,
      signal,
    })
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
        throw streamError(payload)
      }
    }
  }
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

function streamError(payload: Record<string, unknown>): ProxyStreamError {
  const response = asRecord(payload.response)
  const error = asRecord(payload.error) ?? asRecord(response?.error)
  const details: ProxyStreamErrorDetails = {}
  const errorType = asString(error?.type)
  const code = asString(error?.code) ?? asString(payload.code)
  const param = asString(error?.param)
  const responseId = asString(response?.id)
  const responseStatus = asString(response?.status)

  if (errorType !== undefined)
    details.errorType = errorType
  if (code !== undefined)
    details.code = code
  if (param !== undefined)
    details.param = param
  if (responseId !== undefined)
    details.responseId = responseId
  if (responseStatus !== undefined)
    details.responseStatus = responseStatus

  return new ProxyStreamError(
    asString(error?.message) ?? asString(payload.message) ?? 'CLIProxyAPI response failed.',
    details,
  )
}

function toolKey(payload: Record<string, unknown>, item?: Record<string, unknown>): string {
  return asString(payload.item_id)
    ?? asString(item?.id)
    ?? asString(item?.call_id)
    ?? `output-${String(payload.output_index ?? 'unknown')}`
}
