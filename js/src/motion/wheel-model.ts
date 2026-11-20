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
 *    100; `strokeScale` fits a flick's notches to a page that moves more or less
 *    than that a notch, so a stroke covers a recorded one's px). The page takes a
 *    fast flick's notches one display frame at a time, so the notches that land
 *    in one 60 Hz frame arrive as one event of 2-4 notches. (Firefox merges
 *    wheel events only while the page is behind, which a browser driven one
 *    wheel call at a time never is, so the planner merges them.)
 *  - `macos`: macOS reports the wheel in 20 ms frames and accelerates a fast
 *    roll. A stroke starts at one line a frame and climbs to ~10, `pxPerLine`
 *    (default 16) each.
 *
 * `notched` is fitted from a notched USB mouse on Windows, Firefox, scrolling
 * to a target (finding a button, a box to accept, a product), split into
 * strokes at gaps over 40 ms (21 strokes of 3+ notches, 26 re-grips; robust
 * lognormal fits, mu = ln median and sd = ln(p90 / p10) / 2.563). Spinning the
 * wheel on request gives strokes twice as long and re-grips half as long, and
 * reading an article gives lone notches; neither is what a scroll to a target
 * does. Windows stamps events on its 15.625 ms timer grid, so times are fitted
 * with each stamp spread uniformly over its tick:
 *  - a stroke is lognormal(2.079, 0.342) notches (p10/50/90 5/8/12) over
 *    lognormal(4.828, 0.352) ms (62/125/153);
 *  - re-grip between strokes lognormal(4.828, 0.727) ms (47/125/303);
 *  - the flick is fastest at the start and slows evenly to the end: notch i of
 *    n clicks at 1 - sqrt(1 - (i + 0.5) / n) of the stroke. In 60 Hz frames
 *    this gives 70/23/5% of events 1/2/3 notches and 3/6/8 events a stroke
 *    (recorded 67/31/1%, 4/7/8);
 *  - a short stroke takes at most two frames a notch: recorded strokes of 2-10
 *    notches arrive about one notch a 15.6 ms tick;
 *  - scrolls of 7-69 notches take 0.93x the planned median (recorded 0.17-1.9 s);
 *  - a scroll of up to 7 notches is nudged, not flicked: all 9 recorded opened
 *    with a lone notch, then strokes of 1-5 notches (median 2), re-gripping
 *    lognormal(4.258, 0.446) ms (45/71/141) between them.
 *
 * `macos` is fitted from a notched USB mouse on macOS, Firefox, 1666 wheel
 * events:
 *  - strokes of 3+ frames last lognormal(5.215, 0.552) ms (median 184);
 *  - re-grip between strokes lognormal(4.952, 0.563) ms (median 141);
 *  - a third of strokes are a lone notch;
 *  - macOS frames are 20 ms, ~10% 40 ms (a dropped frame); a stroke starts at
 *    1 line, rises 1-3 lines a frame (sometimes 5) to a peak of 6-13 lines
 *    (median 10) and holds it to the end;
 *  - macOS keeps the speed across a re-grip of up to 140 ms: the next stroke
 *    starts at the last frame's lines (55%) or one fewer (45%), in 81% of 83
 *    such re-grips; after 160 ms or more it always starts again at 1 line.
 */

export type WheelStyle = 'notched' | 'macos'

