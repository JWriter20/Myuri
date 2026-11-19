/**
 * Keystroke timing: when every keydown and keyup happens.
 *
 * The Markov engine (`markov.ts`) decides WHAT gets typed — the target text
 * plus typos, swaps and backspace corrections. This module decides WHEN: it
 * turns that key sequence into an absolute timeline of keydown/keyup actions,
 * including explicit Shift presses, so keys overlap the way real typing does.
 *
 * The model was fitted on recorded human typing (one typist, three machines,
 * 1268 key pairs, Nov 2026) and on John Burkardt's English bigram counts
 * (`bigrams.ts`). It works in log space on the keydown-to-keydown interval:
 *
 *   log(gap) = BASE
 *            + BIGRAM * (log10 share(prev, cur) - mean)   letters only
 *            + same finger / repeated key / row jump      QWERTY touch typing
 *            + Shift (when cur needs Shift and prev did not)
 *            + context (word start, punctuation, digits, noticing a typo, ...)
 *            + noise (normal core + an occasional pause) + slow speed drift
 *
 * then scales every gap so the mean matches the requested WPM. Hold times
 * (keydown to keyup) are drawn on their own per key class, so the next key often
 * goes down before the previous one is released ("rollover", ~35% of pairs in
 * the recordings) without being modelled explicitly.
 *
 * Draw order is fixed and mirrored in `python/src/myuri/typing_engine/timing.py`.
 */

import { gaussian } from '../rng.js'
import type { Rng } from '../rng.js'
import { BIGRAM_TABLE_B64, BIGRAM_MEAN_LOG10 } from './bigrams.js'

// ---- fitted constants (log-space coefficients on the gap in ms) ----

/** Intercept: an in-word letter pair of average English frequency (~101 ms). */
const BASE = 4.618
/** Per decade of bigram frequency: 10x more common pair -> gap x0.71. */
const BIGRAM = -0.338
const SAME_FINGER = 0.289
const REPEAT = 0.178
const ROW_JUMP = 0.04
/** Gap before a key that needs Shift (the Shift press is inside this gap). */
const SHIFTED = 0.976

const CONTEXT = {
  inWord: 0,
  wordStart: 0.788,
  toSpace: 0.071,
  // Only two Enter presses were recorded; set between punctuation and a typo.
  toEnter: 1.2,
  toDigit: 1.848,
  digitRun: 0.301,
  toPunct: 1.045,
  fromPunct: 1.316,
  bsNotice: 1.378,
  bsRepeat: 0.449,
  afterBs: 0.657,
} as const
type Context = keyof typeof CONTEXT

// Noise on log(gap): normal core plus, 6% of the time, a pause. The fit to the
// regression residual quantiles (1%..99%) gave 8% at mean 1.2; pauses are a little
// rarer and shorter by default, because the fitted ones read as stalls on screen.
const NOISE_SD = 0.48
const PAUSE_PROB = 0.06
const PAUSE_MEAN = 1.0
const PAUSE_SD = 0.5
// Slow speed drift: AR(1) on log speed, stationary sd ~0.12.
const DRIFT_RHO = 0.97
const DRIFT_STEP_SD = 0.03

const MIN_GAP_MS = 10
const MAX_GAP_MS = 5000

// Hold (keydown -> keyup), lognormal: [median ms, sigma].
const HOLD: Record<'key' | 'space' | 'backspace' | 'enter', [number, number]> = {
  key: [100, 0.28],
  space: [80, 0.22],
  backspace: [85, 0.45],
  enter: [95, 0.25],
}
const MIN_HOLD_MS = 25
const MAX_HOLD_MS = 400
/** People differ in how long they hold keys: per-session factor sd (log). */
const SESSION_HOLD_SD = 0.12
/** Holds shrink with speed, but much less than gaps (hold ~ speed^0.3). */
const HOLD_SPEED_EXPONENT = 0.3

