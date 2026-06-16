import type { QuickPickItem } from 'vscode'
import type { ServerController, ServerStatus, ServerStatusSnapshot } from '../cliproxy/controller'
import { commands, QuickPickItemKind, window } from 'vscode'

interface ActionItem extends QuickPickItem { command: string }
type Choice = QuickPickItem & { command?: string }

function divider(): Choice {
  return { label: '', kind: QuickPickItemKind.Separator }
}

export async function manageProvider(controller: ServerController | undefined): Promise<void> {
  const managed = controller?.mode() !== 'external'
  const snapshot = await controller?.statusSnapshot()

  // Logical groups, separated only by plain dividers — the descriptions carry
  // the meaning, so no floating section labels are needed.
  const groups: ActionItem[][] = [
    [
      {
        label: '$(account) Add Account (Login)',
        description: 'Gemini, Codex, Claude, and more',
        command: 'universalChatProvider.login',
      },
      {
        label: '$(organization) Manage Accounts',
        description: 'List or remove connected accounts',
        command: 'universalChatProvider.manageAccounts',
      },
    ],
    [
      {
        label: '$(refresh) Refresh Models',
        description: 'Reload models and capabilities',
        command: 'universalChatProvider.refresh',
      },
      {
        label: '$(sparkle) Set Utility Model',
        description: 'Run Copilot\'s commit messages, titles & summaries on your models',
        command: 'universalChatProvider.setUtilityModel',
      },
    ],
    managed
      ? [
          {
            label: '$(debug-restart) Restart Server',
            description: 'Restart the managed server',
            command: 'universalChatProvider.restartServer',
          },
          {
            label: '$(cloud-download) Update Proxy Binary',
            description: 'Install the configured version',
            command: 'universalChatProvider.updateBinary',
          },
          {
            label: '$(discard) Reset Managed Server',
            description: 'Recreate the config and keys',
            command: 'universalChatProvider.resetServer',
          },
        ]
      : [
          {
            label: '$(settings-gear) Configure Connection',
            description: 'Set the proxy URL and config path',
            command: 'universalChatProvider.configure',
          },
          {
            label: '$(key) Import API Key from Config',
            description: 'Load an API key from config.yaml',
            command: 'universalChatProvider.importConfig',
          },
        ],
    [
      {
        label: '$(gear) Open Settings',
        description: 'Edit this extension\'s settings',
        command: 'universalChatProvider.openSettings',
      },
      {
        label: '$(output) Show Extension Logs',
        description: 'Diagnostics from the extension itself',
        command: 'universalChatProvider.showLogs',
      },
      {
        label: '$(trash) Clear Stored API Key',
        description: 'Remove the key from SecretStorage',
        command: 'universalChatProvider.clearCredentials',
      },
    ],
  ]

  const body = groups.flatMap((group, index) => (index === 0 ? group : [divider(), ...group]))
  const choices: Choice[] = snapshot !== undefined
    ? [statusEntry(snapshot), divider(), ...body]
    : body
  const selected = await window.showQuickPick(choices, {
    title: 'Manage Universal Chat Provider',
    placeHolder: 'Choose an action',
  })
  if (selected?.command !== undefined)
    await commands.executeCommand(selected.command)
}

function statusEntry(snapshot: ServerStatusSnapshot): QuickPickItem & { command: string } {
  const presentation: Record<ServerStatus, { icon: string, label: string }> = {
    external: { icon: '$(server)', label: 'External CLI Proxy API server' },
    starting: { icon: '$(loading~spin)', label: 'Managed CLI Proxy API server starting…' },
    running: { icon: '$(server-process)', label: 'Managed CLI Proxy API server running' },
    error: { icon: '$(error)', label: 'Managed CLI Proxy API server failed to start' },
  }
  const { icon, label } = presentation[snapshot.status]
  const accounts = snapshot.accounts === undefined
    ? undefined
    : `${snapshot.accounts} ${snapshot.accounts === 1 ? 'account' : 'accounts'} connected`
  // The managed sidecar's output is tailed into its own channel; an external
  // server is not, so there fall back to the extension's own diagnostics.
  const external = snapshot.status === 'external'
  const detail = [
    snapshot.version !== undefined ? `Version ${snapshot.version}` : undefined,
    accounts,
    external ? 'Select to view logs' : 'Select to view server output',
  ].filter((part): part is string => part !== undefined).join('  ·  ')
  return {
    // Codicons render in the label and description, but not the detail — keep
    // the detail plain so it never shows a literal `$(…)`.
    label: `${icon} ${label}`,
    description: snapshot.baseUrl.replace(/^https?:\/\//, ''),
    detail,
    command: external ? 'universalChatProvider.showLogs' : 'universalChatProvider.showServerLogs',
  }
}
