import type { ExtensionContext } from 'vscode'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UniversalChatProvider } from '../../src/chat/provider'
import { ServerController } from '../../src/cliproxy/controller'
import { activate, deactivate } from '../../src/index'
import {
  commands,
  resetVSCodeMock,
  vscodeMock,
  window,
} from '../support/vscode'

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
    const getModels = vi.spyOn(UniversalChatProvider.prototype, 'getModels').mockResolvedValue([])
    const login = vi.spyOn(ServerController.prototype, 'login').mockResolvedValue()
    const manageAccounts = vi.spyOn(ServerController.prototype, 'manageAccounts').mockResolvedValue()
    const context = extensionContext()

    expect(activate(context)).toBeUndefined()
    expect(vscodeMock.registeredProviders[0]).toMatchObject({ vendor: 'universal-chat-provider' })
    expect(vscodeMock.commandHandlers.has('universalChatProvider.configure')).toBe(true)
    expect(vscodeMock.commandHandlers.has('universalChatProvider.login')).toBe(true)
    expect(vscodeMock.commandHandlers.has('universalChatProvider.openSettings')).toBe(true)
    expect(initialize).toHaveBeenCalledTimes(1)

    await commands.executeCommand('universalChatProvider.login')
    await commands.executeCommand('universalChatProvider.manageAccounts')
    await commands.executeCommand('universalChatProvider.configure')
    await commands.executeCommand('universalChatProvider.importConfig')
    await commands.executeCommand('universalChatProvider.refresh')
    await commands.executeCommand('universalChatProvider.setUtilityModel')
    await commands.executeCommand('universalChatProvider.openSettings')
    expect(login).toHaveBeenCalled()
    expect(manageAccounts).toHaveBeenCalled()
    expect(configure).toHaveBeenCalled()
    expect(importConfig).toHaveBeenCalled()
    expect(forceRefresh).toHaveBeenCalledWith(true)
    expect(getModels).toHaveBeenCalled()
    expect(window.showInformationMessage).toHaveBeenCalledWith('CLIProxyAPI exposed 0 chat models.')
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.openSettings',
      '@ext:maxdewald.universal-chat-provider',
    )
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
  const globalState = new Map<string, unknown>()
  return {
    subscriptions: [],
    globalStorageUri: { fsPath: '/tmp/ucp-index-test' },
    globalState: {
      get: <T>(key: string, fallback?: T): T => (globalState.get(key) ?? fallback) as T,
      update: async (key: string, value: unknown) => {
        globalState.set(key, value)
      },
    },
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
