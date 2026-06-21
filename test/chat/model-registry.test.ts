import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelRegistry } from '../../src/chat/model-registry'
import { ProxyHttpError } from '../../src/cliproxy/errors'
import { resetVSCodeMock, vscodeMock, window } from '../support/vscode'

const clientMocks = vi.hoisted(() => ({
  discover: vi.fn(),
}))

const catalogMocks = vi.hoisted(() => ({
  fetchCatalog: vi.fn(),
}))

vi.mock('../../src/cliproxy/client', () => ({
  CLIProxyClient: class {
    discover = clientMocks.discover
  },
}))

vi.mock('../../src/chat/catalog', () => ({
  fetchCatalog: catalogMocks.fetchCatalog,
}))

beforeEach(() => {
  resetVSCodeMock()
  clientMocks.discover.mockReset()
  catalogMocks.fetchCatalog.mockReset().mockResolvedValue(new Map())
})

describe('model registry', () => {
  it('deduplicates refreshes, caches models, and fires only when data changes', async () => {
    const registry = createRegistry('secret')
    let resolveDiscovery!: (value: ReturnType<typeof discovery>) => void
    clientMocks.discover.mockReturnValueOnce(new Promise(resolve => resolveDiscovery = resolve))
    const changes = vi.fn()
    registry.onDidChange(changes)

    const first = registry.refresh(true)
    const second = registry.refresh(false)
    await vi.waitFor(() => expect(clientMocks.discover).toHaveBeenCalledTimes(1))
    resolveDiscovery(discovery())

    await expect(first).resolves.toHaveLength(1)
    await expect(second).resolves.toHaveLength(1)
    expect(changes).toHaveBeenCalledTimes(1)

    await registry.refresh(false)
    expect(clientMocks.discover).toHaveBeenCalledTimes(1)

    clientMocks.discover.mockResolvedValueOnce(discovery())
    await registry.forceRefresh(false)
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('retains cached models on discovery failure and reports interactive errors', async () => {
    const registry = createRegistry('secret')
    clientMocks.discover.mockResolvedValueOnce(discovery())
    await registry.forceRefresh(false)
    clientMocks.discover.mockRejectedValueOnce(new Error('offline'))

    await expect(registry.forceRefresh(true)).resolves.toHaveLength(1)
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      'CLIProxyAPI model discovery failed: offline',
    )
    expect(vscodeMock.output.appendLine).toHaveBeenCalledWith('Model discovery failed: offline')
  })

  it('handles rejected credentials without a generic error prompt', async () => {
    const rejected = vi.fn()
    const registry = createRegistry('secret', { onCredentialsRejected: rejected })
    clientMocks.discover.mockRejectedValueOnce(new ProxyHttpError('bad key', 403))

    await expect(registry.forceRefresh(true)).resolves.toEqual([])
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(window.showErrorMessage).not.toHaveBeenCalled()
  })
})

function createRegistry(
  apiKey?: string,
  hooks: Partial<ConstructorParameters<typeof ModelRegistry>[3]> = {},
): ModelRegistry {
  return new ModelRegistry(
    {
      ensureReady: vi.fn(async () => {}),
      baseUrl: () => 'http://proxy',
    },
    { get: vi.fn(async () => apiKey) } as never,
    vscodeMock.output as never,
    {
      acquireApiKey: vi.fn(async () => apiKey),
      onCredentialsRejected: vi.fn(),
      onCredentialsAccepted: vi.fn(),
      ...hooks,
    },
  )
}

function discovery() {
  return {
    available: [{ id: 'model-a', owned_by: 'test', context_length: 128_000, max_completion_tokens: 20 }],
    metadata: [],
  }
}
