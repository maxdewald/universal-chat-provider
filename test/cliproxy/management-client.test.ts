import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOGIN_PROVIDERS, ManagementClient, ManagementError } from '../../src/cliproxy/management-client'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('management client', () => {
  it('requests an auth URL with the management bearer key', async () => {
    const fetchMock = vi.fn<(request: Request) => Promise<Response>>(async () => Response.json({ status: 'ok', url: 'https://login' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ManagementClient('http://127.0.0.1:8317', 'mgmt-key')

    await expect(client.requestAuthUrl('codex-auth-url')).resolves.toBe('https://login')
    const request = fetchMock.mock.calls[0]![0]
    expect(request.url).toBe('http://127.0.0.1:8317/v0/management/codex-auth-url?is_webui=true')
    expect(request.method).toBe('GET')
    expect(request.headers.get('authorization')).toBe('Bearer mgmt-key')
  })

  it('lists auth files defensively and skips malformed entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      files: [{ name: 'a.json', type: 'codex' }, { size: 1 }, { name: 'b.json' }],
    })))
    const client = new ManagementClient('http://127.0.0.1:8317', 'mgmt-key')

    await expect(client.listAuthFiles()).resolves.toEqual([
      { name: 'a.json', type: 'codex' },
      { name: 'b.json' },
    ])
  })

  it('encodes the account name when deleting', async () => {
    const fetchMock = vi.fn<(request: Request) => Promise<Response>>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ManagementClient('http://127.0.0.1:8317', 'mgmt-key')

    await client.deleteAuthFile('my account.json')
    const request = fetchMock.mock.calls[0]![0]
    expect(request.url).toBe('http://127.0.0.1:8317/v0/management/auth-files?name=my%20account.json')
    expect(request.method).toBe('DELETE')
  })

  it('surfaces management errors with their status and message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid key' }, { status: 401 })))
    const client = new ManagementClient('http://127.0.0.1:8317', 'mgmt-key')

    await expect(client.listAuthFiles()).rejects.toMatchObject({ message: 'invalid key' })
    await expect(client.listAuthFiles()).rejects.toBeInstanceOf(ManagementError)
  })

  it('exposes the supported login providers in picker order', () => {
    expect(LOGIN_PROVIDERS.map(provider => provider.endpoint)).toEqual([
      'codex-auth-url',
      'anthropic-auth-url',
      'antigravity-auth-url',
      'kimi-auth-url',
      'xai-auth-url',
    ])
    expect(LOGIN_PROVIDERS.find(provider => provider.label === 'Anthropic Claude')?.endpoint).toBe('anthropic-auth-url')
  })
})
