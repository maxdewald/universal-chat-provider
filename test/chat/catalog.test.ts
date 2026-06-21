import { beforeEach, describe, expect, it, vi } from 'vitest'

const catalogUrl = 'https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json'

beforeEach(() => {
  vi.resetModules()
})

describe('fetchCatalog', () => {
  it('fetches, flattens, and caches the catalog for the session', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ provider: [{ id: 'model-a', context_length: 10 }] }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchCatalog } = await import('../../src/chat/catalog')

    const first = await fetchCatalog()
    const second = await fetchCatalog()

    expect(first.get('model-a')?.context_length).toBe(10)
    expect(second).toBe(first)
    expect(fetchMock.mock.calls.filter(([url]) => url === catalogUrl)).toHaveLength(1)
  })

  it('returns an empty catalog when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))
    const { fetchCatalog } = await import('../../src/chat/catalog')

    await expect(fetchCatalog()).resolves.toEqual(new Map())
  })

  it('returns an empty catalog on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    const { fetchCatalog } = await import('../../src/chat/catalog')

    await expect(fetchCatalog()).resolves.toEqual(new Map())
  })
})

describe('flattenCatalog', () => {
  it('prefers richer duplicate metadata', async () => {
    const { flattenCatalog } = await import('../../src/chat/catalog')

    const catalog = flattenCatalog({
      openai: [{ id: 'shared', context_length: 128_000 }],
      aliases: [{ id: 'shared', context_length: 128_000, thinking: { levels: ['low', 'high'] } }],
    })

    expect(catalog.get('shared')?.thinking?.levels).toEqual(['low', 'high'])
  })

  it('ignores malformed catalog sections', async () => {
    const { flattenCatalog } = await import('../../src/chat/catalog')

    expect(flattenCatalog(null)).toEqual(new Map())
    expect(flattenCatalog({
      invalid: 'not an array',
      entries: [null, {}, { id: 1 }, { id: 'valid', outputTokenLimit: 20 }],
    })).toEqual(new Map([['valid', { id: 'valid', outputTokenLimit: 20 }]]))
  })
})
