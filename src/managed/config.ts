import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isPlainObject } from 'moderndash'
import { parse, stringify } from 'yaml'

export const DEFAULT_PORT = 8317
export const DEFAULT_HOST = '127.0.0.1'

export interface ManagedPaths {
  /** Root of the extension-owned managed state (under globalStorage). */
  root: string
  /** Directory holding versioned binaries (`bin/<version>/cli-proxy-api`). */
  binDir: string
  /** CLIProxyAPI `auth-dir` holding OAuth credential files. */
  authDir: string
  /** Generated `config.yaml` consumed by the server. */
  configPath: string
  /** Combined stdout/stderr log file for the detached server. */
  logPath: string
  /** One lease file per open window; the last one out stops the sidecar. */
  leaseDir: string
  /** Records the running sidecar's process id so any window can stop it. */
  pidPath: string
}

export function managedPaths(root: string): ManagedPaths {
  return {
    root,
    binDir: join(root, 'bin'),
    authDir: join(root, 'auth'),
    configPath: join(root, 'config.yaml'),
    logPath: join(root, 'cliproxy.log'),
    leaseDir: join(root, 'leases'),
    pidPath: join(root, 'server.pid'),
  }
}

/** A cryptographically random hex secret used for the proxy or management key. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

export interface ManagedConfigOptions {
  host: string
  port: number
  /** Proxy API key clients send as `Authorization: Bearer`. */
  apiKey: string
  /** Management key that unlocks the `/v0/management` login API. */
  managementKey: string
  authDir: string
}

/**
 * Render the minimal `config.yaml` for a locally managed server. The plaintext
 * `secret-key` is hashed by CLIProxyAPI on startup; we keep the plaintext in
 * SecretStorage so management calls keep working across restarts.
 *
 * `logging-to-file` is forced off: it defaults on and would make the binary
 * create a `logs/` folder in its working directory. We instead let it log to
 * the console and capture stdout/stderr into our own `cliproxy.log` under
 * globalStorage, so nothing leaks outside the extension's storage.
 */
export function buildManagedConfig(options: ManagedConfigOptions): string {
  return stringify({
    'host': options.host,
    'port': options.port,
    'auth-dir': options.authDir,
    'api-keys': [options.apiKey],
    'logging-to-file': false,
    'remote-management': {
      'allow-remote': false,
      'secret-key': options.managementKey,
    },
  })
}

/**
 * Rewrite only the `port` of an existing managed config, preserving the API and
 * management keys. The binary takes its port solely from the config file (there
 * is no `--port` flag), so the server must sync the config to the port it is
 * about to listen on — otherwise it binds the stale port, collides, and exits.
 */
export async function setConfigPort(configPath: string, port: number): Promise<void> {
  const parsed: unknown = parse(await readFile(configPath, 'utf8'))
  const config = isPlainObject(parsed) ? parsed : {}
  if (config.port === port)
    return
  config.port = port
  await writeFile(configPath, stringify(config))
}
