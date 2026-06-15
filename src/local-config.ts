import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isPlainObject } from 'moderndash'
import untildify from 'untildify'
import { parse } from 'yaml'

const PLACEHOLDER_KEY = /^your-api-key(?:-\d+)?$/i

export interface LocalProxyConfig {
  path: string
  apiKey?: string
  authDir: string
  /** Plaintext `remote-management.secret-key`, when set and not yet hashed. */
  managementKey?: string
  /** Configured server port, used to reach an external instance's management API. */
  port?: number
}

export async function readLocalProxyConfig(configPath: string): Promise<LocalProxyConfig> {
  const document = parse(await readFile(configPath, 'utf8'), {
    prettyErrors: true,
    strict: true,
    stringKeys: true,
  }) as unknown
  const configuredAuthDir = isPlainObject(document) && typeof document['auth-dir'] === 'string'
    ? document['auth-dir'].trim()
    : ''
  const authDir = configuredAuthDir.length > 0
    ? resolveConfigPath(configuredAuthDir, dirname(configPath))
    : join(homedir(), '.cli-proxy-api')
  const apiKey = firstApiKey(document)
  const managementKey = managementSecretKey(document)
  const port = configuredPort(document)
  return {
    path: configPath,
    authDir,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(managementKey === undefined ? {} : { managementKey }),
    ...(port === undefined ? {} : { port }),
  }
}

function managementSecretKey(value: unknown): string | undefined {
  if (!isPlainObject(value) || !isPlainObject(value['remote-management']))
    return undefined
  const key = value['remote-management']['secret-key']
  // A bcrypt hash ($2a$...) cannot be replayed as a bearer token; only a
  // plaintext key is usable, so ignore hashed values.
  if (typeof key !== 'string' || key.trim().length === 0 || key.startsWith('$2'))
    return undefined
  return key.trim()
}

function configuredPort(value: unknown): number | undefined {
  if (!isPlainObject(value) || typeof value.port !== 'number' || !Number.isInteger(value.port))
    return undefined
  return value.port > 0 ? value.port : undefined
}

function firstApiKey(value: unknown): string | undefined {
  if (!isPlainObject(value) || !Array.isArray(value['api-keys']))
    return undefined
  return value['api-keys'].find((candidate): candidate is string =>
    typeof candidate === 'string'
    && candidate.trim().length > 0
    && !PLACEHOLDER_KEY.test(candidate.trim()),
  )?.trim()
}

function resolveConfigPath(value: string, baseDir: string): string {
  const expanded = untildify(value)
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded)
}
