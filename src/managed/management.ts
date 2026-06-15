import { isPlainObject } from 'moderndash'

/** OAuth providers CLIProxyAPI can log in, in the order shown in the picker. */
export interface LoginProvider {
  id: string
  label: string
  detail: string
  /** Management endpoint (relative to `/v0/management/`) that returns an auth URL. */
  endpoint: string
}

export const LOGIN_PROVIDERS: readonly LoginProvider[] = [
  { id: 'gemini', label: 'Google Gemini', detail: 'Gemini CLI account', endpoint: 'gemini-cli-auth-url' },
  { id: 'codex', label: 'OpenAI Codex', detail: 'ChatGPT / Codex account', endpoint: 'codex-auth-url' },
  { id: 'claude', label: 'Anthropic Claude', detail: 'Claude Code account', endpoint: 'anthropic-auth-url' },
  { id: 'antigravity', label: 'Antigravity', detail: 'Antigravity account', endpoint: 'antigravity-auth-url' },
  { id: 'kimi', label: 'Kimi', detail: 'Moonshot Kimi account', endpoint: 'kimi-auth-url' },
  { id: 'xai', label: 'xAI Grok', detail: 'Grok Build account', endpoint: 'xai-auth-url' },
]

export interface AuthUrlResponse {
  url: string
  state: string
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

/** Thin typed client over the CLIProxyAPI `/v0/management` API. */
export class ManagementClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
  ) {}

  async requestAuthUrl(endpoint: string, signal?: AbortSignal): Promise<AuthUrlResponse> {
    // `is_webui=true` makes the server run the OAuth flow itself: it starts a
    // callback forwarder on the provider's fixed port and relays the redirect
    // into its own `/<provider>/callback` route. Without it the flow expects a
    // CLI-managed local listener we never start, so the browser redirect lands
    // on a dead port (ERR_CONNECTION_REFUSED).
    const payload = await this.getJson<{ url?: unknown, state?: unknown }>(`/${endpoint}?is_webui=true`, signal)
    if (typeof payload.url !== 'string' || typeof payload.state !== 'string')
      throw new ManagementError('CLIProxyAPI returned an invalid auth URL response.', 502)
    return { url: payload.url, state: payload.state }
  }

  async listAuthFiles(signal?: AbortSignal): Promise<AuthFile[]> {
    const payload = await this.getJson<{ files?: unknown }>('/auth-files', signal)
    if (!Array.isArray(payload.files))
      return []
    return payload.files
      .filter(isPlainObject)
      .filter((file): file is { name: string, type?: string } => typeof file.name === 'string')
      .map(file => (typeof file.type === 'string' ? { name: file.name, type: file.type } : { name: file.name }))
  }

  async deleteAuthFile(name: string, signal?: AbortSignal): Promise<void> {
    await this.send('DELETE', `/auth-files?name=${encodeURIComponent(name)}`, undefined, signal)
  }

  /** Manual no-browser fallback: hand the provider redirect back to the server. */
  async postOAuthCallback(body: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    await this.send('POST', '/oauth-callback', body, signal)
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.send('GET', path, undefined, signal)
    return await response.json() as T
  }

  private async send(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/v0/management${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ManagementError(
        managementErrorMessage(text) ?? `Management request failed with HTTP ${response.status}.`,
        response.status,
      )
    }
    return response
  }
}

function managementErrorMessage(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text)
    if (isPlainObject(body) && typeof body.error === 'string')
      return body.error
  }
  catch {}
  return text.trim() ? text.trim() : undefined
}