// Shift: down `lead` ms before its key (median ~115, recorded 5%..95% = 48..550),
// up a little before that key's own keyup (median -15 ms, ~60% of the time).
const SHIFT_LEAD_MEDIAN = 115
const SHIFT_LEAD_SD = 0.6
const SHIFT_LEAD_MIN = 30
const SHIFT_TRAIL_MEAN = -15
const SHIFT_TRAIL_SD = 35
/** Shift stays down at least this long after its key goes down. */
const SHIFT_MIN_AFTER_KEY = 20
/** Shift is always released this long before the next unshifted keydown. */
const SHIFT_CLEAR = 8
/** A key cannot go down again until this long after it came up. */
const SAME_KEY_CLEAR = 8

/**
 * Reference English (a few sentences with capitals, digits and punctuation).
 * The model's expected mean gap over it maps to the requested WPM, so a given
 * WPM means the same speed whatever the coefficients are.
 */
const REFERENCE_TEXT =
  'The quick check took about 20 minutes, so we moved on. Please send the ' +
  'report to the team before Friday; they need it for the meeting at 3pm. ' +
  'I think it looks good, but there are a few things we should fix first. ' +
  'Thanks again for your help with this! Let me know if anything changes.'

// ---- keyboard geometry (US QWERTY touch typing) ----

const UNSHIFT: Record<string, string> = {}
{
  const shifted = '~!@#$%^&*()_+{}|:"<>?'
  const plain = "`1234567890-=[]\\;',./"
  for (let i = 0; i < shifted.length; i++) UNSHIFT[shifted[i]] = plain[i]
}
const FINGER: Record<string, number> = {}
const ROW: Record<string, number> = {}
{
  const left = ['`12345', 'qwert', 'asdfg', 'zxcvb']
  const right = ['67890-=', 'yuiop[]\\', "hjkl;'", 'nm,./']
  for (const row of left) {
    const fingers = row[0] === '`' ? [0, 0, 1, 2, 3, 3] : [0, 1, 2, 3, 3]
    for (let i = 0; i < row.length; i++) FINGER[row[i]] = fingers[i]
  }
  const rightFingers = [4, 4, 5, 6, 7, 7, 7, 7]
  for (const row of right) for (let i = 0; i < row.length; i++) FINGER[row[i]] = rightFingers[i]
  const rows = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./']
  rows.forEach((row, r) => {
    for (const c of row) ROW[c] = r
  })
}

const BIGRAM_LOG10: Float64Array = (() => {
  const bin = atobPortable(BIGRAM_TABLE_B64)
  const out = new Float64Array(676)
  for (let i = 0; i < 676; i++) out[i] = -bin.charCodeAt(i) / 20
  return out
})()

function atobPortable(b64: string): string {
  if (typeof atob === 'function') return atob(b64)
  // Node < 16 fallback.
  return (globalThis as unknown as { Buffer: { from(s: string, e: string): { toString(e: string): string } } })
    .Buffer.from(b64, 'base64')
    .toString('latin1')
}

// ---- key classification ----

/** One key press in the sequence to plan. */
export interface Stroke {
  /** Key name for the driver: a printable character, 'Enter', 'Tab' or 'Backspace'. */
  key: string
  /**
   * True for a code point no US key produces (emoji, 'é'): it is inserted as
   * text at its keydown time, with no keyup and no Shift.
   */
  insert?: boolean
}

/** One scheduled input action, `at` ms after the plan starts. */
export interface KeyAction {
  at: number
  type: 'down' | 'up' | 'insert'
  key: string
  /** Index of the stroke this action belongs to (absent for Shift). */
  stroke?: number
}

/** Physical key a character is on (lowercase, unshifted), or the key name. */
function physical(key: string): string {
  if (key.length !== 1) return key
  const lower = key.toLowerCase()
  return UNSHIFT[lower] ?? lower
}

