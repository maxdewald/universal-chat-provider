import { describe, expect, it } from 'vitest'
import { pickSuggestedUpdate } from '../../../src/cliproxy/managed/updates'

describe('pickSuggestedUpdate', () => {
  it.each([
    ['newest release within installed major', '7.2.5', ['7.2.5', '7.2.9', '7.3.0', '7.3.1'], '7.3.1'],
    ['leading v on versions', 'v7.2.5', ['v7.3.0'], '7.3.0'],
    ['higher major only', '7.2.5', ['8.0.0', '8.1.0'], null],
    ['higher major plus safe update', '7.2.5', ['7.4.0', '8.0.0'], '7.4.0'],
    ['nothing newer', '7.3.0', ['7.2.5', '7.3.0'], null],
    ['pre-releases and unparsable tags', '7.2.5', ['7.3.0-rc.1', 'nightly', '7.2.7'], '7.2.7'],
    ['invalid installed version', 'latest', ['7.3.0'], null],
  ])('%s', (_name, installed, available, expected) => {
    expect(pickSuggestedUpdate(installed, available)).toBe(expected)
  })
})
