/**
 * Pure planners: the timelines a Cursor plays, without a browser.
 *
 * Each planner takes the random stream as `rng`, a zero-argument function
 * returning a number in [0, 1) (`makeRng(seed)` gives the Mulberry32 stream a
 * Cursor uses; the Python package has the same planners and draws). Times are
 * milliseconds from the start of the plan, non-decreasing and unrounded. The
 * Cursor builds its actions from these same functions, so a planner's output
 * is exactly what a Cursor with the same stream would do.
 *
 * Every planner takes `os`, the OS the browser claims. It changes the shortcut
 * modifier and the wheel (see `target-os.ts`), not a person's timing: the
 * other planners only check it.
 */

import { type Vector, type BoundingBox, overshoot as overshootPoint } from './math.js'
import { type Rng, gaussian } from './rng.js'
import { resolveSettings, type DeepPartial, type MyuriSettings } from './settings.js'
import { checkOs, primaryModifier, type Os } from './target-os.js'
import { trajectory, getRandomBoxPoint, shouldOvershoot, type PlannedPoint } from './geometry.js'
import { clickHoldMs, multiClickGapMs, preClickDwellMs } from './motion/click-model.js'
import { generateWheelPath, type WheelStyle } from './motion/wheel-model.js'
import { scrollModel } from './motion/scroll-model.js'
import { KeystrokeTiming, needsShift, type KeyAction } from './typing/timing.js'
import { drawSessionWpm, planTyping } from './typing/typer.js'
import { DEFAULT_WPM } from './typing/config.js'

export type { PlannedPoint }

// ---- moves ----------------------------------------------------------------

/** Options for {@link planMove}. */
export interface PlanMoveOptions {
  /** The OS the browser claims; checked only, as a move is planned the same on every OS. */
  os?: Os
  /** Speed multiplier (2 = twice as fast). */
  moveSpeed?: number
  /**
   * Overshoot past `end` and correct back. Defaults to whether the move is
   * longer than `settings.overshoot.threshold`.
   */
  overshoot?: boolean
  settings?: DeepPartial<MyuriSettings>
}

/** @internal What a move needs, resolved. */
export interface MoveSpec {
  moveSpeed?: number
  overshoot: boolean
  settings: MyuriSettings['overshoot']
}

/**
 * @internal A move as the Cursor plays it. `settle` maps a point to where the
 * pointer actually ends up (the Cursor clamps and rounds), which is where the
 * correction after an overshoot starts.
 */
export function moveWith(start: Vector, end: Vector, rng: Rng, spec: MoveSpec, settle: (p: Vector) => Vector): PlannedPoint[] {
  if (!spec.overshoot) return trajectory(start, end, spec, rng)
  const { radius, dwell, correctionSpeedFactor } = spec.settings
  const out = trajectory(start, overshootPoint(end, radius, rng), spec, rng)
  const last = out[out.length - 1]
  const resume = last.t + dwell.minMs + rng() * Math.max(0, dwell.maxMs - dwell.minMs)
  const correctionSpeed = (spec.moveSpeed ?? 1) * correctionSpeedFactor
  const back = trajectory(settle(last), end, { moveSpeed: correctionSpeed }, rng)
  return out.concat(back.map((p) => ({ ...p, t: resume + p.t })))
}

/**
 * A human-like move from `start` to `end`, one point a mouse report. The last
 * point is exactly `end`. Off macOS, a Cursor skips a point on the pixel it
 * already sent.
 */
export function planMove(start: Vector, end: Vector, rng: Rng, options: PlanMoveOptions = {}): PlannedPoint[] {
  checkOs(options.os)
  const settings = resolveSettings(options.settings).overshoot
  const overshoot = options.overshoot ?? shouldOvershoot(start, end, settings.threshold)
  return moveWith(start, end, rng, { moveSpeed: options.moveSpeed, overshoot, settings }, (p) => p)
}

/**
 * Where in `box` a person clicks: centre-biased, inside the box's middle
 * (half the width of a small target, three quarters of a large one, 30% of
 * the height), and with `start`, nearer to where the pointer comes from.
 * Integer pixels.
 */
export function planPoint(box: BoundingBox, rng: Rng, options: { start?: Vector } = {}): Vector {
  return getRandomBoxPoint(box, undefined, options.start, undefined, rng)
}