/** Whether typing `key` on US QWERTY needs Shift held. */
export function needsShift(key: string): boolean {
  if (key.length !== 1) return false
  if (key >= 'A' && key <= 'Z') return true
  return key in UNSHIFT
}

function isLetter(c: string): boolean {
  return c.length === 1 && c >= 'a' && c <= 'z'
}
function isDigit(c: string): boolean {
  return c.length === 1 && c >= '0' && c <= '9'
}
function isAlnum(c: string): boolean {
  return c.length === 1 && (isDigit(c) || (c.toLowerCase() >= 'a' && c.toLowerCase() <= 'z'))
}

/** Context class of the gap that ends at `cur` (mirrors the fitting script). */
function contextOf(prev: Stroke, cur: Stroke): Context {
  const p = prev.key
  const c = cur.key
  if (c === 'Backspace') return p === 'Backspace' ? 'bsRepeat' : 'bsNotice'
  if (p === 'Backspace') return 'afterBs'
  if (c === ' ') return 'toSpace'
  if (c === 'Enter' || c === 'Tab') return 'toEnter'
  if (p === ' ' || p === 'Enter' || p === 'Tab') return 'wordStart'
  if (cur.insert) return 'toPunct'
  if (isDigit(c)) return isDigit(p) ? 'digitRun' : 'toDigit'
  if (c.length === 1 && !isAlnum(c)) return 'toPunct'
  if (prev.insert || (p.length === 1 && !isAlnum(p)) || isDigit(p)) return 'fromPunct'
  return 'inWord'
}

/** Deterministic part of log(gap) for the pair (prev -> cur). */
function logGapMean(prev: Stroke, cur: Stroke): number {
  let mu = BASE + CONTEXT[contextOf(prev, cur)]
  if (cur.insert || prev.insert) return mu
  const a = physical(prev.key)
  const b = physical(cur.key)
  if (isLetter(a) && isLetter(b)) {
    const share = BIGRAM_LOG10[(a.charCodeAt(0) - 97) * 26 + (b.charCodeAt(0) - 97)]
    mu += BIGRAM * (share - BIGRAM_MEAN_LOG10)
  }
  const fa = FINGER[a]
  const fb = FINGER[b]
  if (fa !== undefined && fa === fb && a !== b) mu += SAME_FINGER
  if (a === b && a.length === 1) mu += REPEAT
  if (ROW[a] !== undefined && ROW[b] !== undefined) mu += ROW_JUMP * Math.abs(ROW[a] - ROW[b])
  if (needsShift(cur.key) && !needsShift(prev.key)) mu += SHIFTED
  return mu
}

function holdClass(key: string): keyof typeof HOLD {
  if (key === ' ') return 'space'
  if (key === 'Backspace') return 'backspace'
  if (key === 'Enter' || key === 'Tab') return 'enter'
  return 'key'
}

/** Split text into strokes the way the typer presses them. */
export function strokesForText(text: string): Stroke[] {
  return Array.from(text).map(charToStroke)
}

export function charToStroke(char: string): Stroke {
  if (char === '\n') return { key: 'Enter' }
  if (char === '\t') return { key: 'Tab' }
  if (/^[\x20-\x7e]$/.test(char)) return { key: char }
  return { key: char, insert: true }
}

/** E[exp(noise)] for the noise + drift above (analytic). */
const NOISE_MEAN_FACTOR =
  Math.exp((NOISE_SD * NOISE_SD) / 2) *
  (1 - PAUSE_PROB + PAUSE_PROB * Math.exp(PAUSE_MEAN + (PAUSE_SD * PAUSE_SD) / 2)) *
  Math.exp((DRIFT_STEP_SD * DRIFT_STEP_SD) / (1 - DRIFT_RHO * DRIFT_RHO) / 2)

