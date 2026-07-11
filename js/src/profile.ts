/**
 * Seed -> behavioral profile.
 *
 * A Cursor's `seed` already makes the per-action *motion stream* reproducible.
 * `generateProfile` goes one step further: it derives a stable set of
 * behavioral traits — a *behavioral fingerprint* — from the same seed. Two
 * cursors built from the same seed therefore share not just identical motion,
 * but the same "personality": how fast this person types, how often they
 * mistype, how aggressively they overshoot, how quickly they scroll.
 *
 * The draw order below is fixed and mirrored exactly in the Python package
 * (`python/src/myuri/profile.py`); because both packages use the same
 * Mulberry32 PRNG and Box-Muller transform, a given seed yields byte-identical
 * settings in either language.
 */

import { type MyuriSettings, resolveSettings } from './settings.js'
import { makeRng, gaussian, type Rng } from './rng.js'

/** Clamp `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Round half-up (matches JS `Math.round`; mirrored in Python via floor(x+0.5)). */
function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5)
}

/** One Gaussian draw, clamped into `[min, max]`. */
function draw(rng: Rng, mean: number, std: number, min: number, max: number): number {
  return clamp(gaussian(rng, mean, std), min, max)
}

/**
 * Derive a full {@link MyuriSettings} behavioral profile from a seed.
 *
 * Same seed -> identical profile. The values are drawn around
 * {@link defaultSettings} so a random seed still produces plausible,
 * human-range behavior; `resolveSettings` fills any field not drawn here.
 */
export function generateProfile(seed: number): MyuriSettings {
  const rng = makeRng(seed >>> 0)

  // Typing.
  const wpm = roundHalfUp(draw(rng, 80, 18, 35, 130))
  const mistakeMultiplier = draw(rng, 1.0, 0.35, 0.4, 2.0)
  // Always qwerty — the fleet's fingerprints are US-layout; still burn the
  // draw so seed→profile streams stay stable.
  rng()
  const layout = 'qwerty' as const

  // Scroll dynamics.
  const scrollSpeedFactor = draw(rng, 1.0, 0.16, 0.75, 1.4)
  const scrollDelay = roundHalfUp(draw(rng, 50, 12, 25, 90))
  const scrollOvershoot = roundHalfUp(draw(rng, 30, 10, 8, 60))
  const scrollFinishPosition = draw(rng, 0.5, 0.08, 0.3, 0.7)
  const scrollIrregularity = draw(rng, 0.08, 0.03, 0.02, 0.18)

  // Overshoot / correction geometry.
  const overshootSpread = draw(rng, 10, 3, 4, 20)
  const overshootRadius = draw(rng, 120, 30, 60, 200)
  const overshootThreshold = roundHalfUp(draw(rng, 500, 100, 300, 800))
  const correctionSpeedFactor = draw(rng, 1.0, 0.15, 0.7, 1.4)
  const dwellMin = roundHalfUp(draw(rng, 20, 6, 5, 40))
  const dwellMax = dwellMin + roundHalfUp(draw(rng, 40, 12, 15, 80))

  return resolveSettings({
    overshoot: {
      spread: overshootSpread,
      radius: overshootRadius,
      threshold: overshootThreshold,
      correctionSpeedFactor,
      dwell: { minMs: dwellMin, maxMs: dwellMax },
    },
    scroll: {
      delay: scrollDelay,
      speedFactor: scrollSpeedFactor,
      overshoot: scrollOvershoot,
      finishPosition: scrollFinishPosition,
      realism: { speedIrregularity: scrollIrregularity },
    },
    typing: {
      wpm,
      layout,
      mistakeMultiplier,
    },
  })
}
