import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeVersion, parseChecksums, readInstalledVersion, resolveAsset, sha256 } from '../../../src/cliproxy/managed/binary'

describe('binary asset resolution', () => {
  it('maps platform and arch to the matching release asset', () => {
    expect(resolveAsset('darwin', 'arm64', '7.2.5')).toEqual({
      assetName: 'CLIProxyAPI_7.2.5_darwin_aarch64.tar.gz',
      binaryName: 'cli-proxy-api',
      isZip: false,
    })
    expect(resolveAsset('darwin', 'x64', '7.2.5')).toMatchObject({
      assetName: 'CLIProxyAPI_7.2.5_darwin_amd64.tar.gz',
    })
    expect(resolveAsset('linux', 'arm64', '7.2.5')).toMatchObject({
      assetName: 'CLIProxyAPI_7.2.5_linux_aarch64.tar.gz',
      binaryName: 'cli-proxy-api',
    })
    expect(resolveAsset('win32', 'x64', '7.2.5')).toEqual({
      assetName: 'CLIProxyAPI_7.2.5_windows_amd64.zip',
      binaryName: 'cli-proxy-api.exe',
      isZip: true,
    })
  })

  it('parses checksum lines into a filename map', () => {
    const map = parseChecksums([
      '4cc0acfeb7afc0c37da33a11a16f9beba0dcb7e201be2d2743a3a65d26704a74  CLIProxyAPI_7.2.5_darwin_aarch64.tar.gz',
      '5b9a6930f4826f8a92fbf14ea5b2a7b84016c3a53032573c9593c289defc34a1  CLIProxyAPI_7.2.5_windows_amd64.zip',
      '',
      'garbage line',
    ].join('\n'))

    expect(map.get('CLIProxyAPI_7.2.5_darwin_aarch64.tar.gz'))
      .toBe('4cc0acfeb7afc0c37da33a11a16f9beba0dcb7e201be2d2743a3a65d26704a74')
    expect(map.size).toBe(2)
  })

  it('normalizes versions and hashes content', () => {
    expect(normalizeVersion('v7.2.5')).toBe('7.2.5')
    expect(normalizeVersion('  7.2.5 ')).toBe('7.2.5')
    expect(sha256(new TextEncoder().encode('abc')))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('readInstalledVersion', () => {
  let binDir: string

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'ucp-bin-'))
  })

  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true })
  })

  it('returns undefined when the directory is missing or has no version dirs', async () => {
    expect(await readInstalledVersion(join(binDir, 'absent'))).toBeUndefined()
    await mkdir(join(binDir, 'not-a-version'))
    expect(await readInstalledVersion(binDir)).toBeUndefined()
  })

  it('reports the newest version directory, ignoring non-version entries', async () => {
    await mkdir(join(binDir, '7.2.5'))
    await mkdir(join(binDir, '7.10.0'))
    await mkdir(join(binDir, 'tmp'))
    expect(await readInstalledVersion(binDir)).toBe('7.10.0')
  })
})
