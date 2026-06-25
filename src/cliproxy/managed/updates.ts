import semver from 'semver'
import { fetcher, normalizeVersion, REPO } from './binary'

export function pickSuggestedUpdate(installed: string, available: readonly string[]): string | null {
  const current = semver.valid(normalizeVersion(installed))
  if (current === null)
    return null
  const withinMajor = `>${current} <${semver.major(current) + 1}.0.0`
  const candidates = available.map(normalizeVersion).filter(version => semver.valid(version) !== null)
  return semver.maxSatisfying(candidates, withinMajor)
}

interface ReleaseEntry {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
}

export async function listReleaseVersions(signal?: AbortSignal): Promise<string[]> {
  const payload = await fetcher
    .get(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { signal: signal ?? null })
    .json<ReleaseEntry[]>()
  return payload
    .filter(release => release.draft !== true && release.prerelease !== true && typeof release.tag_name === 'string')
    .map(release => normalizeVersion(release.tag_name!))
}