/** Model mean gap (ms) over the reference text at scale 1. */
const REFERENCE_MEAN_GAP_MS = (() => {
  const s = strokesForText(REFERENCE_TEXT)
  let sum = 0
  for (let i = 1; i < s.length; i++) sum += Math.exp(logGapMean(s[i - 1], s[i]))
  return (sum / (s.length - 1)) * NOISE_MEAN_FACTOR
})()

/** Mean keydown-to-keydown gap for a WPM (5 characters per word). */
export function meanGapForWpm(wpm: number): number {
  return 12000 / wpm
}

/**
 * Stateful keystroke timing for one typing session. Keep one per typist so the
 * speed drift and hold style carry over between fields.
 */
export class KeystrokeTiming {
  private rng: Rng
  private scale: number
  private holdFactor: number
  private drift = 0

  constructor(wpm: number, rng: Rng) {
    this.rng = rng
    this.scale = meanGapForWpm(wpm) / REFERENCE_MEAN_GAP_MS
    this.holdFactor = Math.exp(gaussian(rng, 0, SESSION_HOLD_SD))
  }

  /** Change the speed (keeps drift and hold style). */
  setWpm(wpm: number): void {
    this.scale = meanGapForWpm(wpm) / REFERENCE_MEAN_GAP_MS
  }

