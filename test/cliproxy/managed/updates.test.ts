import { describe, expect, it } from 'vitest'
import { pickSuggestedUpdate } from '../../../src/cliproxy/managed/updates'

describe('pickSuggestedUpdate', () => {
  it('suggests the newest release within the installed major', () => {
    expect(pickSuggestedUpdate('7.2.5', ['7.2.5', '7.2.9', '7.3.0', '7.3.1'])).toBe('7.3.1')
  })

  it('tolerates a leading v on installed and candidate versions', () => {
    expect(pickSuggestedUpdate('v7.2.5', ['v7.3.0'])).toBe('7.3.0')
  })

  it('never crosses a major version, even when a higher major is the latest', () => {
    expect(pickSuggestedUpdate('7.2.5', ['8.0.0', '8.1.0'])).toBeNull()
    expect(pickSuggestedUpdate('7.2.5', ['7.4.0', '8.0.0'])).toBe('7.4.0')
  })

  it('returns null when nothing is strictly newer', () => {
    expect(pickSuggestedUpdate('7.3.0', ['7.2.5', '7.3.0'])).toBeNull()
  })

  it('ignores pre-releases and unparsable tags', () => {
    expect(pickSuggestedUpdate('7.2.5', ['7.3.0-rc.1', 'nightly', '7.2.7'])).toBe('7.2.7')
  })

  it('returns null when the installed version is not valid semver', () => {
    expect(pickSuggestedUpdate('latest', ['7.3.0'])).toBeNull()
  })
})
