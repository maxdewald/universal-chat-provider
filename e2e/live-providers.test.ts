import type { ProviderModel } from '../src/model'
import { resolve } from 'node:path'
import untildify from 'untildify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
  LanguageModelTextPart,
} from 'vscode'
import { findConfigPath, normalizeBaseUrl } from '../src/credentials'
import { readLocalProxyConfig } from '../src/local-config'
import { mapProxyModels } from '../src/model'
import { CLIProxyClient, ProxyHttpError } from '../src/proxy-client'
import { buildRequest } from '../src/request'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8317'
const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini'
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite'
const REQUEST_TIMEOUT_MS = 60_000
const MAX_OUTPUT_TOKENS = 128

interface LiveTestContext {
  client: CLIProxyClient
  models: ProviderModel[]
}

let context: LiveTestContext
const controllers = new Set<AbortController>()

beforeAll(async () => {
  const baseUrl = normalizeBaseUrl(
    environmentValue('UNIVERSAL_CHAT_PROVIDER_E2E_BASE_URL') ?? DEFAULT_BASE_URL,
  )
  const configuredPath = environmentValue('UNIVERSAL_CHAT_PROVIDER_E2E_CONFIG_PATH')
  const configPath = configuredPath !== undefined
    ? resolve(untildify(configuredPath))
    : await findConfigPath()

  if (configPath === undefined) {
    throw new Error(
      'No CLIProxyAPI config.yaml was found. Set UNIVERSAL_CHAT_PROVIDER_E2E_CONFIG_PATH or use a standard local config path.',
    )
  }

  const config = await readLocalProxyConfig(configPath).catch((error: unknown) => {
    throw new Error(`Could not read CLIProxyAPI config at ${configPath}: ${errorMessage(error)}`)
  })
  if (config.apiKey === undefined) {
    throw new Error(`No usable API key was found in CLIProxyAPI config ${configPath}.`)
  }

  const client = new CLIProxyClient(baseUrl, config.apiKey)
  const healthController = trackedController()
  try {
    if (!await client.health(healthController.signal)) {
      throw new Error(
        `CLIProxyAPI is unavailable at ${baseUrl}. Start the server or set UNIVERSAL_CHAT_PROVIDER_E2E_BASE_URL.`,
      )
    }
  }
  finally {
    releaseController(healthController)
  }

  const discoveryController = trackedController()
  try {
    const discovery = await client.discover(discoveryController.signal)
    context = {
      client,
      models: mapProxyModels(
        discovery.available,
        discovery.metadata,
        discovery.catalog,
        { defaultMaxOutputTokens: MAX_OUTPUT_TOKENS },
      ),
    }
  }
  catch (error) {
    throw new Error(`CLIProxyAPI model discovery failed at ${baseUrl}: ${describeProxyError(error)}`)
  }
  finally {
    releaseController(discoveryController)
  }
})

afterAll(() => {
  for (const controller of controllers)
    controller.abort()
  controllers.clear()
})

describe.sequential('live CLIProxyAPI providers', () => {
  it('streams a sentinel response from the OpenAI subscription', async () => {
    await expectSentinel(
      'OpenAI',
      environmentValue('UNIVERSAL_CHAT_PROVIDER_E2E_OPENAI_MODEL') ?? DEFAULT_OPENAI_MODEL,
      'MODELP_PROVIDER_OPENAI_OK',
    )
  })

  it('streams a sentinel response from the Gemini subscription', async () => {
    await expectSentinel(
      'Gemini',
      environmentValue('UNIVERSAL_CHAT_PROVIDER_E2E_GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL,
      'MODELP_PROVIDER_GEMINI_OK',
    )
  })
})

async function expectSentinel(provider: string, modelId: string, sentinel: string): Promise<void> {
  const discovered = context.models.find(model => model.proxyModelId === modelId)
  if (discovered === undefined) {
    const available = context.models.map(model => model.proxyModelId).sort().join(', ')
    throw new Error(
      `${provider} E2E model "${modelId}" was not discovered. `
      + `Set UNIVERSAL_CHAT_PROVIDER_E2E_${provider.toUpperCase()}_MODEL to an available model. `
      + `Discovered models: ${available || '(none)'}`,
    )
  }

  const model: ProviderModel = {
    ...discovered,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  }
  const request = buildRequest(
    model,
    [{
      role: LanguageModelChatMessageRole.User,
      content: [
        new LanguageModelTextPart(`Reply with exactly ${sentinel} and nothing else.`),
      ],
      name: undefined,
    }],
    {
      requestInitiator: 'universal-chat-provider-e2e',
      toolMode: LanguageModelChatToolMode.Auto,
    },
    'low',
  )
  const controller = trackedController()
  let text = ''

  try {
    await context.client.streamResponse(
      request,
      {
        onText: delta => text += delta,
        onToolCall: () => {},
      },
      controller.signal,
    )
  }
  catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `${provider} model "${modelId}" did not complete within ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
      )
    }
    throw new Error(
      `${provider} model "${modelId}" request failed: ${describeProxyError(error)}`,
    )
  }
  finally {
    releaseController(controller)
  }

  expect(
    text,
    `${provider} model "${modelId}" streamed text but did not return sentinel "${sentinel}".`,
  ).toContain(sentinel)
}

function trackedController(): AbortController {
  const controller = new AbortController()
  controllers.add(controller)
  setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS).unref()
  return controller
}

function releaseController(controller: AbortController): void {
  controllers.delete(controller)
}

function describeProxyError(error: unknown): string {
  if (error instanceof ProxyHttpError)
    return `HTTP ${error.status}: ${error.message}`
  return errorMessage(error)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value !== undefined && value.length > 0 ? value : undefined
}
