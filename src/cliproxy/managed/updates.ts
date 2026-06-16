import semver from 'semver'
import { fetchOk, normalizeVersion, REPO } from './binary'

/**
 * Newest release that is a safe upgrade from `installed`: strictly newer, but
 * within the same major version. A new major may be breaking, so it is never
 * suggested. Returns null when nothing qualifies.
 */
export function pickSuggestedUpdate(installed: string, available: readonly string[]): string | null {
  const current = semver.valid(normalizeVersion(installed))
  if (current === null)
    return null
  const withinMajor = `>${current} <${semver.major(current) + 1}.0.0`
  const candidates = available.map(normalizeVersion).filter(version => semver.valid(version) !== null)
  // maxSatisfying ignores pre-releases (e.g. 7.3.0-rc.1) by default.
  return semver.maxSatisfying(candidates, withinMajor)
}

interface ReleaseEntry {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
}

/**
 * Normalized version strings of the repo's published (non-draft, non-prerelease)
 * releases, newest page first as GitHub returns them.
 */
export async function listReleaseVersions(signal?: AbortSignal): Promise<string[]> {
  const response = await fetchOk(`https://api.github.com/repos/${REPO}/releases?per_page=100`, signal)
  const payload = await response.json() as ReleaseEntry[]
  return payload
    .filter(release => release.draft !== true && release.prerelease !== true && typeof release.tag_name === 'string')
    .map(release => normalizeVersion(release.tag_name!))
}
