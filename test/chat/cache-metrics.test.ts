import type { ExtensionContext, OutputChannel } from 'vscode'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CacheMetricsTracker, formatUsageLine, normalizeUsage } from '../../src/chat/cache-metrics'
import { resetVSCodeMock, statusBarItem, vscodeMock } from '../support/vscode'

beforeEach(() => {
  resetVSCodeMock()
})

describe('normalizeUsage', () => {
  it.each([
    [
      'Anthropic-native usage where input_tokens is the uncached remainder',
      { input_tokens: 300, cache_read_input_tokens: 700, cache_creation_input_tokens: 200, output_tokens: 50 },
      {
        shape: 'anthropic',
        inputTokens: 1200,
        cacheReadTokens: 700,
        cacheWriteTokens: 200,
        uncachedInputTokens: 300,
        outputTokens: 50,
        hitRate: 700 / 1200,
      },
    ],
    [
      'OpenAI Responses usage where input_tokens is the total',
      { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 40 },
      {
        shape: 'openai',
        inputTokens: 1000,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        uncachedInputTokens: 200,
        outputTokens: 40,
        hitRate: 0.8,
      },
    ],
    [
      'Chat Completions field names',
      { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens: 20 },
      {
        shape: 'openai',
        inputTokens: 500,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        uncachedInputTokens: 400,
        outputTokens: 20,
        hitRate: 0.2,
      },
    ],
    [
      'unknown shape with no cache fields',
      { output_tokens: 3 },
      {
        shape: 'unknown',
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 3,
        hitRate: undefined,
      },
    ],
  ] as const)('reads %s', (_name, usage, expected) => {
    expect(normalizeUsage(usage)).toEqual(expected)
  })

  it('tolerates a missing or non-object usage value', () => {
    expect(normalizeUsage(undefined).shape).toBe('unknown')
    expect(normalizeUsage(undefined).outputTokens).toBe(0)
    expect(normalizeUsage('nonsense').inputTokens).toBe(0)
  })
})

describe('formatUsageLine', () => {
  it('tags a recognized shape and rounds the hit rate', () => {
    const summary = normalizeUsage({
      input_tokens: 300,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 200,
      output_tokens: 50,
    })
    expect(formatUsageLine('claude', summary)).toBe(
      '[usage] claude: input=1200 cached=700 write=200 output=50 hit=58% (anthropic)',
    )
  })

  it('appends the raw object for an unrecognized shape so fields can be inspected', () => {
    const raw = { output_tokens: 3 }
    expect(formatUsageLine('model-a', normalizeUsage(raw), undefined, raw)).toBe(
      '[usage] model-a: input=0 cached=0 write=0 output=3 hit=n/a raw={"output_tokens":3}',
    )
  })

  it('marks an unknown shape without raw fields and includes the label', () => {
    expect(formatUsageLine('model-a', normalizeUsage(undefined), 'commit message')).toBe(
      '[usage] model-a (commit message): input=0 cached=0 write=0 output=0 hit=n/a (unknown)',
    )
  })

  it('includes the reasoning effort sent to the proxy', () => {
    expect(formatUsageLine('model-a', normalizeUsage(undefined), undefined, undefined, 'xhigh')).toBe(
      '[usage] model-a: effort=xhigh input=0 cached=0 write=0 output=0 hit=n/a (unknown)',
    )
  })
})

describe('cacheMetricsTracker', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ucp-cache-metrics-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  function tracker(): CacheMetricsTracker {
    const context = { globalStorageUri: { fsPath: directory } } as unknown as ExtensionContext
    return new CacheMetricsTracker(context, vscodeMock.output as unknown as OutputChannel)
  }

  it('logs the summary but writes nothing and hides the status bar while disabled', async () => {
    const metrics = tracker()
    metrics.record({ output_tokens: 3 }, { model: 'model-a' })
    await metrics.flush()

    expect(vscodeMock.output.appendLine).toHaveBeenCalledWith(
      '[usage] model-a: input=0 cached=0 write=0 output=3 hit=n/a raw={"output_tokens":3}',
    )
    expect(statusBarItem.show).not.toHaveBeenCalled()
    expect(statusBarItem.hide).toHaveBeenCalled()
    await expect(readFile(join(directory, 'debug.jsonl'), 'utf8')).rejects.toThrow()
  })

  it('records a JSONL line and a status-bar hit rate when enabled', async () => {
    vscodeMock.settings.set('universalChatProvider.debug', true)
    const metrics = tracker()
    metrics.record(
      { input_tokens: 300, cache_read_input_tokens: 700, cache_creation_input_tokens: 0, output_tokens: 50 },
      { model: 'claude-opus', promptCacheKey: 'session-1', requestInitiator: 'chat' },
    )
    await metrics.flush()

    expect(statusBarItem.show).toHaveBeenCalled()
    expect(statusBarItem.text).toBe('$(database) 70% cached')

    const lines = (await readFile(join(directory, 'debug.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      model: 'claude-opus',
      promptCacheKey: 'session-1',
      requestInitiator: 'chat',
      shape: 'anthropic',
      inputTokens: 1000,
      cacheReadTokens: 700,
      hitRate: 0.7,
    })
  })

  it('fingerprints the request prefix so a stable lead and a divergent tail are distinguishable', async () => {
    vscodeMock.settings.set('universalChatProvider.debug', true)
    const metrics = tracker()
    const system = { role: 'system', content: 'you are a helper' }
    metrics.record({ input_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } }, {
      model: 'm',
      inputItems: [system, { role: 'user', content: 'first' }],
    })
    metrics.record({ input_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } }, {
      model: 'm',
      inputItems: [system, { role: 'user', content: 'second' }],
    })
    await metrics.flush()

    const lines = (await readFile(join(directory, 'debug.jsonl'), 'utf8')).trim().split('\n')
    interface Entry {
      inputPrefix: string[]
      crossTurn: { stablePrefixLen: number, diverged: { index: number, before: string, after: string }[] } | null
    }
    const first = JSON.parse(lines[0]!) as Entry
    const second = JSON.parse(lines[1]!) as Entry
    expect(first.inputPrefix[0]).toBe(second.inputPrefix[0]) // identical system message → identical fingerprint (cacheable prefix)
    expect(first.inputPrefix[1]).not.toBe(second.inputPrefix[1]) // different user turn → divergent fingerprint

    // second turn carries the cross-turn diff: prefix stable through the system message, broke at the user turn
    expect(second.crossTurn!.stablePrefixLen).toBe(1)
    expect(second.crossTurn!.diverged[0]!.index).toBe(1)
    expect(second.crossTurn!.diverged[0]!.before).toContain('first')
    expect(second.crossTurn!.diverged[0]!.after).toContain('second')
    expect(first.crossTurn).toBeNull() // first turn has no predecessor
  })
})
