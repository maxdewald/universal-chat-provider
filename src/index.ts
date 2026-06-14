import type { ExtensionContext, QuickPickItem } from 'vscode'
import {
  commands,
  lm,
  window,
} from 'vscode'
import { CommitMessageService } from './commit-message'
import { CLIProxyLanguageModelProvider } from './provider'

let provider: CLIProxyLanguageModelProvider | undefined

export function activate(context: ExtensionContext): void {
  const output = window.createOutputChannel('CLIProxyAPI Model Provider', { log: true })
  provider = new CLIProxyLanguageModelProvider(context, output)
  const commitMessages = new CommitMessageService(provider)

  context.subscriptions.push(
    output,
    provider,
    lm.registerLanguageModelChatProvider('cliproxyapi', provider),
    commands.registerCommand('modelProvider.manage', async () => manageProvider()),
    commands.registerCommand('modelProvider.configure', async () => {
      await provider?.configure()
    }),
    commands.registerCommand('modelProvider.importConfig', async () => {
      await provider?.importConfig()
    }),
    commands.registerCommand('modelProvider.refresh', async () => {
      const models = await provider?.forceRefresh(true) ?? []
      void window.showInformationMessage(`CLIProxyAPI exposed ${models.length} chat models.`)
    }),
    commands.registerCommand('modelProvider.generateCommitMessage', async (...args: Parameters<CommitMessageService['generate']>) => {
      await commitMessages.generate(...args)
    }),
    commands.registerCommand('modelProvider.selectCommitMessageModel', async () => {
      await commitMessages.selectModel()
    }),
    commands.registerCommand('modelProvider.clearCredentials', async () => {
      const choice = await window.showWarningMessage(
        'Remove the stored CLIProxyAPI API key from VS Code SecretStorage?',
        { modal: true },
        'Remove',
      )
      if (choice === 'Remove')
        await provider?.clearCredentials()
    }),
    commands.registerCommand('modelProvider.showLogs', () => output.show(true)),
  )

  void provider.initialize()
}

export function deactivate(): void {
  provider = undefined
}

async function manageProvider(): Promise<void> {
  const choices: Array<QuickPickItem & { command: string }> = [
    {
      label: '$(refresh) Refresh Models',
      description: 'Re-read models and capabilities from CLIProxyAPI',
      command: 'modelProvider.refresh',
    },
    {
      label: '$(settings-gear) Configure Connection',
      description: 'Set the proxy URL and optional config path',
      command: 'modelProvider.configure',
    },
    {
      label: '$(key) Import API Key from Config',
      description: 'Store a key from CLIProxyAPI config.yaml and refresh models',
      command: 'modelProvider.importConfig',
    },
    {
      label: '$(sparkle) Select Commit Message Model',
      description: 'Choose the CLIProxyAPI model used only for commit messages',
      command: 'modelProvider.selectCommitMessageModel',
    },
    {
      label: '$(output) Show Logs',
      description: 'Open the provider output channel',
      command: 'modelProvider.showLogs',
    },
    {
      label: '$(trash) Clear Stored API Key',
      description: 'Remove the key from VS Code SecretStorage',
      command: 'modelProvider.clearCredentials',
    },
  ]
  const selected = await window.showQuickPick(choices, {
    title: 'Manage CLIProxyAPI Model Provider',
    placeHolder: 'Choose an action',
  })
  if (selected)
    await commands.executeCommand(selected.command)
}