// ---- clicks ---------------------------------------------------------------

/** A planned click: the pause after the last move, then each press. */
export interface ClickPlan {
  /** Last move -> first press. */
  dwellMs: number
  /** [down, up] ms of each press, from the first press's down (0). */
  presses: [downAt: number, upAt: number][]
}

/**
 * @internal Clicks `first`..`last` of a multi-click. `leadMs` comes before
 * the first press: the dwell after the last move for click 1, the gap since
 * the previous release otherwise.
 */
export function clicksWith(rng: Rng, first: number, last: number): { leadMs: number; presses: [number, number][] } {
  let leadMs = first === 1 ? preClickDwellMs(rng) : 0
  const presses: [number, number][] = []
  let at = 0
  for (let count = first; count <= last; count++) {
    if (count > 1) {
      const gap = multiClickGapMs(rng)
      if (count === first) leadMs = gap
      else at += gap
    }
    const up = at + clickHoldMs(rng)
    presses.push([at, up])
    at = up
  }
  return { leadMs, presses }
}

/** A click, double click (`clickCount` 2) or triple click (3). */
export function planClick(rng: Rng, options: { os?: Os; clickCount?: number } = {}): ClickPlan {
  checkOs(options.os)
  const { leadMs, presses } = clicksWith(rng, 1, options.clickCount ?? 1)
  return { dwellMs: leadMs, presses }
}

// ---- keys -----------------------------------------------------------------

/** A key event: at `t` ms, press, release, or insert text no US key types. */
export type KeyStep = [t: number, type: 'down' | 'up' | 'insert', key: string]

const steps = (actions: KeyAction[]): KeyStep[] => actions.map((a) => [a.at, a.type, a.key])

/** Options for the typing planners. */
export interface PlanTypeOptions {
  /** The OS the browser claims. Checked only: timing is the same on every OS. */
  os?: Os
  /** Words per minute this session is drawn around. */
  wpm?: number
}

function session(rng: Rng, options: PlanTypeOptions): KeystrokeTiming {
  checkOs(options.os)
  return new KeystrokeTiming(drawSessionWpm(rng, options.wpm ?? DEFAULT_WPM), rng)
}

/**
 * Typing `text`, with the typos and corrections a person makes. Keys are
 * Playwright key names; Shift is pressed and released as its own key.
 */
export function planType(text: string, rng: Rng, options: PlanTypeOptions & { mistakeMultiplier?: number } = {}): KeyStep[] {
  return steps(planTyping(text, options.mistakeMultiplier ?? 1, rng, session(rng, options)).actions)
}

/**
 * One key or chord in Playwright's notation ('Enter', 'Control+a',
 * 'Meta+Shift+z', 'A'). A key that needs Shift gets it.
 */
export function planPress(key: string, rng: Rng, options: PlanTypeOptions = {}): KeyStep[] {
  const parts = key.split('+')
  // A trailing '+' is the '+' key ('Control++').
  const main = key.endsWith('+') ? '+' : parts.pop()!
  const modifiers = key.endsWith('+') ? parts.slice(0, -2) : parts
  if (needsShift(main) && !modifiers.includes('Shift')) modifiers.push('Shift')
  return steps(session(rng, options).planChord(modifiers, main))
}

/** Select-all on `os`: Cmd+A on macOS, Ctrl+A elsewhere. */
export function planSelectAll(rng: Rng, options: PlanTypeOptions & { os: Os }): KeyStep[] {
  return planPress(`${primaryModifier(options.os)}+a`, rng, options)
}

// ---- wheel ----------------------------------------------------------------

/** @internal How a wheel gesture is drawn, resolved. */
export interface WheelSpec {
  device: 'trackpad' | 'mouse'
  wheel: MyuriSettings['scroll']['wheel']
  speedIrregularity: number
}

/** Chromium ignores very small wheel deltas, so a trackpad's are sent in batches of at least this many px. */
const MIN_TRACKPAD_DELTA = 8

/**
 * @internal One wheel gesture of `distance` px as [at ms, delta px] events:
 * notches for a mouse, a stream of small deltas for a trackpad. `total` is the
 * distance the model planned.
 */
