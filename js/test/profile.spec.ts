import { describe, it, expect } from 'vitest'
import { generateProfile } from '../src/profile.js'
import { defaultSettings } from '../src/settings.js'

describe('generateProfile', () => {
  it('is deterministic — same seed yields a deep-equal profile', () => {
    expect(generateProfile(1234)).toEqual(generateProfile(1234))
  })

  it('differs across seeds', () => {
    expect(generateProfile(1234)).not.toEqual(generateProfile(9999))
  })

  it('normalizes the seed (>>> 0), so equal-mod-2^32 seeds agree', () => {
    expect(generateProfile(5)).toEqual(generateProfile(5 + 0x100000000))
  })

  it('keeps every drawn field inside its human-plausible range', () => {
    for (const seed of [0, 1, 7, 42, 1234, 9999, 2 ** 31]) {
      const p = generateProfile(seed)
      expect(p.typing.wpm).toBeGreaterThanOrEqual(35)
      expect(p.typing.wpm).toBeLessThanOrEqual(130)
      expect(p.typing.mistakeMultiplier).toBeGreaterThanOrEqual(0.4)
      expect(p.typing.mistakeMultiplier).toBeLessThanOrEqual(2.0)
      expect(['qwerty', 'azerty']).toContain(p.typing.layout)

      expect(p.scroll.speedFactor).toBeGreaterThanOrEqual(0.75)
      expect(p.scroll.speedFactor).toBeLessThanOrEqual(1.4)
      expect(p.scroll.finishPosition).toBeGreaterThanOrEqual(0.3)
      expect(p.scroll.finishPosition).toBeLessThanOrEqual(0.7)
      expect(p.scroll.realism.speedIrregularity).toBeGreaterThanOrEqual(0.02)
      expect(p.scroll.realism.speedIrregularity).toBeLessThanOrEqual(0.18)

      expect(p.overshoot.radius).toBeGreaterThanOrEqual(60)
      expect(p.overshoot.radius).toBeLessThanOrEqual(200)
      expect(p.overshoot.threshold).toBeGreaterThanOrEqual(300)
      expect(p.overshoot.threshold).toBeLessThanOrEqual(800)
      // maxMs is always strictly above minMs by construction.
      expect(p.overshoot.dwell.maxMs).toBeGreaterThan(p.overshoot.dwell.minMs)
    }
  })

  it('returns a fully-owned object graph (fields present like defaults)', () => {
    const p = generateProfile(1)
    expect(Object.keys(p).sort()).toEqual(Object.keys(defaultSettings).sort())
    // Untouched fields fall back to defaults via resolveSettings.
    expect(p.correction).toEqual(defaultSettings.correction)
  })
})
