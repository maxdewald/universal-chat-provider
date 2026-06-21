import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setUtilityModel, shouldNudge } from '../../src/chat/utility-model-nudge'
import { resetVSCodeMock, vscodeMock, window } from '../support/vscode'

beforeEach(() => {
  resetVSCodeMock()
})

describe('shouldNudge', () => {
  const base = { alreadyShown: false, utilityModel: '', copilotInstalled: true }

  it.each([
    ['missing override', {}, true],
    ['already shown', { alreadyShown: true }, false],
    ['Copilot missing', { copilotInstalled: false }, false],
    ['provider already selected', { utilityModel: 'universal-chat-provider/foo' }, false],
    ['provider already selected with whitespace', { utilityModel: '  universal-chat-provider/foo  ' }, false],
    ['other provider selected', { utilityModel: 'some-other-vendor/model' }, true],
  ])('%s', (_name, overrides, expected) => {
    expect(shouldNudge({ ...base, ...overrides })).toBe(expected)
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
      'Copilot\'s commit messages, chat titles and summaries now use Model A (High).',
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
