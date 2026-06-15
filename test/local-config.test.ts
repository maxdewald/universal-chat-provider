import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLocalProxyConfig } from '../src/local-config'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async path => rm(path, { force: true, recursive: true })))
})

describe('local CLIProxyAPI config', () => {
  it('selects the first usable API key and resolves a relative auth directory', async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, 'config.yaml')
    await writeFile(configPath, [
      'auth-dir: auth',
      'api-keys:',
      '  - your-api-key-1',
      '  - " actual-key "',
      '  - later-key',
    ].join('\n'))

    await expect(readLocalProxyConfig(configPath)).resolves.toEqual({
      path: configPath,
      apiKey: 'actual-key',
      authDir: join(directory, 'auth'),
    })
  })

  it('expands home paths and omits placeholder keys', async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, 'config.yaml')
    await writeFile(configPath, [
      'auth-dir: ~/.cli-proxy-api',
      'api-keys:',
      '  - your-api-key',
    ].join('\n'))

    await expect(readLocalProxyConfig(configPath)).resolves.toEqual({
      path: configPath,
      authDir: join(homedir(), '.cli-proxy-api'),
    })
  })

  it('uses the default auth directory when auth-dir is empty', async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, 'config.yaml')
    await writeFile(configPath, 'auth-dir: "   "\n')

    await expect(readLocalProxyConfig(configPath)).resolves.toEqual({
      path: configPath,
      authDir: join(homedir(), '.cli-proxy-api'),
    })
  })

  it('reads a plaintext management key and port, ignoring hashed keys', async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, 'config.yaml')
    await writeFile(configPath, [
      'port: 9001',
      'auth-dir: auth',
      'api-keys:',
      '  - actual-key',
      'remote-management:',
      '  secret-key: super-secret',
    ].join('\n'))

    await expect(readLocalProxyConfig(configPath)).resolves.toEqual({
      path: configPath,
      apiKey: 'actual-key',
      authDir: join(directory, 'auth'),
      managementKey: 'super-secret',
      port: 9001,
    })
  })

  it('ignores a bcrypt-hashed management secret', async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, 'config.yaml')
    await writeFile(configPath, [
      'auth-dir: auth',
      'remote-management:',
      '  secret-key: "$2a$10$abcdefghijklmnopqrstuv"',
    ].join('\n'))

    const config = await readLocalProxyConfig(configPath)
    expect(config.managementKey).toBeUndefined()
  })

  it('rejects malformed YAML', async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, 'config.yaml')
    await writeFile(configPath, 'api-keys: [')

    await expect(readLocalProxyConfig(configPath)).rejects.toThrow()
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'universal-chat-provider-config-'))
  tempDirectories.push(directory)
  return directory
}
