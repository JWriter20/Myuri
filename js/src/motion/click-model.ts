import type { Rng } from '../rng.js'
import { gaussian } from '../rng.js'

/**
 * Mouse-button timing: how long a press is held, how long the hand rests
 * between the end of a movement and the press, and the gap between the clicks
 * of a double or triple click.
 *
 * Fitted from four recordings of people doing the same click tasks in Firefox
 * (two Macs and one Windows PC at DPR 1.5 and 1), 330 single clicks and 38 multi-click gaps, all
 * lognormal in milliseconds:
 *  - hold (pointerdown -> pointerup): mu 4.58, sd 0.258, median 97 ms
 *    (per machine 94-109; p5 63, p95 156);
 *  - last mousemove -> pointerdown: mu 3.364, sd 0.935, median 29 ms
 *    (p5 8, p95 154). The cursor often stops, then presses a beat later;
 *  - double/triple click, pointerup -> next pointerdown: mu 4.473, sd 0.264,
 *    median 88 ms (p10 63, p90 110);
 *  - drag (39 drags of cards, a box and a slider): press -> first move mu
 *    4.548, sd 0.566, median 94 ms; last move -> release median 35 ms with a
 *    very wide spread (recorded sd 1.73, partly 0 ms; we draw sd 1.2).
 * Draw order matches `myuri/motion/click_model.py`.
 */

const HOLD_MU = 4.58
const HOLD_SD = 0.258
const HOLD_MIN_MS = 35
const HOLD_MAX_MS = 400
const DWELL_MU = 3.364
const DWELL_SD = 0.935
const DWELL_MIN_MS = 4
const DWELL_MAX_MS = 600
const DRAG_START_MU = 4.548
const DRAG_START_SD = 0.566
const DRAG_START_MIN_MS = 20
const DRAG_START_MAX_MS = 500
const DRAG_END_MU = 3.555
const DRAG_END_SD = 1.2
const DRAG_END_MIN_MS = 0
const DRAG_END_MAX_MS = 600
const DRAG_CARRY_MU = -0.288 // ln 0.75
const DRAG_CARRY_SD = 0.25
const MULTI_GAP_MU = 4.473
const MULTI_GAP_SD = 0.264
const MULTI_GAP_MIN_MS = 30
const MULTI_GAP_MAX_MS = 250

function lognormal(rng: Rng, mu: number, sd: number, lo: number, hi: number): number {
  return Math.round(Math.max(lo, Math.min(hi, Math.exp(gaussian(rng, mu, sd)))))
}

/** Milliseconds a mouse button is held down. */
export function clickHoldMs(rng: Rng): number {
  return lognormal(rng, HOLD_MU, HOLD_SD, HOLD_MIN_MS, HOLD_MAX_MS)
}

/** Milliseconds from the last mouse move to the press. */
export function preClickDwellMs(rng: Rng): number {
  return lognormal(rng, DWELL_MU, DWELL_SD, DWELL_MIN_MS, DWELL_MAX_MS)
}

/** Milliseconds from releasing one click of a double/triple click to pressing the next. */
export function multiClickGapMs(rng: Rng): number {
  return lognormal(rng, MULTI_GAP_MU, MULTI_GAP_SD, MULTI_GAP_MIN_MS, MULTI_GAP_MAX_MS)
}

/** Milliseconds from pressing to the first move of a drag. */
export function dragStartMs(rng: Rng): number {
  return lognormal(rng, DRAG_START_MU, DRAG_START_SD, DRAG_START_MIN_MS, DRAG_START_MAX_MS)
}

/** Milliseconds from the last move of a drag to releasing. */
export function dragEndMs(rng: Rng): number {
  return lognormal(rng, DRAG_END_MU, DRAG_END_SD, DRAG_END_MIN_MS, DRAG_END_MAX_MS)
}

/**
 * Speed factor for the carrying move of a drag. People move slower with a
 * button held: recorded drags took a median 1030-1190 ms (p90 1460-1910)
 * against 850 (p90 1090) at normal pointing speed.
 */
export function dragCarrySpeed(rng: Rng): number {
  return Math.max(0.4, Math.min(1.2, Math.exp(gaussian(rng, DRAG_CARRY_MU, DRAG_CARRY_SD))))
}
