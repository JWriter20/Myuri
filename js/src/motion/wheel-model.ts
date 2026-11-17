import type { Rng } from '../rng.js'
import { gaussian } from '../rng.js'
import type { ScrollEvent } from './scroll-model.js'

/**
 * Mouse-wheel scrolling: the counterpart of the trackpad model in
 * `scroll-model.ts`.
 *
 * A trackpad reports a stream of small pixel deltas. A mouse wheel turns in
 * notches: the finger flicks the wheel through some notches (a stroke), lifts,
 * re-grips and flicks again. Two styles:
 *
 *  - `notched` (Windows, Linux): one event a notch, each `pxPerNotch` (default
 *    100, which Camoufox turns into exactly one 3-line notch). The page takes a
 *    fast flick's notches one display frame at a time, so the notches that land
 *    in one 60 Hz frame arrive as one event of 2-4 notches. (Firefox merges
 *    wheel events only while the page is behind, which a browser driven one
 *    wheel call at a time never is, so the planner merges them.)
 *  - `macos`: macOS reports the wheel in 20 ms frames and accelerates a fast
 *    roll. A stroke starts at one line a frame and climbs to ~10, `pxPerLine`
 *    (default 16) each.
 *
 * `notched` is fitted from a notched USB mouse on Windows, Firefox, 411 wheel
 * events in 5 long scrolls, split into strokes at gaps over 40 ms (29 single
 * strokes of 4+ notches; robust lognormal fits, mu = ln median and
 * sd = ln(p90 / p10) / 2.563). Windows stamps events on its 15.625 ms timer
 * grid, so times are fitted with each stamp spread uniformly over its tick:
 *  - a stroke is lognormal(2.833, 0.27) notches (p10/50/90 11/17/22) over
 *    lognormal(5.064, 0.18) ms (121/158/192);
 *  - re-grip between strokes lognormal(4.258, 0.446) ms (45/71/141, 36 gaps);
 *  - the flick is fastest at the start and slows evenly to the end: notch i of
 *    n clicks at 1 - sqrt(1 - (i + 0.5) / n) of the stroke. In 60 Hz frames
 *    this gives 48/33/14/4% of events 1/2/3/4 notches and 6/8/10 events a
 *    stroke (recorded 41/41/14/4%, 7/9/11), front-loaded as recorded.
 *
 * `macos` is fitted from a notched USB mouse on macOS, Firefox, 1666 wheel
 * events:
 *  - strokes of 3+ frames last lognormal(5.215, 0.552) ms (median 184);
 *  - re-grip between strokes lognormal(4.952, 0.563) ms (median 141);
 *  - a third of strokes are a lone notch;
 *  - macOS frames are 20 ms, ~10% 40 ms (a dropped frame); a stroke starts at
 *    1 line, rises 1-3 lines a frame (sometimes 5) to a peak of 6-13 lines
 *    (median 10) and holds it to the end.
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

const NOTCHES_MU = 2.833
const NOTCHES_SD = 0.27
const FLICK_MU = 5.064
const FLICK_SD = 0.18
const FLICK_REGRIP_MU = 4.258
const FLICK_REGRIP_SD = 0.446
const FRAME_MS = 1000 / 60

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

function notchedPath(target: number, rng: Rng, pxPerNotch: number): ScrollEvent[] {
  const sign = Math.sign(target)
  let left = Math.max(1, Math.round(Math.abs(target) / pxPerNotch))
  // Each event's frame and notch count; the notches of one frame are one event.
  const frames: { frame: number; notches: number }[] = []
  let start = 0
  while (left > 0) {
    const n = Math.min(left, Math.max(1, Math.round(lognormal(rng, NOTCHES_MU, NOTCHES_SD))))
    const duration = clamp(lognormal(rng, FLICK_MU, FLICK_SD), STROKE_MIN_MS, STROKE_MAX_MS)
    const regrip = clamp(lognormal(rng, FLICK_REGRIP_MU, FLICK_REGRIP_SD), REGRIP_MIN_MS, REGRIP_MAX_MS)
    let last = start
    for (let i = 0; i < n; i++) {
      last = start + duration * (1 - Math.sqrt(1 - (i + 0.5) / n))
      const frame = Math.round(last / FRAME_MS)
      if (frames.length > 0 && frames[frames.length - 1].frame === frame) frames[frames.length - 1].notches++
      else frames.push({ frame, notches: 1 })
    }
    left -= n
    start = last + regrip
  }
  // The last event waits out the final re-grip.
  const at = (i: number) => Math.round(i < frames.length ? frames[i].frame * FRAME_MS : start)
  return frames.map(({ notches }, i) => ({ deltaTime: at(i + 1) - at(i), deltaY: sign * notches * pxPerNotch }))
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
