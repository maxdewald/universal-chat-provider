import type { ManagementClient } from '../../src/cliproxy/management-client'
import type { QuotaReport } from '../../src/cliproxy/quota'
import { describe, expect, it, vi } from 'vitest'
import { fetchQuotas, formatPercent, remainingForModel } from '../../src/cliproxy/quota'

interface ApiCallResult { statusCode: number, body: unknown }

function fakeClient(
  files: Record<string, unknown>[],
  respond: (url: string, payload: Record<string, unknown>) => ApiCallResult,
): { client: ManagementClient, apiCall: ReturnType<typeof vi.fn> } {
  const apiCall = vi.fn(async (payload: Record<string, unknown>) => respond(String(payload.url), payload))
  const client = { listAuthFilesRaw: async () => files, apiCall } as unknown as ManagementClient
  return { client, apiCall }
}

const CODEX_BODY = JSON.stringify({
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 1, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 49, limit_window_seconds: 604_800 },
  },
})

const ANTIGRAVITY_BODY = JSON.stringify({
  models: {
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.1 } },
    'gemini-pro-agent': { displayName: 'Gemini 3.1 Pro (High)', quotaInfo: { remainingFraction: 1 } },
    'chat_001': { quotaInfo: null },
  },
})

const CLAUDE_BODY = JSON.stringify({
  five_hour: { utilization: 20, resets_at: '2026-06-25T12:00:00Z' },
  seven_day: { utilization: 5, resets_at: '2026-07-01T00:00:00Z' },
  seven_day_sonnet: { utilization: 60, resets_at: '2026-07-01T00:00:00Z' },
  seven_day_opus: { utilization: 90, resets_at: '2026-07-01T00:00:00Z' },
  extra_usage: { is_enabled: true, utilization: 25, used_credits: 5, monthly_limit: 20 },
})

function respondOk(url: string): ApiCallResult {
  if (url.includes('wham/usage'))
    return { statusCode: 200, body: CODEX_BODY }
  if (url.includes('fetchAvailableModels'))
    return { statusCode: 200, body: ANTIGRAVITY_BODY }
  if (url.includes('oauth/usage'))
    return { statusCode: 200, body: CLAUDE_BODY }
  return { statusCode: 404, body: '' }
}

describe('fetchQuotas', () => {
  it('parses codex 5h/7d windows from a string body', async () => {
    const { client } = fakeClient([{ name: 'codex.json', provider: 'codex', auth_index: 'c1' }], respondOk)

    const report = (await fetchQuotas(client))[0]!

    expect(report.provider).toBe('codex')
    expect(report.windows).toEqual([
      { label: '5h Quota', remainingPercent: 99 },
      { label: '7d Quota', remainingPercent: 51 },
    ])
  })

  it('maps antigravity quota by model id, skipping entries without a fraction', async () => {
    const { client } = fakeClient([{ name: 'anti.json', provider: 'antigravity', auth_index: 'a1', project_id: 'p1' }], respondOk)

    const report = (await fetchQuotas(client))[0]!

    expect(report.models).toEqual({
      'claude-sonnet-4-6': 10,
      'gemini-pro-agent': 100,
    })
  })

  it('parses claude account windows and enabled extra usage', async () => {
    const { client } = fakeClient([{ name: 'claude.json', type: 'claude', auth_index: 'x1' }], respondOk)

    const report = (await fetchQuotas(client))[0]!

    expect(report.provider).toBe('claude')
    expect(report.windows).toEqual([
      { key: 'five_hour', label: '5h Quota', remainingPercent: 80 },
      { key: 'seven_day', label: '7d Quota', remainingPercent: 95 },
      { key: 'seven_day_sonnet', label: '7d Sonnet', remainingPercent: 40 },
      { key: 'seven_day_opus', label: '7d Opus', remainingPercent: 10 },
      { key: 'extra_usage', label: 'Extra Usage', remainingPercent: 75 },
    ])
  })

  it('skips providers without a known quota endpoint', async () => {
    const { client, apiCall } = fakeClient([{ name: 'kimi.json', type: 'kimi', auth_index: 'x1' }], respondOk)

    await expect(fetchQuotas(client)).resolves.toEqual([])
    expect(apiCall).not.toHaveBeenCalled()
  })

  it('reports an HTTP error instead of throwing', async () => {
    const { client } = fakeClient(
      [{ name: 'codex.json', provider: 'codex', auth_index: 'c1' }],
      () => ({ statusCode: 401, body: 'unauthorized' }),
    )

    const report = (await fetchQuotas(client))[0]!
    expect(report).toMatchObject({ provider: 'codex', error: 'HTTP 401', windows: [] })
  })

  it('reports missing project_id without calling the upstream', async () => {
    const { client, apiCall } = fakeClient([{ name: 'anti.json', provider: 'antigravity', auth_index: 'a1' }], respondOk)

    const report = (await fetchQuotas(client))[0]!
    expect(report).toMatchObject({ error: 'missing project_id' })
    expect(apiCall).not.toHaveBeenCalled()
  })
})

