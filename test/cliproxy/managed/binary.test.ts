import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { createTarGzip } from 'nanotar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractArchive, normalizeVersion, parseChecksums, readInstalledVersion, resolveAsset, sha256 } from '../../../src/cliproxy/managed/binary'

describe('binary asset resolution', () => {
  it.each([
    ['darwin', 'arm64', { assetName: 'CLIProxyAPI_7.2.5_darwin_aarch64.tar.gz', binaryName: 'cli-proxy-api', isZip: false }],
    ['darwin', 'x64', { assetName: 'CLIProxyAPI_7.2.5_darwin_amd64.tar.gz', binaryName: 'cli-proxy-api', isZip: false }],
    ['linux', 'arm64', { assetName: 'CLIProxyAPI_7.2.5_linux_aarch64.tar.gz', binaryName: 'cli-proxy-api', isZip: false }],
    ['win32', 'x64', { assetName: 'CLIProxyAPI_7.2.5_windows_amd64.zip', binaryName: 'cli-proxy-api.exe', isZip: true }],
  ] as const)('maps %s/%s to the release asset', (platform, arch, expected) => {
    expect(resolveAsset(platform, arch, '7.2.5')).toEqual(expected)
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

describe('extractArchive', () => {
  let dest: string

  beforeEach(async () => {
    dest = await mkdtemp(join(tmpdir(), 'ucp-extract-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  const bin = new TextEncoder().encode('#!/bin/sh\necho hi\n')

  it('extracts a tar.gz, preserving nested paths', async () => {
    const archive = await createTarGzip([
      { name: 'cli-proxy-api', data: bin },
      { name: 'docs/README.md', data: new TextEncoder().encode('readme') },
    ])
    await extractArchive(archive, false, dest)
    expect(new Uint8Array(await readFile(join(dest, 'cli-proxy-api')))).toEqual(bin)
    expect(await readFile(join(dest, 'docs', 'README.md'), 'utf8')).toBe('readme')
  })

  it('extracts a zip', async () => {
    const archive = zipSync({ 'cli-proxy-api.exe': bin })
    await extractArchive(archive, true, dest)
    expect(new Uint8Array(await readFile(join(dest, 'cli-proxy-api.exe')))).toEqual(bin)
  })

  it('rejects path traversal', async () => {
    const archive = zipSync({ '../escape': bin })
    await expect(extractArchive(archive, true, dest)).rejects.toThrow(/unsafe path/)
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
