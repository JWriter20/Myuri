import type { Rng } from '../rng.js'
import { gaussian } from '../rng.js'

/**
 * Mouse-button timing: how long a press is held, how long the hand rests
 * between the end of a movement and the press, the gap between the clicks of
 * a double or triple click, and the pauses around a drag.
 *
 * Fitted from a recording of a person doing click tasks in Firefox with a
 * notched USB mouse on a Mac. Recordings made with a trackpad or touchpad are
 * left out: pressing a pad is not pressing a button (a touchpad drag starts a
 * median 160 ms after the press, a mouse drag 36 ms). How long a click is held
 * is the same on all of them (median 93-109 ms), on macOS and Windows alike.
 * Each value is a lognormal in milliseconds with mu at the log median and sd
 * from the 10%-90% quantile span (/2.563), which a few stalled presses cannot
 * drag:
 *  - hold (pointerdown -> pointerup), 110 clicks: mu 4.533, sd 0.21, median
 *    93 ms (p10 68, p90 115);
 *  - hold of a later press of a run (a double or triple click, or rapid
 *    clicks in place: pressed within 500 ms and 4 px of the last release),
 *    130 presses on both OSes with a mouse and a pad: mu 4.419, sd 0.227,
 *    median 83 ms (p10 63, p90 113), against 96 for the first press;
 *  - last pointermove -> pointerdown, 89 clicks: mu 3.717, sd 1.341, median
 *    41 ms (p10 6, p90 259). The cursor often stops, then presses a beat later;
 *  - double/triple click, pointerup -> next pointerdown, 11 gaps: mu 4.353,
 *    sd 0.113, median 78 ms (p10 76, p90 101);
 *  - 16 drags of cards, a box and a slider: press -> first move mu 3.58,
 *    sd 1.004, median 36 ms (p10 7, p90 100); last move -> release mu 3.182,
 *    sd 2.104, median 24 ms (p10 1, p90 246).
 * Draw order matches `myuri/motion/click_model.py`.
 */

const HOLD_MU = 4.533
const HOLD_SD = 0.21
const HOLD_MIN_MS = 35
const HOLD_MAX_MS = 400
const LATER_HOLD_MU = 4.419
const LATER_HOLD_SD = 0.227
const DWELL_MU = 3.717
const DWELL_SD = 1.341
const DWELL_MIN_MS = 4
const DWELL_MAX_MS = 600
const DRAG_START_MU = 3.58
const DRAG_START_SD = 1.004
const DRAG_START_MIN_MS = 4
const DRAG_START_MAX_MS = 500
const DRAG_END_MU = 3.182
const DRAG_END_SD = 2.104
const DRAG_END_MIN_MS = 0
const DRAG_END_MAX_MS = 600
const DRAG_CARRY_MU = -0.288 // ln 0.75
const DRAG_CARRY_SD = 0.25
const MULTI_GAP_MU = 4.353
const MULTI_GAP_SD = 0.113
const MULTI_GAP_MIN_MS = 30
const MULTI_GAP_MAX_MS = 250

function lognormal(rng: Rng, mu: number, sd: number, lo: number, hi: number): number {
  return Math.round(Math.max(lo, Math.min(hi, Math.exp(gaussian(rng, mu, sd)))))
}

/** Milliseconds a mouse button is held down; `later` for a press after the first of a run. */
export function clickHoldMs(rng: Rng, later = false): number {
  return later
    ? lognormal(rng, LATER_HOLD_MU, LATER_HOLD_SD, HOLD_MIN_MS, HOLD_MAX_MS)
    : lognormal(rng, HOLD_MU, HOLD_SD, HOLD_MIN_MS, HOLD_MAX_MS)
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
