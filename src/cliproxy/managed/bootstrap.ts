import type { Disposable, ExtensionContext, OutputChannel } from 'vscode'
import type { ManagedPaths } from './config'
import { mkdir, writeFile } from 'node:fs/promises'
import { RelativePattern, Uri, workspace } from 'vscode'
import { exists } from '../../shared/fs'
import { SECRET_KEY } from '../credentials'
import {
  buildManagedConfig,
  DEFAULT_HOST,
  DEFAULT_PORT,
  generateSecret,
  managedPaths,
} from './config'
import { claimLease } from './leases'
import { ManagedServer } from './server'

export const MGMT_KEY_SECRET = 'universalChatProvider.managementKey'
export const PORT_STATE_KEY = 'universalChatProvider.managedPort'

export interface ManagedState {
  paths: ManagedPaths
  server: ManagedServer
  managementKey: string
}

export interface ProvisionOptions {
  context: ExtensionContext
  output: OutputChannel
  /** Pinned binary version or `latest`, read fresh on each acquire/restart. */
  requestedVersion: () => string
  /** Confirms an already-healthy server on a port is ours before adopting it. */
  verifyOwnership: (baseUrl: string) => Promise<boolean>
}

export async function provisionManagedState(options: ProvisionOptions): Promise<ManagedState> {
  const { context, output } = options
  const paths = managedPaths(context.globalStorageUri.fsPath)
  await mkdir(paths.root, { recursive: true })
  await mkdir(paths.authDir, { recursive: true })
  // Register this window so the last one to close knows to stop the sidecar.
  claimLease(paths.leaseDir)

  const apiKey = await ensureSecret(context, SECRET_KEY)
  const managementKey = await ensureSecret(context, MGMT_KEY_SECRET)

  if (!(await exists(paths.configPath))) {
    const port = context.globalState.get<number>(PORT_STATE_KEY) ?? DEFAULT_PORT
    await writeFile(paths.configPath, buildManagedConfig({
      host: DEFAULT_HOST,
      port,
      apiKey,
      managementKey,
      authDir: paths.authDir,
    }))
    output.appendLine(`Wrote managed CLIProxyAPI config to ${paths.configPath}.`)
  }

  const server = new ManagedServer({
    paths,
    output,
    host: DEFAULT_HOST,
    requestedVersion: options.requestedVersion,
    getPort: () => context.globalState.get<number>(PORT_STATE_KEY),
    setPort: port => context.globalState.update(PORT_STATE_KEY, port),
    verifyOwnership: options.verifyOwnership,
  })
  return { paths, server, managementKey }
}

export function watchAuthDir(authDir: string, onChange: () => void): Disposable[] {
  const watcher = workspace.createFileSystemWatcher(new RelativePattern(Uri.file(authDir), '**'))
  return [
    watcher,
    watcher.onDidCreate(onChange),
    watcher.onDidChange(onChange),
    watcher.onDidDelete(onChange),
  ]
}

async function ensureSecret(context: ExtensionContext, key: string): Promise<string> {
  const existing = await context.secrets.get(key)
  if (existing !== undefined && existing.length > 0)
    return existing
  const value = generateSecret()
  await context.secrets.store(key, value)
  return value
}
