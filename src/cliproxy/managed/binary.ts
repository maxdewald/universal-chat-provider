import type { OutputChannel } from 'vscode'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { arch as osArch, platform as osPlatform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import semver from 'semver'
import { exists } from '../../shared/fs'

const execFileAsync = promisify(execFile)

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

/** Parse a `checksums.txt` (`<sha256>  <filename>`) into a filename→hash map. Pure. */
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

/** Strip a leading `v` so `v7.2.5` and `7.2.5` are equivalent. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

export async function fetchOk(url: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'universal-chat-provider-vscode' },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok)
    throw new Error(`Request to ${url} failed with HTTP ${response.status}.`)
  return response
}

export async function resolveVersion(requested: string, signal?: AbortSignal): Promise<string> {
  if (requested.toLowerCase() !== 'latest')
    return normalizeVersion(requested)
  const response = await fetchOk(`https://api.github.com/repos/${REPO}/releases/latest`, signal)
  const payload = await response.json() as { tag_name?: string }
  if (typeof payload.tag_name !== 'string' || payload.tag_name.length === 0)
    throw new Error('Could not determine the latest CLIProxyAPI release.')
  return normalizeVersion(payload.tag_name)
}

export interface AcquireOptions {
  binDir: string
  /** Pinned version or `latest`. */
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

  if (await exists(binaryPath)) {
    options.output.appendLine(`Using cached CLIProxyAPI ${version} at ${binaryPath}.`)
    return { binaryPath, version }
  }

  options.output.appendLine(`Downloading CLIProxyAPI ${version} (${asset.assetName})...`)
  const base = `https://github.com/${REPO}/releases/download/v${version}`
  const [archiveResponse, checksumResponse] = await Promise.all([
    fetchOk(`${base}/${asset.assetName}`, options.signal),
    fetchOk(`${base}/checksums.txt`, options.signal),
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
  const archivePath = join(versionDir, asset.assetName)
  await writeFile(archivePath, archive)

  // bsdtar (macOS/Windows) and GNU tar both extract our tar.gz; bsdtar also
  // reads the Windows .zip — so a single `tar -xf` covers every platform.
  await execFileAsync('tar', ['-xf', archivePath, '-C', versionDir])
  await rm(archivePath, { force: true })

  if (!(await exists(binaryPath)))
    throw new Error(`Extracted archive did not contain ${asset.binaryName}.`)
  if (osPlatform() !== 'win32')
    await chmod(binaryPath, 0o755)

  options.output.appendLine(`Installed CLIProxyAPI ${version} at ${binaryPath}.`)
  await pruneOldVersions(options.binDir, version, options.output)
  return { binaryPath, version }
}

/**
 * Version of the binary on disk — the single dir pruning keeps in `binDir` —
 * letting a window that adopted the shared server still report what is running.
 */
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
