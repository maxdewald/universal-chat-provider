import type { OutputChannel } from 'vscode'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { arch as osArch, platform as osPlatform } from 'node:os'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import ky from 'ky'
import { parseTarGzip } from 'nanotar'
import semver from 'semver'

export const REPO = 'router-for-me/CLIProxyAPI'
export const DEFAULT_BINARY_VERSION = '7.2.5'

export interface AssetInfo {
  assetName: string
  binaryName: string
  isZip: boolean
}

export function resolveAsset(platform: NodeJS.Platform, arch: string, version: string): AssetInfo {
  const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux'
  const cpu = arch === 'arm64' ? 'aarch64' : 'amd64'
  const isZip = os === 'windows'
  return {
    assetName: `CLIProxyAPI_${version}_${os}_${cpu}.${isZip ? 'zip' : 'tar.gz'}`,
    binaryName: os === 'windows' ? 'cli-proxy-api.exe' : 'cli-proxy-api',
    isZip,
  }
}

export function parseChecksums(text: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(line.trim())
    if (match)
      result.set(match[2]!.trim(), match[1]!.toLowerCase())
  }
  return result
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

// ky retries transient failures (5xx/429/network) and honors Retry-After on rate limits.
export const fetcher = ky.create({
  headers: { 'User-Agent': 'universal-chat-provider-vscode' },
  retry: { limit: 3 },
  timeout: false,
})

export async function resolveVersion(requested: string, signal?: AbortSignal): Promise<string> {
  if (requested.toLowerCase() !== 'latest')
    return normalizeVersion(requested)
  const payload = await fetcher
    .get(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: signal ?? null })
    .json<{ tag_name?: string }>()
  if (typeof payload.tag_name !== 'string' || payload.tag_name.length === 0)
    throw new Error('Could not determine the latest CLIProxyAPI release.')
  return normalizeVersion(payload.tag_name)
}

export interface AcquireOptions {
  binDir: string
  requestedVersion: string
  output: OutputChannel
  signal?: AbortSignal
}

export interface AcquireResult {
  binaryPath: string
  version: string
}

export async function acquireBinary(options: AcquireOptions): Promise<AcquireResult> {
  const version = await resolveVersion(options.requestedVersion, options.signal)
  const asset = resolveAsset(osPlatform(), osArch(), version)
  const versionDir = join(options.binDir, version)
  const binaryPath = join(versionDir, asset.binaryName)

  if (await access(binaryPath).then(() => true, () => false)) {
    options.output.appendLine(`Using cached CLIProxyAPI ${version} at ${binaryPath}.`)
    return { binaryPath, version }
  }

  options.output.appendLine(`Downloading CLIProxyAPI ${version} (${asset.assetName})...`)
  const base = `https://github.com/${REPO}/releases/download/v${version}`
  const signal = options.signal ?? null
  const [archiveResponse, checksumResponse] = await Promise.all([
    fetcher.get(`${base}/${asset.assetName}`, { signal }),
    fetcher.get(`${base}/checksums.txt`, { signal }),
  ])
  const archive = new Uint8Array(await archiveResponse.arrayBuffer())
  const expected = parseChecksums(await checksumResponse.text()).get(asset.assetName)
  if (expected === undefined)
    throw new Error(`No checksum found for ${asset.assetName}.`)
  const actual = sha256(archive)
  if (actual !== expected)
    throw new Error(`Checksum mismatch for ${asset.assetName} (expected ${expected}, got ${actual}).`)

  await rm(versionDir, { recursive: true, force: true })
  await mkdir(versionDir, { recursive: true })
  await extractArchive(archive, asset.isZip, versionDir)

  if (!(await access(binaryPath).then(() => true, () => false)))
    throw new Error(`Extracted archive did not contain ${asset.binaryName}.`)
  if (osPlatform() !== 'win32')
    await chmod(binaryPath, 0o755)

  options.output.appendLine(`Installed CLIProxyAPI ${version} at ${binaryPath}.`)
  await pruneOldVersions(options.binDir, version, options.output)
  return { binaryPath, version }
}

export async function extractArchive(archive: Uint8Array, isZip: boolean, dest: string): Promise<void> {
  const entries = isZip
    ? Object.entries(unzipSync(archive)).map(([name, data]) => ({ name, data }))
    : (await parseTarGzip(archive)).map(item => ({ name: item.name, data: item.data }))

  for (const { name, data } of entries) {
    if (data === undefined || name.endsWith('/'))
      continue
    if (name.split('/').includes('..'))
      throw new Error(`Refusing to extract unsafe path: ${name}`)
    const target = join(dest, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
  }
}

export async function readInstalledVersion(binDir: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(binDir)
  }
  catch {
    return undefined
  }
  const [newest] = semver.rsort(entries.filter(entry => semver.valid(entry) !== null))
  return newest
}

async function pruneOldVersions(binDir: string, keep: string, output: OutputChannel): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(binDir)
  }
  catch {
    return
  }
  await Promise.all(entries
    .filter(entry => entry !== keep)
    .map(async (entry) => {
      try {
        await rm(join(binDir, entry), { recursive: true, force: true })
        output.appendLine(`Removed stale CLIProxyAPI ${entry}.`)
      }
      catch {}
    }))
}