export function wheelWith(distance: number, rng: Rng, spec: WheelSpec): { events: [number, number][]; end: number; total: number } {
  const mouse = spec.device === 'mouse'
  const model = mouse
    ? generateWheelPath(distance, rng, spec.wheel)
    : scrollModel.generateScrollPath(distance, rng, undefined, spec.speedIrregularity)
  const raw: [number, number][] = []
  let end = 0
  let total = 0
  for (const ev of model) {
    total += ev.deltaY
    raw.push([end, ev.deltaY])
    end += ev.deltaTime
  }
  if (mouse) return { events: raw, end, total }
  const events: [number, number][] = []
  let accumulator = 0
  for (const [at, delta] of raw) {
    accumulator += delta
    if (Math.abs(accumulator) >= MIN_TRACKPAD_DELTA) {
      const send = Math.trunc(accumulator)
      accumulator -= send
      events.push([at, send])
    }
  }
  if (Math.abs(Math.round(accumulator)) >= 1) events.push([end, Math.round(accumulator)])
  return { events, end, total }
}

/** A wheel event (`dx`, `dy` px) or a Shift press, at `t` ms. */
export type WheelStep = [type: 'wheel', dx: number, dy: number, t: number] | [type: 'key', key: 'Shift', action: 'down' | 'up', t: number]

// Shift held for a horizontal scroll: Shift down -> first wheel event (lead)
// and last wheel event -> Shift up (trail), lognormal [mu, sd] in ms. Fitted
// by maximum likelihood to the only five Shift+wheel gestures recorded (both
// Macs and the Windows PC), medians 1122 and 1811 ms: few, so rough.
const SHIFT_WHEEL_LEAD: [number, number] = [7.023, 0.411]
const SHIFT_WHEEL_TRAIL: [number, number] = [7.501, 0.559]

/** Options for {@link planWheel}. */
export interface PlanWheelOptions {
  /** The OS the browser claims: it picks the mouse wheel's style and where a sideways delta goes. */
  os?: Os
  /** Defaults to `settings.scroll.device` ('trackpad'). */
  device?: 'trackpad' | 'mouse'
  settings?: DeepPartial<MyuriSettings>
}

/**
 * @internal A mouse wheel's style: an explicit setting, else the OS's. macOS
 * turns notches into accelerated line scrolls in 20 ms frames (`macos`);
 * Windows and Linux send one 100 px event a notch (`notched`, the default).
 */
export function wheelStyleFor(os: Os | undefined, settings: DeepPartial<MyuriSettings> | undefined): WheelStyle {
  checkOs(os)
  return settings?.scroll?.wheel?.style ?? (os === 'macos' ? 'macos' : 'notched')
}

/**
 * Scrolling `deltaY` px down (negative: up), then `deltaX` px right (negative:
 * left). The horizontal part is Shift held around wheel events, as people
 * scroll sideways with a mouse. On macOS the OS turns them horizontal, so the
 * events carry `dx`; elsewhere Firefox does, so they carry the delta in `dy`.
 */
export function planWheel(deltaX: number, deltaY: number, rng: Rng, options: PlanWheelOptions = {}): WheelStep[] {
  const settings = resolveSettings(options.settings)
  const spec: WheelSpec = {
    device: options.device ?? settings.scroll.device,
    wheel: { ...settings.scroll.wheel, style: wheelStyleFor(options.os, options.settings) },
    speedIrregularity: settings.scroll.realism.speedIrregularity,
  }
  const out: WheelStep[] = []
  let t = 0
  if (deltaY !== 0) {
    const { events, end } = wheelWith(deltaY, rng, spec)
    for (const [at, d] of events) out.push(['wheel', 0, d, at])
    t = end
  }
  if (deltaX !== 0) {
    out.push(['key', 'Shift', 'down', t])
    t += Math.exp(gaussian(rng, ...SHIFT_WHEEL_LEAD))
    const { events } = wheelWith(deltaX, rng, spec)
    for (const [at, d] of events) out.push(options.os === 'macos' ? ['wheel', d, 0, t + at] : ['wheel', 0, d, t + at])
    t = out[out.length - 1][3] + Math.exp(gaussian(rng, ...SHIFT_WHEEL_TRAIL))
    out.push(['key', 'Shift', 'up', t])
  }
  return out
}

export { SCROLL_PLAN_JS, SCROLL_FINISH_POSITION, SCROLL_PAD, SCROLL_EDGE, type ScrollPlan, type ScrollPlanArgs } from './scroll-plan.js'
