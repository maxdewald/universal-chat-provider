import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLocalProxyConfig } from '../../src/cliproxy/local-config'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async path => rm(path, { force: true, recursive: true })))
})

describe('local CLIProxyAPI config', () => {
  it('selects the first usable API key', async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, 'config.yaml')
    await writeFile(configPath, [
      'api-keys:',
      '  - your-api-key-1',
      '  - " actual-key "',
      '  - later-key',
    ].join('\n'))

    await expect(readLocalProxyConfig(configPath)).resolves.toEqual({
      path: configPath,
      apiKey: 'actual-key',
    })
  })

  it('omits placeholder keys', async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, 'config.yaml')
    await writeFile(configPath, [
      'api-keys:',
      '  - your-api-key',
    ].join('\n'))

    await expect(readLocalProxyConfig(configPath)).resolves.toEqual({
      path: configPath,
    })
  })

  it('reads a plaintext management key, ignoring hashed keys', async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, 'config.yaml')
    await writeFile(configPath, [
      'api-keys:',
      '  - actual-key',
      'remote-management:',
      '  secret-key: super-secret',
    ].join('\n'))

    await expect(readLocalProxyConfig(configPath)).resolves.toEqual({
      path: configPath,
      apiKey: 'actual-key',
      managementKey: 'super-secret',
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
