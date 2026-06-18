import { isPlainObject } from 'moderndash'

const MODEL_CATALOG_URL = 'https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json'
let catalogCache: Map<string, CatalogModel> | undefined

export interface CatalogThinking {
  max?: number
  zero_allowed?: boolean
  dynamic_allowed?: boolean
  levels?: string[]
}

export interface CatalogModel {
  id: string
  type?: string
  display_name?: string
  description?: string
  version?: string
  context_length?: number
  max_completion_tokens?: number
  inputTokenLimit?: number
  outputTokenLimit?: number
  supported_parameters?: string[]
  supportedInputModalities?: string[]
  supportedOutputModalities?: string[]
  thinking?: CatalogThinking
}

/**
 * Fetch the shared CLIProxyAPI model catalog (hosted on GitHub, not the proxy
 * server). Cached for the session; failures degrade to an empty map so model
 * discovery still works from the proxy's own metadata.
 */
export async function fetchCatalog(signal?: AbortSignal): Promise<Map<string, CatalogModel>> {
  if (catalogCache)
    return catalogCache
  try {
    const response = await fetch(MODEL_CATALOG_URL, signal ? { signal } : {})
    if (!response.ok)
      return new Map()
    catalogCache = flattenCatalog(await response.json())
    return catalogCache
  }
  catch {
    return new Map()
  }
}

/** Collapse the catalog's per-provider arrays into one best-entry-per-id map. */
export function flattenCatalog(payload: unknown): Map<string, CatalogModel> {
  const result = new Map<string, CatalogModel>()
  if (!isPlainObject(payload))
    return result

  for (const value of Object.values(payload)) {
    if (!Array.isArray(value))
      continue
    for (const candidate of value) {
      if (!isPlainObject(candidate) || typeof candidate.id !== 'string')
        continue
      const current = result.get(candidate.id)
      const model = candidate as unknown as CatalogModel
      if (!current || scoreCatalogModel(model) > scoreCatalogModel(current))
        result.set(model.id, model)
    }
  }
  return result
}

function scoreCatalogModel(model: CatalogModel): number {
  return Number((model.context_length ?? model.inputTokenLimit ?? 0) > 0)
    + Number((model.max_completion_tokens ?? model.outputTokenLimit ?? 0) > 0)
    + Number(model.thinking !== undefined)
}
