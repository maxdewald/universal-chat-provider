import { describe, expect, it } from 'vitest'
import { shouldNudge } from '../../src/chat/utility-model-nudge'

describe('shouldNudge', () => {
  // Copilot installed, override not yet pointed at our provider, not shown.
  const base = { alreadyShown: false, utilityModel: '', copilotInstalled: true }

  it('nudges a Copilot user who has not routed the override to our provider', () => {
    expect(shouldNudge(base)).toBe(true)
  })

  it('stays quiet once shown', () => {
    expect(shouldNudge({ ...base, alreadyShown: true })).toBe(false)
  })

  it('stays quiet without Copilot — the setting is inert there', () => {
    expect(shouldNudge({ ...base, copilotInstalled: false })).toBe(false)
  })

  it('stays quiet when already routed to our provider (whitespace ignored)', () => {
    expect(shouldNudge({ ...base, utilityModel: 'universal-chat-provider/foo' })).toBe(false)
    expect(shouldNudge({ ...base, utilityModel: '  universal-chat-provider/foo  ' })).toBe(false)
  })

  it('still nudges when the override points at some other vendor', () => {
    expect(shouldNudge({ ...base, utilityModel: 'some-other-vendor/model' })).toBe(true)
  })
})
