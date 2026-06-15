import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { buildManagedConfig, generateSecret, managedPaths, setConfigPort } from '../src/managed/config'

describe('managed config', () => {
  it('derives all managed paths from a root directory', () => {
    const paths = managedPaths('/tmp/store')
    expect(paths).toEqual({
      root: '/tmp/store',
      binDir: join('/tmp/store', 'bin'),
      authDir: join('/tmp/store', 'auth'),
      configPath: join('/tmp/store', 'config.yaml'),
      logPath: join('/tmp/store', 'cliproxy.log'),
    })
  })

  it('builds a config the server can parse with localhost-only management', () => {
    const yaml = buildManagedConfig({
      host: '127.0.0.1',
      port: 8317,
      apiKey: 'proxy-key',
      managementKey: 'mgmt-key',
      authDir: '/tmp/store/auth',
    })
    expect(parse(yaml)).toEqual({
      'host': '127.0.0.1',
      'port': 8317,
      'auth-dir': '/tmp/store/auth',
      'api-keys': ['proxy-key'],
      'remote-management': {
        'allow-remote': false,
        'secret-key': 'mgmt-key',
      },
    })
  })

  it('generates random hex secrets of the requested size', () => {
    const a = generateSecret()
    const b = generateSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
    expect(generateSecret(8)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('setConfigPort', () => {
  let dir: string

  afterEach(async () => {
    if (dir !== undefined)
      await rm(dir, { recursive: true, force: true })
  })

  it('rewrites only the port and preserves the keys', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ucp-config-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, buildManagedConfig({
      host: '127.0.0.1',
      port: 8317,
      apiKey: 'proxy-key',
      managementKey: 'mgmt-key',
      authDir: join(dir, 'auth'),
    }))

    await setConfigPort(configPath, 51227)

    expect(parse(await readFile(configPath, 'utf8'))).toEqual({
      'host': '127.0.0.1',
      'port': 51227,
      'auth-dir': join(dir, 'auth'),
      'api-keys': ['proxy-key'],
      'remote-management': {
        'allow-remote': false,
        'secret-key': 'mgmt-key',
      },
    })
  })
})