  /** One sampled keydown-to-keydown gap, ms. */
  gap(prev: Stroke, cur: Stroke): number {
    this.drift = DRIFT_RHO * this.drift + gaussian(this.rng, 0, DRIFT_STEP_SD)
    let noise = gaussian(this.rng, 0, NOISE_SD)
    if (this.rng() < PAUSE_PROB) noise += Math.max(0, gaussian(this.rng, PAUSE_MEAN, PAUSE_SD))
    const ms = this.scale * Math.exp(logGapMean(prev, cur) + noise + this.drift)
    return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, ms))
  }

  /** One sampled hold (keydown to keyup), ms. */
  hold(key: string): number {
    const [median, sd] = HOLD[holdClass(key)]
    const ms =
      median *
      this.holdFactor *
      Math.pow(this.scale, HOLD_SPEED_EXPONENT) *
      Math.exp(gaussian(this.rng, 0, sd))
    return Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, ms))
  }

  private shiftLead(): number {
    return Math.max(SHIFT_LEAD_MIN, SHIFT_LEAD_MEDIAN * Math.exp(gaussian(this.rng, 0, SHIFT_LEAD_SD)))
  }

  /**
   * Plan `strokes` as an absolute timeline starting at 0. `after` is the stroke
   * typed just before this sequence (for the first gap's context), if any; with
   * none, the first key goes down at 0 (or after its Shift lead).
   *
   * Returns the actions sorted by time and, per stroke, its keydown time.
   */
  plan(strokes: Stroke[], after?: Stroke): { actions: KeyAction[]; downAt: number[] } {
    const actions: (KeyAction & { seq: number })[] = []
    let seq = 0
    const push = (at: number, type: KeyAction['type'], key: string, stroke?: number) => {
      actions.push({ at, type, key, stroke, seq: seq++ })
    }
    const downAt: number[] = []
    // Per physical key, its last press (to end it before the key goes down again).
    const lastPress = new Map<string, { down: number; up: number }>()
    let shiftHeld = false
    let lastShiftedDown = 0
    let lastShiftedUp = 0

    const releaseShift = (notAfter: number) => {
      let at = lastShiftedUp + gaussian(this.rng, SHIFT_TRAIL_MEAN, SHIFT_TRAIL_SD)
      at = Math.max(at, lastShiftedDown + SHIFT_MIN_AFTER_KEY)
      at = Math.min(at, notAfter)
      push(at, 'up', 'Shift')
      shiftHeld = false
    }

    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i]
      const prev = i > 0 ? strokes[i - 1] : after
      // The very first key of a session has no gap before it.
      const cold = i === 0 && !prev
      let t = prev ? (i > 0 ? downAt[i - 1] : 0) + this.gap(prev, s) : 0
      const shifted = !s.insert && needsShift(s.key)

      if (!shifted && shiftHeld) {
        // Shift must be up before this key goes down.
        t = Math.max(t, lastShiftedDown + SHIFT_MIN_AFTER_KEY + SHIFT_CLEAR)
        releaseShift(t - SHIFT_CLEAR)
      }
      if (shifted && !shiftHeld) {
        const lead = this.shiftLead()
        const floor = i > 0 ? downAt[i - 1] + 10 : 0
        if (cold) t = lead
        const shiftAt = Math.max(floor, t - lead)
        t = Math.max(t, shiftAt + SHIFT_LEAD_MIN)
        push(shiftAt, 'down', 'Shift')
        shiftHeld = true
      }

      // A key cannot go down while it is still held from its last press.
      const last = s.insert ? undefined : lastPress.get(physical(s.key))
      if (last) {
        const prevUp = actions[last.up]
        const latestUp = t - SAME_KEY_CLEAR
        if (prevUp.at > latestUp) {
          const earliestUp = last.down + MIN_HOLD_MS
          if (latestUp >= earliestUp) prevUp.at = latestUp
          else {
            prevUp.at = earliestUp
            t = earliestUp + SAME_KEY_CLEAR
          }
        }
      }

      downAt.push(t)
      if (s.insert) {
        push(t, 'insert', s.key, i)
        continue
      }
      push(t, 'down', s.key, i)
      const up = t + this.hold(s.key)
      lastPress.set(physical(s.key), { down: t, up: actions.length })
      push(up, 'up', s.key, i)
      if (shifted) {
        lastShiftedDown = t
        lastShiftedUp = up
      }
    }
    if (shiftHeld) releaseShift(Number.POSITIVE_INFINITY)

    actions.sort((x, y) => x.at - y.at || x.seq - y.seq)
    return { actions: actions.map(({ seq: _seq, ...a }) => a), downAt }
  }

  /**
   * A chord such as Control+a or Meta+Shift+z: each modifier goes down a
   * Shift-like lead after the one before, the key after the last, and each
   * modifier comes up just after the key does (innermost first).
   */
  planChord(modifiers: readonly string[], key: string): KeyAction[] {
    const out: KeyAction[] = []
    let at = 0
    modifiers.forEach((m, i) => {
      if (i > 0) at += this.shiftLead()
      out.push({ at, type: 'down', key: m })
    })
    const keyDown = modifiers.length ? at + this.shiftLead() : 0
    const keyUp = keyDown + this.hold(key)
    out.push({ at: keyDown, type: 'down', key }, { at: keyUp, type: 'up', key })
    for (const m of [...modifiers].reverse()) {
      const up = Math.max(keyDown + SHIFT_MIN_AFTER_KEY, keyUp + gaussian(this.rng, SHIFT_TRAIL_MEAN, SHIFT_TRAIL_SD))
      out.push({ at: up, type: 'up', key: m })
    }
    return out.sort((x, y) => x.at - y.at)
  }

  /** Select-all with `modifier`, then one Backspace once the modifier is up. */
  planSelectAllDelete(modifier: string): KeyAction[] {
    const out = this.planChord([modifier], 'a')
    const aDown = out.find((a) => a.type === 'down' && a.key === 'a')!.at
    const modUp = out.find((a) => a.type === 'up' && a.key === modifier)!.at
    const bsDown = Math.max(aDown + this.gap({ key: 'a' }, { key: 'Backspace' }), modUp + SHIFT_CLEAR)
    out.push({ at: bsDown, type: 'down', key: 'Backspace' })
    out.push({ at: bsDown + this.hold('Backspace'), type: 'up', key: 'Backspace' })
    return out.sort((x, y) => x.at - y.at)
  }
}

/** Exposed for tests and the fitting notes. */
export const _internals = { logGapMean, contextOf, REFERENCE_MEAN_GAP_MS, NOISE_MEAN_FACTOR }
