import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOGIN_PROVIDERS, ManagementClient, ManagementError } from '../src/managed/management'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('management client', () => {
  it('requests an auth URL with the management bearer key', async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: 'ok', url: 'https://login', state: 's1' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ManagementClient('http://127.0.0.1:8317', 'mgmt-key')

    await expect(client.requestAuthUrl('codex-auth-url')).resolves.toEqual({ url: 'https://login', state: 's1' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8317/v0/management/codex-auth-url?is_webui=true',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer mgmt-key' },
      }),
    )
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
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ManagementClient('http://127.0.0.1:8317', 'mgmt-key')

    await client.deleteAuthFile('my account.json')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8317/v0/management/auth-files?name=my%20account.json',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('surfaces management errors with their status and message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid key' }, { status: 401 })))
    const client = new ManagementClient('http://127.0.0.1:8317', 'mgmt-key')

    await expect(client.listAuthFiles()).rejects.toMatchObject({ message: 'invalid key' })
    await expect(client.listAuthFiles()).rejects.toBeInstanceOf(ManagementError)
  })

  it('exposes the supported login providers in picker order', () => {
    expect(LOGIN_PROVIDERS.map(provider => provider.id)).toEqual([
      'gemini',
      'codex',
      'claude',
      'antigravity',
      'kimi',
      'xai',
    ])
    expect(LOGIN_PROVIDERS.find(provider => provider.id === 'claude')?.endpoint).toBe('anthropic-auth-url')
  })
})
