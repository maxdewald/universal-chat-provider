import type { ExtensionContext, QuickPickItem, StatusBarItem } from 'vscode'
import type { ServerStatus, ServerStatusSnapshot } from './managed/controller'
import {
  commands,
  lm,
  QuickPickItemKind,
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
    external: { text: '$(server) Universal Chat Provider', tooltip: 'Universal Chat Provider: using an external server' },
    starting: { text: '$(sync~spin) Universal Chat Provider', tooltip: 'Universal Chat Provider: starting the managed server…' },
    running: { text: '$(server-process) Universal Chat Provider', tooltip: 'Universal Chat Provider: managed server running' },
    error: { text: '$(error) Universal Chat Provider', tooltip: 'Universal Chat Provider: managed server failed to start' },
  }
  const { text, tooltip } = presentation[status]
  statusBar.text = text
  statusBar.tooltip = tooltip
}

interface ActionItem extends QuickPickItem { command: string }
interface ActionGroup { title: string, items: ActionItem[] }

async function manageProvider(): Promise<void> {
  const managed = controller?.mode() !== 'external'
  const snapshot = await controller?.statusSnapshot()

  const groups: ActionGroup[] = [
    {
      title: 'Accounts',
      items: [
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
      ],
    },
    {
      title: 'Models',
      items: [
        {
          label: '$(refresh) Refresh Models',
          description: 'Re-read models and capabilities from CLIProxyAPI',
          command: 'universalChatProvider.refresh',
        },
        {
          label: '$(sparkle) Select Commit Message Model',
          description: 'Choose the CLIProxyAPI model used only for commit messages',
          command: 'universalChatProvider.selectCommitMessageModel',
        },
      ],
    },
    managed
      ? {
          title: 'Server',
          items: [
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
          ],
        }
      : {
          title: 'Connection',
          items: [
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
          ],
        },
    {
      title: 'Credentials',
      items: [
        {
          label: '$(trash) Clear Stored API Key',
          description: 'Remove the key from VS Code SecretStorage',
          command: 'universalChatProvider.clearCredentials',
        },
      ],
    },
  ]

  const choices: Array<QuickPickItem & { command?: string }> = [
    ...(snapshot !== undefined ? [statusEntry(snapshot)] : []),
    ...groups.flatMap(group => [
      { label: group.title, kind: QuickPickItemKind.Separator },
      ...group.items,
    ]),
  ]
  const selected = await window.showQuickPick(choices, {
    title: 'Manage Universal Chat Provider',
    placeHolder: 'Choose an action',
  })
  if (selected?.command !== undefined)
    await commands.executeCommand(selected.command)
}

/**
 * The rich status row shown at the top of the manage picker. Selecting it opens
 * the logs — the natural drill-in when the server is starting or unhealthy.
 */
function statusEntry(snapshot: ServerStatusSnapshot): QuickPickItem & { command: string } {
  const presentation: Record<ServerStatus, { icon: string, label: string }> = {
    external: { icon: '$(server)', label: 'External CLI Proxy API server' },
    starting: { icon: '$(sync~spin)', label: 'Managed CLI Proxy API server starting…' },
    running: { icon: '$(server-process)', label: 'Managed CLI Proxy API server running' },
    error: { icon: '$(error)', label: 'Managed CLI Proxy API server failed to start' },
  }
  const { icon, label } = presentation[snapshot.status]
  const accounts = snapshot.accounts === undefined
    ? undefined
    : `${snapshot.accounts} ${snapshot.accounts === 1 ? 'account' : 'accounts'} connected`
  const detail = [
    snapshot.version !== undefined ? `Version ${snapshot.version}` : undefined,
    accounts,
    'Select to view logs',
  ].filter((part): part is string => part !== undefined).join('  ·  ')
  return {
    // Codicons render in the label and description, but not the detail — keep
    // the detail plain so it never shows a literal `$(…)`.
    label: `${icon} ${label}`,
    description: snapshot.baseUrl.replace(/^https?:\/\//, ''),
    detail,
    command: 'universalChatProvider.showLogs',
  }
}
