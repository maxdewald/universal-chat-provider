import type { ExtensionContext } from 'vscode'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activate, deactivate } from '../src/index'
import { CLIProxyLanguageModelProvider } from '../src/provider'
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
    const initialize = vi.spyOn(CLIProxyLanguageModelProvider.prototype, 'initialize').mockResolvedValue()
    const configure = vi.spyOn(CLIProxyLanguageModelProvider.prototype, 'configure').mockResolvedValue()
    const importConfig = vi.spyOn(CLIProxyLanguageModelProvider.prototype, 'importConfig').mockResolvedValue()
    const forceRefresh = vi.spyOn(CLIProxyLanguageModelProvider.prototype, 'forceRefresh').mockResolvedValue([])
    const context = extensionContext()

    expect(activate(context)).toBeUndefined()
    expect(vscodeMock.registeredProviders[0]).toMatchObject({ vendor: 'cliproxyapi' })
    expect(vscodeMock.commandHandlers.size).toBe(6)
    expect(context.subscriptions).toHaveLength(9)
    expect(initialize).toHaveBeenCalledTimes(1)

    await commands.executeCommand('modelProvider.configure')
    await commands.executeCommand('modelProvider.importConfig')
    await commands.executeCommand('modelProvider.refresh')
    expect(configure).toHaveBeenCalled()
    expect(importConfig).toHaveBeenCalled()
    expect(forceRefresh).toHaveBeenCalledWith(true)
    expect(window.showInformationMessage).toHaveBeenCalledWith('CLIProxyAPI exposed 0 chat models.')
  })

  it('dispatches management choices and confirms credential clearing', async () => {
    vi.spyOn(CLIProxyLanguageModelProvider.prototype, 'initialize').mockResolvedValue()
    const clearCredentials = vi.spyOn(CLIProxyLanguageModelProvider.prototype, 'clearCredentials').mockResolvedValue()
    activate(extensionContext())

    window.showQuickPick.mockResolvedValueOnce({ command: 'modelProvider.showLogs' })
    await commands.executeCommand('modelProvider.manage')
    expect(vscodeMock.output.show).toHaveBeenCalledWith(true)

    window.showWarningMessage.mockResolvedValueOnce(undefined)
    await commands.executeCommand('modelProvider.clearCredentials')
    expect(clearCredentials).not.toHaveBeenCalled()

    window.showWarningMessage.mockResolvedValueOnce('Remove')
    await commands.executeCommand('modelProvider.clearCredentials')
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
