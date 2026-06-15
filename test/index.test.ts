import type { ExtensionContext } from 'vscode'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommitMessageService } from '../src/commit-message'
import { activate, deactivate } from '../src/index'
import { UniversalChatProvider } from '../src/provider'
import {
  commands,
  resetVSCodeMock,
  vscodeMock,
  window,
} from './support/vscode'

beforeEach(() => {
  resetVSCodeMock()
  deactivate()
})

describe('extension activation', () => {
  it('registers the provider, commands, and startup initialization', async () => {
    const initialize = vi.spyOn(UniversalChatProvider.prototype, 'initialize').mockResolvedValue()
    const configure = vi.spyOn(UniversalChatProvider.prototype, 'configure').mockResolvedValue()
    const importConfig = vi.spyOn(UniversalChatProvider.prototype, 'importConfig').mockResolvedValue()
    const forceRefresh = vi.spyOn(UniversalChatProvider.prototype, 'forceRefresh').mockResolvedValue([])
    const generateCommitMessage = vi.spyOn(CommitMessageService.prototype, 'generate').mockResolvedValue()
    const selectCommitMessageModel = vi.spyOn(CommitMessageService.prototype, 'selectModel').mockResolvedValue(undefined)
    const context = extensionContext()

    expect(activate(context)).toBeUndefined()
    expect(vscodeMock.registeredProviders[0]).toMatchObject({ vendor: 'universal-chat-provider' })
    expect(vscodeMock.commandHandlers.size).toBe(13)
    expect(context.subscriptions).toHaveLength(18)
    expect(initialize).toHaveBeenCalledTimes(1)

    await commands.executeCommand('universalChatProvider.configure')
    await commands.executeCommand('universalChatProvider.importConfig')
    await commands.executeCommand('universalChatProvider.refresh')
    await commands.executeCommand('universalChatProvider.generateCommitMessage')
    await commands.executeCommand('universalChatProvider.selectCommitMessageModel')
    expect(configure).toHaveBeenCalled()
    expect(importConfig).toHaveBeenCalled()
    expect(forceRefresh).toHaveBeenCalledWith(true)
    expect(generateCommitMessage).toHaveBeenCalled()
    expect(selectCommitMessageModel).toHaveBeenCalled()
    expect(window.showInformationMessage).toHaveBeenCalledWith('CLIProxyAPI exposed 0 chat models.')
  })

  it('dispatches management choices and confirms credential clearing', async () => {
    vi.spyOn(UniversalChatProvider.prototype, 'initialize').mockResolvedValue()
    const clearCredentials = vi.spyOn(UniversalChatProvider.prototype, 'clearCredentials').mockResolvedValue()
    activate(extensionContext())

    window.showQuickPick.mockResolvedValueOnce({ command: 'universalChatProvider.showLogs' })
    await commands.executeCommand('universalChatProvider.manage')
    expect(vscodeMock.output.show).toHaveBeenCalledWith(true)

    window.showWarningMessage.mockResolvedValueOnce(undefined)
    await commands.executeCommand('universalChatProvider.clearCredentials')
    expect(clearCredentials).not.toHaveBeenCalled()

    window.showWarningMessage.mockResolvedValueOnce('Remove')
    await commands.executeCommand('universalChatProvider.clearCredentials')
    expect(clearCredentials).toHaveBeenCalledTimes(1)
  })
})

function extensionContext(): ExtensionContext {
  return {
    subscriptions: [],
    secrets: {
      get: async (key: string) => vscodeMock.secrets.get(key),
      store: async (key: string, value: string) => {
        vscodeMock.secrets.set(key, value)
      },
      delete: async (key: string) => {
        vscodeMock.secrets.delete(key)
      },
      onDidChange: () => ({ dispose() {} }),
    },
  } as unknown as ExtensionContext
}
