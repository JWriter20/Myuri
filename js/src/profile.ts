/**
 * Seed -> behavioral profile.
 *
 * A Cursor's `seed` makes the motion stream reproducible; `generateProfile`
 * also draws a stable set of traits from it, so two cursors built from the same
 * seed type, move and scroll like the same person. Each trait is drawn around
 * the configured value, within ±`settings.variation` of it.
 *
 * The draw order below is fixed and mirrored in `python/src/myuri/profile.py`:
 * both packages use the same Mulberry32 PRNG and Box-Muller transform, so a
 * seed yields identical settings in either language.
 */

import { type DeepPartial, type MyuriSettings, resolveSettings } from './settings.js'
import { makeRng, gaussian } from './rng.js'

/**
 * The settings one person runs with: `settings` (deep-merged onto the defaults)
 * with each trait scaled by a factor drawn from `seed`, normal around 1 with sd
 * `variation / 2`, clamped to 1 ± `variation`. Same seed and settings, same
 * profile. The device, the wheel and `variation` itself are not drawn.
 */
export function generateProfile(seed: number, settings?: DeepPartial<MyuriSettings>): MyuriSettings {
  const p = resolveSettings(settings)
  const rng = makeRng(seed >>> 0)
  const v = p.variation
  const vary = (x: number) => x * Math.min(1 + v, Math.max(1 - v, gaussian(rng, 1, v / 2)))
  p.mouse.speedFactor = vary(p.mouse.speedFactor)
  p.overshoot.radius = vary(p.overshoot.radius)
  p.overshoot.threshold = vary(p.overshoot.threshold)
  p.overshoot.correctionSpeedFactor = vary(p.overshoot.correctionSpeedFactor)
  p.overshoot.dwell.minMs = vary(p.overshoot.dwell.minMs)
  p.overshoot.dwell.maxMs = vary(p.overshoot.dwell.maxMs)
  p.scroll.speedFactor = vary(p.scroll.speedFactor)
  // Past 1 the element would end below the viewport.
  p.scroll.finishPosition = Math.min(1, vary(p.scroll.finishPosition))
  p.scroll.realism.speedIrregularity = vary(p.scroll.realism.speedIrregularity)
  p.typing.wpm = vary(p.typing.wpm)
  p.typing.mistakeMultiplier = vary(p.typing.mistakeMultiplier)
  p.typing.pauses.rate = vary(p.typing.pauses.rate)
  p.typing.pauses.length = vary(p.typing.pauses.length)
  return p
}