export interface WheelOptions {
  style?: WheelStyle
  /** Pixels per notch (`notched`). */
  pxPerNotch?: number
  /** Pixels per line (`macos`). */
  pxPerLine?: number
  /**
   * Scales the notches of a flick (`notched`), so a flick covers as many page
   * px as a recorded one when a notch moves the page more or less than
   * `pxPerNotch`: pass the wheel px a page px takes (0.76 where a 100 px notch
   * moves the page 132 px). Default 1.
   */
  strokeScale?: number
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

const NOTCHES_MU = 2.079
const NOTCHES_SD = 0.342
const FLICK_MU = 4.828
const FLICK_SD = 0.352
const FLICK_REGRIP_MU = 4.828
const FLICK_REGRIP_SD = 0.727
const FRAME_MS = 1000 / 60
const NOTCH_MAX_MS = 2 * FRAME_MS
const NUDGE_MAX_NOTCHES = 7
const NUDGE_MU = Math.log(2)
const NUDGE_SD = 0.54
const NUDGE_REGRIP_MU = 4.258
const NUDGE_REGRIP_SD = 0.446

const MAC_FRAME_MS = 20
const MAC_DROPPED_FRAME_PROBABILITY = 0.1
const MAC_PEAK_MEAN = 10
const MAC_PEAK_SD = 1.6
const MAC_PEAK_MIN = 6
const MAC_PEAK_MAX = 13
const MAC_CARRY_MS = 150
const MAC_CARRY_DROP_PROBABILITY = 0.45

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function lognormal(rng: Rng, mu: number, sd: number): number {
  return Math.exp(gaussian(rng, mu, sd))
}

function notchedPath(target: number, rng: Rng, pxPerNotch: number, strokeScale: number): ScrollEvent[] {
  const sign = Math.sign(target)
  let left = Math.max(1, Math.round(Math.abs(target) / pxPerNotch))
  // Each event's frame and notch count; the notches of one frame are one event.
  const frames: { frame: number; notches: number }[] = []
  let start = 0
  const nudged = left <= NUDGE_MAX_NOTCHES
  while (left > 0) {
    const size = nudged
      ? frames.length === 0 ? 1 : lognormal(rng, NUDGE_MU, NUDGE_SD)
      : lognormal(rng, NOTCHES_MU, NOTCHES_SD) * strokeScale
    const n = Math.min(left, Math.max(1, Math.round(size)))
    const duration = Math.min(n * NOTCH_MAX_MS, clamp(lognormal(rng, FLICK_MU, FLICK_SD), STROKE_MIN_MS, STROKE_MAX_MS))
    const regrip = nudged
      ? clamp(lognormal(rng, NUDGE_REGRIP_MU, NUDGE_REGRIP_SD), REGRIP_MIN_MS, REGRIP_MAX_MS)
      : clamp(lognormal(rng, FLICK_REGRIP_MU, FLICK_REGRIP_SD), REGRIP_MIN_MS, REGRIP_MAX_MS)
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
  let lines = 0
  while (left > 0) {
    let frames: number
    if (rng() < LONE_NOTCH_PROBABILITY) {
      frames = 1
    } else {
      const duration = clamp(lognormal(rng, STROKE_MU, STROKE_SD), STROKE_MIN_MS, STROKE_MAX_MS)
      frames = Math.max(2, Math.round(duration / MAC_FRAME_MS))
    }
    // A stroke after a short re-grip goes on at the speed macOS kept.
    lines = lines > 0 ? Math.max(1, lines - (rng() < MAC_CARRY_DROP_PROBABILITY ? 1 : 0)) : 1
    const peak = Math.max(lines, Math.round(clamp(gaussian(rng, MAC_PEAK_MEAN, MAC_PEAK_SD), MAC_PEAK_MIN, MAC_PEAK_MAX)))
    for (let f = 0; f < frames && left > 0; f++) {
      if (f > 0) {
        const step = rng() < 0.2 ? 5 : 1 + Math.floor(rng() * 3)
        lines = Math.min(peak, lines + step)
      }
      const sent = Math.min(lines, left)
      left -= sent
      const last = f + 1 === frames || left === 0
      const gap = Math.round(
        last
          ? clamp(lognormal(rng, REGRIP_MU, REGRIP_SD), REGRIP_MIN_MS, REGRIP_MAX_MS)
          : rng() < MAC_DROPPED_FRAME_PROBABILITY ? 2 * MAC_FRAME_MS : MAC_FRAME_MS,
      )
      events.push({ deltaTime: gap, deltaY: sign * sent * pxPerLine })
      if (last && gap > MAC_CARRY_MS) lines = 0
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
    : notchedPath(desiredD, rng, options?.pxPerNotch ?? 100, options?.strokeScale ?? 1)
}