describe('remainingForModel', () => {
  const reports: QuotaReport[] = [
    { provider: 'codex', windows: [{ label: '5h Quota', remainingPercent: 80 }, { label: '7d Quota', remainingPercent: 8 }] },
    { provider: 'antigravity', windows: [], models: { 'gemini-pro-agent': 35 } },
    { provider: 'claude', windows: [
      { key: 'five_hour', label: '5h Quota', remainingPercent: 80 },
      { key: 'seven_day', label: '7d Quota', remainingPercent: 50 },
      { key: 'seven_day_sonnet', label: '7d Sonnet', remainingPercent: 40 },
      { key: 'seven_day_opus', label: '7d Opus', remainingPercent: 10 },
      { key: 'extra_usage', label: 'Extra Usage', remainingPercent: 5 },
    ] },
  ]

  it('returns the antigravity per-model percent', () => {
    expect(remainingForModel(reports, { proxyOwner: 'antigravity', proxyModelId: 'gemini-pro-agent' })).toBe(35)
  })

  it('returns the tightest codex window for any openai model', () => {
    expect(remainingForModel(reports, { proxyOwner: 'openai', proxyModelId: 'gpt-5-codex' })).toBe(8)
  })

  it('binds an unknown weekly family by name without code changes', () => {
    const withFable: QuotaReport[] = [{ provider: 'claude', windows: [
      { key: 'seven_day', label: '7d Quota', remainingPercent: 70 },
      { key: 'seven_day_fable', label: '7d Fable', remainingPercent: 15 },
    ] }]
    expect(remainingForModel(withFable, { proxyOwner: 'anthropic', proxyModelId: 'claude-fable-5' })).toBe(15)
    expect(remainingForModel(withFable, { proxyOwner: 'anthropic', proxyModelId: 'claude-opus-4-6' })).toBe(70)
  })

  it('scopes claude weekly caps to the model family, ignoring extra usage', () => {
    // Opus sees its own 10% weekly cap; Sonnet sees 40%; both gated by the shared 5h/7d windows.
    expect(remainingForModel(reports, { proxyOwner: 'anthropic', proxyModelId: 'claude-opus-4-6' })).toBe(10)
    expect(remainingForModel(reports, { proxyOwner: 'anthropic', proxyModelId: 'claude-sonnet-4-6' })).toBe(40)
    // Haiku has no family cap, so the shared 7d window (50%) is the tightest.
    expect(remainingForModel(reports, { proxyOwner: 'anthropic', proxyModelId: 'claude-haiku-4-5' })).toBe(50)
  })

  it('is undefined for an untracked antigravity model, owner, or errored report', () => {
    expect(remainingForModel(reports, { proxyOwner: 'antigravity', proxyModelId: 'unknown' })).toBeUndefined()
    expect(remainingForModel(reports, { proxyOwner: 'kimi', proxyModelId: 'k2' })).toBeUndefined()
    const errored: QuotaReport[] = [{ provider: 'codex', windows: [], error: 'HTTP 401' }]
    expect(remainingForModel(errored, { proxyOwner: 'openai', proxyModelId: 'gpt-5-codex' })).toBeUndefined()
  })
})

describe('formatPercent', () => {
  it('rounds percentages and marks missing values', () => {
    expect(formatPercent(42.6)).toBe('43%')
    expect(formatPercent(undefined)).toBe('?')
  })
})
