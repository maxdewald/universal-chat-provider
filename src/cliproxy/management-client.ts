import type { BeforeErrorHook, KyInstance } from 'ky'
import ky, { isHTTPError } from 'ky'
import { isPlainObject } from 'moderndash'

export interface LoginProvider {
  label: string
  detail: string
  endpoint: string
}

export const LOGIN_PROVIDERS: readonly LoginProvider[] = [
  { label: 'OpenAI Codex', detail: 'ChatGPT / Codex account', endpoint: 'codex-auth-url' },
  { label: 'Anthropic Claude', detail: 'Claude Code account', endpoint: 'anthropic-auth-url' },
  { label: 'Antigravity', detail: 'Antigravity account', endpoint: 'antigravity-auth-url' },
  { label: 'Kimi', detail: 'Moonshot Kimi account', endpoint: 'kimi-auth-url' },
  { label: 'xAI Grok', detail: 'Grok Build account', endpoint: 'xai-auth-url' },
]

export interface ManagementEndpoint {
  baseUrl: string
  key: string
}

export interface AuthFile {
  name: string
  type?: string
}

export class ManagementError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const toManagementError: BeforeErrorHook = ({ error }) => {
  if (!isHTTPError(error))
    return error
  return new ManagementError(
    managementErrorMessage(error.data) ?? `Management request failed with HTTP ${error.response.status}.`,
    error.response.status,
  )
}

export class ManagementClient {
  private readonly fetcher: KyInstance

  constructor(baseUrl: string, key: string) {
    // ponytail: retry:0/timeout:false preserve the old raw-fetch behavior; ky just folds
    // away the bearer header, base path, and !ok error parsing (the beforeError hook).
    this.fetcher = ky.create({
      prefix: `${baseUrl}/v0/management`,
      headers: { Authorization: `Bearer ${key}` },
      retry: 0,
      timeout: false,
      hooks: { beforeError: [toManagementError] },
    })
  }

  async requestAuthUrl(endpoint: string, signal?: AbortSignal): Promise<string> {
    const payload = await this.fetcher.get(`/${endpoint}?is_webui=true`, { signal: signal ?? null }).json<{ url?: unknown }>()
    if (typeof payload.url !== 'string')
      throw new ManagementError('CLIProxyAPI returned an invalid auth URL response.', 502)
    return payload.url
  }

  async listAuthFiles(signal?: AbortSignal): Promise<AuthFile[]> {
    return (await this.listAuthFilesRaw(signal))
      .filter((file): file is { name: string, type?: string } => typeof file.name === 'string')
      .map(file => (typeof file.type === 'string' ? { name: file.name, type: file.type } : { name: file.name }))
  }

  async deleteAuthFile(name: string, signal?: AbortSignal): Promise<void> {
    await this.fetcher.delete(`/auth-files?name=${encodeURIComponent(name)}`, { signal: signal ?? null })
  }

  async listAuthFilesRaw(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const payload = await this.fetcher.get('/auth-files', { signal: signal ?? null }).json<{ files?: unknown }>()
    return Array.isArray(payload.files) ? payload.files.filter(isPlainObject) : []
  }

  // Proxies an upstream request through CLIProxyAPI using a stored credential.
  // CPA substitutes the literal "$TOKEN$" in headers with the account's token.
  async apiCall(payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ statusCode: number, body: unknown }> {
    const json = await this.fetcher.post('/api-call', { json: payload, signal: signal ?? null })
      .json<{ status_code?: number, statusCode?: number, body?: unknown }>()
    return { statusCode: json.status_code ?? json.statusCode ?? 0, body: json.body }
  }
}

function managementErrorMessage(data: unknown): string | undefined {
  if (isPlainObject(data) && typeof data.error === 'string')
    return data.error
  return typeof data === 'string' && data.trim() ? data.trim() : undefined
}
