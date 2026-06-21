import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildStatusSnapshot } from '../../src/cliproxy/status'

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('buildStatusSnapshot', () => {
  it('forces external status and includes the account count when available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ files: [{ name: 'a' }, { name: 'b' }] })))

    await expect(buildStatusSnapshot({
      mode: 'external',
      lastStatus: 'error',
      baseUrl: 'http://127.0.0.1:8317',
      version: undefined,
      management: { baseUrl: 'http://127.0.0.1:8317', key: 'mgmt-key' },
    })).resolves.toEqual({
      mode: 'external',
      status: 'external',
      baseUrl: 'http://127.0.0.1:8317',
      accounts: 2,
    })
  })

  it('preserves managed status and omits failed account probes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))

    await expect(buildStatusSnapshot({
      mode: 'managed',
      lastStatus: 'running',
      baseUrl: 'http://127.0.0.1:8317',
      version: '7.2.5',
      management: { baseUrl: 'http://127.0.0.1:8317', key: 'mgmt-key' },
    })).resolves.toEqual({
      mode: 'managed',
      status: 'running',
      baseUrl: 'http://127.0.0.1:8317',
      version: '7.2.5',
    })
  })
})
