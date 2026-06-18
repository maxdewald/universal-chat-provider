import type { ExtensionContext } from 'vscode'
import type { LocalProxyConfig } from './local-config'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { ConfigurationTarget, window, workspace } from 'vscode'
import { errorMessage } from '../shared/errors'
import { readLocalProxyConfig } from './local-config'

export const SECRET_KEY = 'universalChatProvider.apiKey'

export class CredentialStore {
  constructor(private readonly context: ExtensionContext) {}

  get(): Thenable<string | undefined> {
    return this.context.secrets.get(SECRET_KEY)
  }

  set(value: string): Thenable<void> {
    return this.context.secrets.store(SECRET_KEY, value)
  }

  clear(): Thenable<void> {
    return this.context.secrets.delete(SECRET_KEY)
  }

  async inspectLocalConfig(): Promise<LocalProxyConfig | undefined> {
    const configPath = await findConfigPath()
    if (configPath === undefined)
      return undefined
    return readLocalProxyConfig(configPath)
  }

  async importFromConfig(showErrors: boolean): Promise<string | undefined> {
    let config: LocalProxyConfig | undefined
    try {
      config = await this.inspectLocalConfig()
    }
    catch (error) {
      if (showErrors)
        void window.showErrorMessage(`Could not read CLIProxyAPI config: ${errorMessage(error)}`)
      return undefined
    }

    if (config === undefined) {
      if (showErrors)
        void window.showWarningMessage('No CLIProxyAPI config.yaml was found. Configure its path in settings.')
      return undefined
    }
    if (config.apiKey === undefined) {
      if (showErrors)
        void window.showWarningMessage(`No usable API key was found in ${config.path}.`)
      return undefined
    }

    await this.set(config.apiKey)
    return config.apiKey
  }

  async prompt(): Promise<string | undefined> {
    const value = await window.showInputBox({
      title: 'CLIProxyAPI API Key',
      prompt: 'Enter an API key accepted by the local CLIProxyAPI server.',
      password: true,
      ignoreFocusOut: true,
      validateInput: input => input.trim() ? undefined : 'An API key is required.',
    })
    if (value === undefined || value.length === 0)
      return undefined
    await this.set(value.trim())
    return value.trim()
  }
}

export async function findConfigPath(): Promise<string | undefined> {
  const candidates = configCandidates()
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    }
    catch {}
  }
  return undefined
}

export function configCandidates(): string[] {
  const settings = workspace.getConfiguration('universalChatProvider')
  const configured = settings.get<string>('configPath', '').trim()
  if (configured.length > 0) {
    // Expand a leading `~` (also `~/` and `~\` on Windows) to the home directory.
    const expanded = configured.replace(/^~(?=$|[/\\])/, homedir())
    return [isAbsolute(expanded) ? normalize(expanded) : resolve(expanded)]
  }
  return settings.get<boolean>('autoDetectConfig', true)
    ? [
        join(homedir(), 'cliproxyapi', 'config.yaml'),
        join(homedir(), '.config', 'cliproxyapi', 'config.yaml'),
        join(homedir(), '.cli-proxy-api', 'config.yaml'),
      ]
    : []
}

export async function configureConnection(): Promise<boolean> {
  const settings = workspace.getConfiguration('universalChatProvider')
  const baseUrl = await window.showInputBox({
    title: 'CLIProxyAPI Base URL',
    value: settings.get<string>('baseUrl', 'http://127.0.0.1:8317'),
    prompt: 'Base URL of the CLIProxyAPI server.',
    ignoreFocusOut: true,
    validateInput: validateHttpUrl,
  })
  if (baseUrl === undefined || baseUrl.length === 0)
    return false
  await settings.update('baseUrl', normalizeBaseUrl(baseUrl), ConfigurationTarget.Global)

  const configPath = await window.showInputBox({
    title: 'CLIProxyAPI Config Path',
    value: settings.get<string>('configPath', ''),
    prompt: 'Optional path to config.yaml. Leave blank to use automatic detection.',
    ignoreFocusOut: true,
  })
  if (configPath !== undefined)
    await settings.update('configPath', configPath.trim(), ConfigurationTarget.Global)
  return true
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function validateHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? undefined
      : 'Use an http:// or https:// URL.'
  }
  catch {
    return 'Enter a valid URL.'
  }
}
