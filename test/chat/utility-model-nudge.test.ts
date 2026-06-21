import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setUtilityModel, shouldNudge } from '../../src/chat/utility-model-nudge'
import { resetVSCodeMock, vscodeMock, window } from '../support/vscode'

beforeEach(() => {
  resetVSCodeMock()
})

describe('shouldNudge', () => {
  // Copilot installed, override not yet pointed at our provider, not shown.
  const base = { alreadyShown: false, utilityModel: '', copilotInstalled: true }

  it('nudges a Copilot user who has not routed the override to our provider', () => {
    expect(shouldNudge(base)).toBe(true)
  })

  it('stays quiet once shown', () => {
    expect(shouldNudge({ ...base, alreadyShown: true })).toBe(false)
  })

  it('stays quiet without Copilot — the setting is inert there', () => {
    expect(shouldNudge({ ...base, copilotInstalled: false })).toBe(false)
  })

  it('stays quiet when already routed to our provider (whitespace ignored)', () => {
    expect(shouldNudge({ ...base, utilityModel: 'universal-chat-provider/foo' })).toBe(false)
    expect(shouldNudge({ ...base, utilityModel: '  universal-chat-provider/foo  ' })).toBe(false)
  })

  it('still nudges when the override points at some other vendor', () => {
    expect(shouldNudge({ ...base, utilityModel: 'some-other-vendor/model' })).toBe(true)
  })
})

describe('setUtilityModel', () => {
  it('stores the chosen utility model and reasoning effort', async () => {
    const provider = providerWith(model())
    window.showQuickPick
      .mockImplementationOnce(async items => (items as Array<{ model: ReturnType<typeof model> }>)[0])
      .mockImplementationOnce(async items => (items as Array<{ effort: string }>)[1])

    await setUtilityModel(provider as never)

    expect(vscodeMock.settings.get('chat.utilityModel')).toBe('universal-chat-provider/model-a')
    expect(vscodeMock.settings.get('chat.utilitySmallModel')).toBe('universal-chat-provider/model-a')
    expect(provider.updateUtilityEffort).toHaveBeenCalledWith('model-a', 'high')
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      "Copilot's commit messages, chat titles and summaries now use Model A (High).",
    )
  })

  it('does not change utility settings when effort selection is cancelled', async () => {
    const provider = providerWith(model())
    window.showQuickPick
      .mockImplementationOnce(async items => (items as Array<{ model: ReturnType<typeof model> }>)[0])
      .mockResolvedValueOnce(undefined)

    await setUtilityModel(provider as never)

    expect(vscodeMock.settings.get('chat.utilityModel')).toBeUndefined()
    expect(provider.updateUtilityEffort).not.toHaveBeenCalled()
  })
})

function model() {
  return {
    id: 'model-a',
    name: 'Model A',
    detail: '128K context',
    reasoningLevels: ['low', 'high'],
  }
}

function providerWith(...models: ReturnType<typeof model>[]) {
  return {
    getModels: vi.fn(async () => models),
    getUtilityEffort: vi.fn(() => undefined),
    updateUtilityEffort: vi.fn(async () => {}),
  }
}
