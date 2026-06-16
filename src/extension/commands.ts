import type { Disposable, OutputChannel } from 'vscode'
import type { UniversalChatProvider } from '../chat/provider'
import type { ServerController } from '../cliproxy/controller'
import { commands, window } from 'vscode'
import { setUtilityModel } from '../chat/utility-model-nudge'
import { extensionId } from '../generated/meta'
import { manageProvider } from './manage-menu'

export interface CommandDeps {
  provider: UniversalChatProvider
  controller: ServerController
  output: OutputChannel
  serverOutput: OutputChannel
}

export function registerCommands(deps: CommandDeps): Disposable[] {
  const { provider, controller, output, serverOutput } = deps
  return [
    commands.registerCommand('universalChatProvider.manage', async () => manageProvider(controller)),
    commands.registerCommand('universalChatProvider.login', async () => {
      await controller.login()
    }),
    commands.registerCommand('universalChatProvider.manageAccounts', async () => {
      await controller.manageAccounts()
    }),
    commands.registerCommand('universalChatProvider.configure', async () => {
      await provider.configure()
    }),
    commands.registerCommand('universalChatProvider.importConfig', async () => {
      await provider.importConfig()
    }),
    commands.registerCommand('universalChatProvider.refresh', async () => {
      const models = await provider.forceRefresh(true)
      void window.showInformationMessage(`CLIProxyAPI exposed ${models.length} chat models.`)
    }),
    commands.registerCommand('universalChatProvider.restartServer', async () => {
      await controller.restartServer()
    }),
    commands.registerCommand('universalChatProvider.updateBinary', async () => {
      await controller.updateBinary()
    }),
    commands.registerCommand('universalChatProvider.resetServer', async () => {
      await controller.resetServer()
    }),
    commands.registerCommand('universalChatProvider.setUtilityModel', async () => {
      await setUtilityModel(provider)
    }),
    commands.registerCommand('universalChatProvider.clearCredentials', async () => {
      const choice = await window.showWarningMessage(
        'Remove the stored CLIProxyAPI API key from VS Code SecretStorage?',
        { modal: true },
        'Remove',
      )
      if (choice === 'Remove')
        await provider.clearCredentials()
    }),
    commands.registerCommand('universalChatProvider.showLogs', () => output.show(true)),
    commands.registerCommand('universalChatProvider.showServerLogs', () => serverOutput.show(true)),
    // `@ext:<id>` scopes the Settings editor to just this extension's settings.
    commands.registerCommand('universalChatProvider.openSettings', async () => {
      await commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`)
    }),
  ]
}
