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
  return {
    path: configPath,
    authDir,
    ...(apiKey === undefined ? {} : { apiKey }),
  }
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
