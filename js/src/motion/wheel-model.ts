import type { Rng } from '../rng.js'
import { gaussian } from '../rng.js'
import type { ScrollEvent } from './scroll-model.js'

/**
 * Mouse-wheel scrolling: the counterpart of the trackpad model in
 * `scroll-model.ts`.
 *
 * A trackpad reports a stream of small pixel deltas. A mouse wheel turns in
 * notches: the finger rolls the wheel a few notches (a stroke), lifts, re-grips
 * and rolls again. Two styles:
 *
 *  - `notched` (Windows, Linux): one event per notch, each `pxPerNotch`
 *    (default 100, which Camoufox turns into exactly one 3-line notch).
 *  - `macos`: macOS reports the wheel in 20 ms frames and accelerates a fast
 *    roll. A stroke starts at one line a frame and climbs to ~10, `pxPerLine`
 *    (default 16) each.
 *
 * Fitted from a recorded notched USB mouse (Keychron M6) on macOS, Firefox,
 * 1666 wheel events (human-input-recordings/mac-mini):
 *  - strokes of 3+ frames last lognormal(5.215, 0.552) ms (median 184);
 *  - re-grip between strokes lognormal(4.952, 0.563) ms (median 141);
 *  - a third of strokes are a lone notch;
 *  - macOS frames are 20 ms, ~10% 40 ms (a dropped frame); a stroke starts at
 *    1 line, rises 1-3 lines a frame (sometimes 5) to a peak of 6-13 lines
 *    (median 10) and holds it to the end.
 * macOS hides the individual notches inside its frames, so the notch count of a
 * `notched` stroke (2-6) is a physical estimate, not fitted: with a 184 ms
 * stroke it gives 30-90 ms between notches.
 */

export type WheelStyle = 'notched' | 'macos'

export interface WheelOptions {
  style?: WheelStyle
  /** Pixels per notch (`notched`). */
  pxPerNotch?: number
  /** Pixels per line (`macos`). */
  pxPerLine?: number
}

const STROKE_MU = 5.215
const STROKE_SD = 0.552
const STROKE_MIN_MS = 60
const STROKE_MAX_MS = 450
const REGRIP_MU = 4.952
const REGRIP_SD = 0.563
const REGRIP_MIN_MS = 50
const REGRIP_MAX_MS = 600
const LONE_NOTCH_PROBABILITY = 0.33
const MIN_NOTCHES = 2
const MAX_NOTCHES = 6
const NOTCH_JITTER_MS = 3
const MIN_NOTCH_GAP_MS = 8

const MAC_FRAME_MS = 20
const MAC_DROPPED_FRAME_PROBABILITY = 0.1
const MAC_PEAK_MEAN = 10
const MAC_PEAK_SD = 1.6
const MAC_PEAK_MIN = 6
const MAC_PEAK_MAX = 13

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function lognormal(rng: Rng, mu: number, sd: number): number {
  return Math.exp(gaussian(rng, mu, sd))
}

/** Minimum-jerk finger position 0..1 at time fraction tau. */
function minJerk(tau: number): number {
  return tau * tau * tau * (10 - 15 * tau + 6 * tau * tau)
}

/** Time fraction at which the minimum-jerk motion reaches position `s`. */
function minJerkInverse(s: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (minJerk(mid) < s) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Notch counts of each stroke, covering `total` notches. */
function strokeSizes(total: number, rng: Rng): number[] {
  const sizes: number[] = []
  let left = total
  while (left > 0) {
    const n = rng() < LONE_NOTCH_PROBABILITY
      ? 1
      : MIN_NOTCHES + Math.floor(rng() * (MAX_NOTCHES - MIN_NOTCHES + 1))
    sizes.push(Math.min(n, left))
    left -= sizes[sizes.length - 1]
  }
  return sizes
}

function notchedPath(target: number, rng: Rng, pxPerNotch: number): ScrollEvent[] {
  const sign = Math.sign(target)
  const total = Math.max(1, Math.round(Math.abs(target) / pxPerNotch))
  const events: ScrollEvent[] = []
  for (const n of strokeSizes(total, rng)) {
    const duration = clamp(lognormal(rng, STROKE_MU, STROKE_SD), STROKE_MIN_MS, STROKE_MAX_MS)
    // Notch i clicks when the finger has rolled (i + 0.5) / n of the stroke.
    const times = Array.from({ length: n }, (_, i) => duration * minJerkInverse((i + 0.5) / n))
    for (let i = 0; i < n; i++) {
      const gap = i + 1 < n
        ? Math.max(MIN_NOTCH_GAP_MS, times[i + 1] - times[i] + gaussian(rng, 0, NOTCH_JITTER_MS))
        : clamp(lognormal(rng, REGRIP_MU, REGRIP_SD), REGRIP_MIN_MS, REGRIP_MAX_MS)
      events.push({ deltaTime: Math.round(gap), deltaY: sign * pxPerNotch })
    }
  }
  return events
}

function macPath(target: number, rng: Rng, pxPerLine: number): ScrollEvent[] {
  const sign = Math.sign(target)
  let left = Math.max(1, Math.round(Math.abs(target) / pxPerLine))
  const events: ScrollEvent[] = []
  while (left > 0) {
    let frames: number
    if (rng() < LONE_NOTCH_PROBABILITY) {
      frames = 1
    } else {
      const duration = clamp(lognormal(rng, STROKE_MU, STROKE_SD), STROKE_MIN_MS, STROKE_MAX_MS)
      frames = Math.max(2, Math.round(duration / MAC_FRAME_MS))
    }
    const peak = Math.round(clamp(gaussian(rng, MAC_PEAK_MEAN, MAC_PEAK_SD), MAC_PEAK_MIN, MAC_PEAK_MAX))
    let lines = 1
    for (let f = 0; f < frames && left > 0; f++) {
      if (f > 0) {
        const step = rng() < 0.2 ? 5 : 1 + Math.floor(rng() * 3)
        lines = Math.min(peak, lines + step)
      }
      const sent = Math.min(lines, left)
      left -= sent
      const last = f + 1 === frames || left === 0
      const gap = last
        ? clamp(lognormal(rng, REGRIP_MU, REGRIP_SD), REGRIP_MIN_MS, REGRIP_MAX_MS)
        : rng() < MAC_DROPPED_FRAME_PROBABILITY ? 2 * MAC_FRAME_MS : MAC_FRAME_MS
      events.push({ deltaTime: Math.round(gap), deltaY: sign * sent * pxPerLine })
    }
  }
  return events
}

/**
 * Plan a mouse-wheel scroll of about `desiredD` px. A wheel moves in whole
 * notches (or lines), so the sum is the nearest whole number of them, at least
 * one; read it back from the events. Each event's `deltaTime` is the wait
 * after it. A request that rounds to 0 px returns [].
 */
export function generateWheelPath(desiredD: number, rng: Rng, options?: WheelOptions): ScrollEvent[] {
  if (Math.round(desiredD) === 0) return []
  const style = options?.style ?? 'notched'
  return style === 'macos'
    ? macPath(desiredD, rng, options?.pxPerLine ?? 16)
    : notchedPath(desiredD, rng, options?.pxPerNotch ?? 100)
}
