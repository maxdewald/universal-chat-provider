import type { ExtensionContext, QuickPickItem, StatusBarItem } from 'vscode'
import type { ServerStatus } from './managed/controller'
import {
  commands,
  lm,
  StatusBarAlignment,
  window,
} from 'vscode'
import { CommitMessageService } from './commit-message'
import { ServerController } from './managed/controller'
import { UniversalChatProvider } from './provider'

let provider: UniversalChatProvider | undefined
let controller: ServerController | undefined

export function activate(context: ExtensionContext): void {
  const output = window.createOutputChannel('Universal Chat Provider', { log: true })
  controller = new ServerController(context, output)
  provider = new UniversalChatProvider(context, output, controller)
  const commitMessages = new CommitMessageService(provider)

  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right, 100)
  statusBar.command = 'universalChatProvider.manage'
  controller.setRefreshListener(() => void provider?.forceRefresh(false))
  controller.setStatusListener(status => updateStatusBar(statusBar, status))

  context.subscriptions.push(
    output,
    controller,
    statusBar,
    provider,
    lm.registerLanguageModelChatProvider('universal-chat-provider', provider),
    commands.registerCommand('universalChatProvider.manage', async () => manageProvider()),
    commands.registerCommand('universalChatProvider.login', async () => {
      await controller?.login()
    }),
    commands.registerCommand('universalChatProvider.manageAccounts', async () => {
      await controller?.manageAccounts()
    }),
    commands.registerCommand('universalChatProvider.configure', async () => {
      await provider?.configure()
    }),
    commands.registerCommand('universalChatProvider.importConfig', async () => {
      await provider?.importConfig()
    }),
    commands.registerCommand('universalChatProvider.refresh', async () => {
      const models = await provider?.forceRefresh(true) ?? []
      void window.showInformationMessage(`CLIProxyAPI exposed ${models.length} chat models.`)
    }),
    commands.registerCommand('universalChatProvider.restartServer', async () => {
      await controller?.restartServer()
    }),
    commands.registerCommand('universalChatProvider.updateBinary', async () => {
      await controller?.updateBinary()
    }),
    commands.registerCommand('universalChatProvider.resetServer', async () => {
      await controller?.resetServer()
    }),
    commands.registerCommand('universalChatProvider.generateCommitMessage', async (...args: Parameters<CommitMessageService['generate']>) => {
      await commitMessages.generate(...args)
    }),
    commands.registerCommand('universalChatProvider.selectCommitMessageModel', async () => {
      await commitMessages.selectModel()
    }),
    commands.registerCommand('universalChatProvider.clearCredentials', async () => {
      const choice = await window.showWarningMessage(
        'Remove the stored CLIProxyAPI API key from VS Code SecretStorage?',
        { modal: true },
        'Remove',
      )
      if (choice === 'Remove')
        await provider?.clearCredentials()
    }),
    commands.registerCommand('universalChatProvider.showLogs', () => output.show(true)),
  )

  statusBar.show()
  void provider.initialize()
}

export function deactivate(): void {
  provider = undefined
  controller = undefined
}

function updateStatusBar(statusBar: StatusBarItem, status: ServerStatus): void {
  const presentation: Record<ServerStatus, { text: string, tooltip: string }> = {
    external: { text: '$(server) CLIProxyAPI', tooltip: 'CLIProxyAPI: using an external server' },
    starting: { text: '$(sync~spin) CLIProxyAPI', tooltip: 'CLIProxyAPI: starting the managed server…' },
    running: { text: '$(server-process) CLIProxyAPI', tooltip: 'CLIProxyAPI: managed server running' },
    error: { text: '$(error) CLIProxyAPI', tooltip: 'CLIProxyAPI: managed server failed to start' },
  }
  const { text, tooltip } = presentation[status]
  statusBar.text = text
  statusBar.tooltip = tooltip
}

async function manageProvider(): Promise<void> {
  const managed = controller?.mode() !== 'external'
  const choices: Array<QuickPickItem & { command: string }> = [
    {
      label: '$(account) Add Account (Login)',
      description: 'Sign in to Gemini, Codex, Claude, and more',
      command: 'universalChatProvider.login',
    },
    {
      label: '$(organization) Manage Accounts',
      description: 'List or remove connected provider accounts',
      command: 'universalChatProvider.manageAccounts',
    },
    {
      label: '$(refresh) Refresh Models',
      description: 'Re-read models and capabilities from CLIProxyAPI',
      command: 'universalChatProvider.refresh',
    },
    ...(managed
      ? [
          {
            label: '$(debug-restart) Restart Server',
            description: 'Restart the managed CLIProxyAPI server',
            command: 'universalChatProvider.restartServer',
          },
          {
            label: '$(cloud-download) Update Proxy Binary',
            description: 'Download and run the configured CLIProxyAPI version',
            command: 'universalChatProvider.updateBinary',
          },
          {
            label: '$(trash) Reset Managed Server',
            description: 'Recreate the generated config and keys',
            command: 'universalChatProvider.resetServer',
          },
        ]
      : [
          {
            label: '$(settings-gear) Configure Connection',
            description: 'Set the proxy URL and optional config path',
            command: 'universalChatProvider.configure',
          },
          {
            label: '$(key) Import API Key from Config',
            description: 'Store a key from CLIProxyAPI config.yaml and refresh models',
            command: 'universalChatProvider.importConfig',
          },
        ]),
    {
      label: '$(sparkle) Select Commit Message Model',
      description: 'Choose the CLIProxyAPI model used only for commit messages',
      command: 'universalChatProvider.selectCommitMessageModel',
    },
    {
      label: '$(output) Show Logs',
      description: 'Open the provider output channel',
      command: 'universalChatProvider.showLogs',
    },
    {
      label: '$(trash) Clear Stored API Key',
      description: 'Remove the key from VS Code SecretStorage',
      command: 'universalChatProvider.clearCredentials',
    },
  ]
  const selected = await window.showQuickPick(choices, {
    title: 'Manage Universal Chat Provider',
    placeHolder: 'Choose an action',
  })
  if (selected)
    await commands.executeCommand(selected.command)
}
