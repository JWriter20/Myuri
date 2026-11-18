/**
 * Smart actions: clicking, scrolling and typing as a person does, on any host.
 *
 * {@link Actions} owns the timing and motion of every input, and the decisions
 * around a click: scroll the element into view, choose a point a person would,
 * check that a press there reaches the element, and try again when it does
 * not. The host owns the shape of each event: it sends a move, press or key
 * however its browser takes them. The Python package has the same actions,
 * with the same draws from the same stream.
 *
 * The parts ({@link PARTS}) are the steps an action is built from. Pass
 * `parts` to replace any of them; the rest, and the actions that call them,
 * stay myuri's. A part is called as `fn(host, ...args, { default, rng, play })`:
 *
 * - `move(x, y)`: move the cursor to (x, y).
 * - `press(button, clickCount)`: press where the cursor is.
 * - `point(box, attempt)`: the `{ x, y }` in a box to press.
 * - `reaches(target, x, y, pressing)`: why a press at (x, y) would miss
 *   `target`, or null.
 * - `intoView(target)`: scroll `target` into view.
 * - `wheel(dx, dy)`: turn the wheel.
 * - `type(text)` and `key(key)`: type text, or press a key or chord.
 *
 * `default(...args)` runs myuri's part (with the same arguments when given
 * none), `rng` is the action stream, and `play(steps)` plays a timeline (see
 * {@link validateSteps}).
 */

import { getRandomBoxPoint, shouldOvershoot } from './geometry.js'
import type { BoundingBox, Vector } from './math.js'
import { HIT_TEST_JS, type HitTestArgs } from './page-functions.js'
import { CLICK_RUN_MS, type KeyStep, moveWith, planClick, planPoint, planPress, planType, wheelSteps, wheelStyleFor } from './plan.js'
import type { Rng } from './rng.js'
import { SCROLL_EDGE, SCROLL_FINISH_POSITION, SCROLL_PAD, SCROLL_PLAN_JS, type ScrollPlan, type ScrollPlanArgs } from './scroll-plan.js'
import { type DeepPartial, type MyuriSettings, resolveSettings } from './settings.js'
import { checkOs, type Os } from './target-os.js'

export type Button = 'left' | 'right' | 'middle'

/** A timeline step; `t` is milliseconds from the start of the timeline. */
export type Step =
  | [kind: 'move', x: number, y: number, t: number]
  | [kind: 'down' | 'up', button: Button, t: number]
  | [kind: 'wheel', dx: number, dy: number, t: number]
  | [kind: 'key', key: string, action: 'down' | 'up', t: number]
  | [kind: 'text', text: string, t: number]

type Awaitable<R> = R | Promise<R>

/** What {@link Actions} drives. `T` is what the host takes as a target. */
export interface Host<T = unknown> {
  move(x: number, y: number): Awaitable<unknown>
  /** Press and release, holding the button `holdMs`; `clickCount` is the press's place in a run. */
  click(button: Button, clickCount: number, holdMs: number): Awaitable<unknown>
  down(button: Button): Awaitable<unknown>
  up(button: Button): Awaitable<unknown>
  wheel(dx: number, dy: number): Awaitable<unknown>
  keyDown(key: string): Awaitable<unknown>
  keyUp(key: string): Awaitable<unknown>
  insertText(text: string): Awaitable<unknown>
  /** Run the page function `(el, arg) => ...` on the target's element, in its own window. */
  evaluate<A, R>(target: T, fn: (el: any, arg: A) => R, arg: A): Awaitable<R>
  /** `[dx, dy]` from the target's window to the page, or null when the target has no element. */
  offset(target: T): Awaitable<[number, number] | null>
  /** `[width, height]` of the page. */
  viewport(): Awaitable<[number, number]>
  /** Milliseconds on a monotonic clock. */
  now(): number
  sleep(ms: number): Awaitable<unknown>
}

/** What a part is given after its arguments. */
export interface PartContext<R> {
  /** myuri's part, with the same arguments when given none. */
  default: (...args: any[]) => Promise<R>
  rng: Rng
  play: (steps: Step[]) => Promise<void>
}

/** The parts an {@link Actions} can take in place of its own. */
export interface Parts<T = unknown> {
  move?: (host: Host<T>, x: number, y: number, ctx: PartContext<void>) => Awaitable<unknown>
  press?: (host: Host<T>, button: Button, clickCount: number, ctx: PartContext<void>) => Awaitable<unknown>
  point?: (host: Host<T>, box: BoundingBox, attempt: number, ctx: PartContext<Vector>) => Awaitable<Vector>
  reaches?: (host: Host<T>, target: T, x: number, y: number, pressing: boolean, ctx: PartContext<string | null>) => Awaitable<string | null>
  intoView?: (host: Host<T>, target: T, ctx: PartContext<void>) => Awaitable<unknown>
  wheel?: (host: Host<T>, dx: number, dy: number, ctx: PartContext<void>) => Awaitable<unknown>
  type?: (host: Host<T>, text: string, ctx: PartContext<void>) => Awaitable<unknown>
  key?: (host: Host<T>, key: string, ctx: PartContext<void>) => Awaitable<unknown>
}

export const PARTS = ['move', 'press', 'point', 'reaches', 'intoView', 'wheel', 'type', 'key'] as const

/** The waits between attempts at a click, as Playwright waits between attempts at an action. */
export const RETRY_MS = [0, 20, 100, 100, 500]

/** Scroll plans played before an element is taken as in view (one that moves as it scrolls needs more than one). */
export const SCROLL_PASSES = 3

/** How often a wheel's scroll is checked for having landed, and how long it may take. */
export const LANDING_MS = [50, 1000] as const

const BUTTONS: Button[] = ['left', 'right', 'middle']

/** A click could not reach its element; the message says why. */
export class Missed extends Error {
  override name = 'Missed'
}

/** A scroll plan, in page px. */
export type Measured = ScrollPlan

/** Options for {@link Actions}. */
export interface ActionsOptions<T> {
  /** The OS the browser claims. */
  os?: Os
  settings?: DeepPartial<MyuriSettings>
  /** What the wheel is; defaults to `settings.scroll.device`. */
  device?: 'mouse' | 'trackpad'
  /** Typing speed; defaults to `settings.typing.wpm`. */
  wpm?: number
  parts?: Parts<T>
}

/** Options for {@link Actions.click}. */
export interface ClickOptions {
  button?: Button
  clickCount?: number
  modifiers?: string[]
  /** A point from the element's padding box, as Playwright takes it. */
  position?: { x: number; y: number }
  force?: boolean
  press?: boolean
  /** ms; 0 or undefined: no limit. */
  timeout?: number
  attempts?: number
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * The steps of a timeline as `[kind, values, t]`, or an Error naming the first
 * bad step. Nothing is played unless every step is valid.
 *
 *     ['move', x, y, t]   ['down', button, t]   ['up', button, t]
 *     ['wheel', dx, dy, t]   ['key', key, 'down' | 'up', t]   ['text', text, t]
 *
 * t is milliseconds from the start of the timeline, non-decreasing.
 */
export function validateSteps(steps: unknown): [Step[0], any[], number][] {
  if (typeof steps === 'string' || typeof (steps as Iterable<unknown>)?.[Symbol.iterator] !== 'function')
    throw new Error(`play() takes a list of steps, got ${JSON.stringify(steps)}`)
  const arities: Record<Step[0], number> = { move: 3, down: 2, up: 2, wheel: 3, key: 3, text: 2 }
  const plan: [Step[0], any[], number][] = []
  let last = 0
  let i = -1
  for (const step of steps as Iterable<unknown>) {
    i += 1
    const bad = (why: string) => new Error(`play() step ${i} ${JSON.stringify(step)}: ${why}`)
    if (!Array.isArray(step) || typeof step[0] !== 'string') throw bad('a step is an array such as ["move", x, y, t]')
    const [kind, ...args] = step as [Step[0], ...any[]]
    if (!Object.hasOwn(arities, kind)) throw bad('the kind must be move, down, up, wheel, key or text')
    if (args.length !== arities[kind]) throw bad(`${kind} takes ${arities[kind]} values after the kind`)
    const t = args[args.length - 1]
    const values = args.slice(0, -1)
    if (!isNumber(t) || t < 0) throw bad('t must be a finite number of milliseconds, at least 0')
    if (t < last) throw bad(`t goes back in time (${t} after ${last})`)
    last = t
    if ((kind === 'move' || kind === 'wheel') && !values.every(isNumber)) throw bad(`${kind} takes finite numbers`)
    if ((kind === 'down' || kind === 'up') && !BUTTONS.includes(values[0])) throw bad(`the button must be one of ${BUTTONS.join(', ')}`)
    if (kind === 'key' && (typeof values[0] !== 'string' || !values[0] || !['down', 'up'].includes(values[1])))
      throw bad('key takes a key name and "down" or "up"')
    if (kind === 'text' && typeof values[0] !== 'string') throw bad('text takes a string')
    plan.push([kind, values, t])
  }
  return plan
}

const keySteps = (steps: KeyStep[]): Step[] =>
  steps.map(([t, action, key]) => (action === 'insert' ? ['text', key, t] : ['key', key, action, t]))

/**
 * The smart actions on one host, for a person on `os` (the OS the browser
 * claims). `rng` is the random stream every draw comes from, so one seed
 * replays the same actions.
 *
 * The tuning fields apply to the actions that follow: `moveSpeed` (a
 * multiplier), `overshootThreshold` (px; a longer move overshoots and
 * corrects), `holdMs` (a fixed hold for each press), `finishPosition` (where a
 * scroll leaves the element) and `scrollPasses`.
 */
export class Actions<T = unknown> {
  readonly host: Host<T>
  readonly rng: Rng
  readonly os: Os | undefined
  readonly settings: MyuriSettings
  readonly device: 'mouse' | 'trackpad'
  wpm: number
  readonly parts: Parts<T>
  moveSpeed: number | undefined = undefined
  overshootThreshold: number
  holdMs: number | undefined = undefined
  finishPosition = SCROLL_FINISH_POSITION
  scrollPasses = SCROLL_PASSES
  /** Where the cursor is, in page px; null until known. Before the first move it is only where the person's hand is taken to be. */
  cursor: Vector | null = null
  protected placed = false
  protected movedAt = -Infinity
  protected releasedAt = -Infinity

  constructor(host: Host<T>, rng: Rng, options: ActionsOptions<T> = {}) {
    checkOs(options.os)
    const unknown = Object.keys(options.parts ?? {}).filter((k) => !(PARTS as readonly string[]).includes(k)).sort()
    if (unknown.length) throw new TypeError(`myuri: '${unknown[0]}' is not a part; the parts are ${PARTS.join(', ')}`)
    const settings = resolveSettings(options.settings)
    settings.scroll.wheel = { ...settings.scroll.wheel, style: wheelStyleFor(options.os, options.settings) }
    this.host = host
    this.rng = rng
    this.os = options.os
    this.settings = settings
    this.device = options.device ?? settings.scroll.device
    this.wpm = options.wpm ?? settings.typing.wpm
    this.parts = { ...options.parts }
    this.overshootThreshold = settings.overshoot.threshold
  }

  /** Record a move the host made outside these actions. */
  moved(x: number, y: number): void {
    this.cursor = { x, y }
    this.placed = true
    this.movedAt = this.host.now()
  }

  private part<R>(name: (typeof PARTS)[number], args: unknown[]): Promise<R> {
    const own = (this as any)[`default${name[0].toUpperCase()}${name.slice(1)}`].bind(this) as (...a: unknown[]) => Promise<R>
    const fn = this.parts[name] as ((...a: unknown[]) => Awaitable<R>) | undefined
    if (!fn) return own(...args)
    const ctx: PartContext<R> = {
      default: (...a) => own(...(a.length ? a : args)),
      rng: this.rng,
      play: (steps) => this.play(steps),
    }
    return Promise.resolve(fn(this.host, ...args, ctx))
  }

  private async wait(ms: number): Promise<void> {
    if (ms > 0) await this.host.sleep(ms)
  }

  private async here(): Promise<Vector> {
    if (!this.cursor) {
      const [width, height] = await this.host.viewport()
      this.cursor = { x: this.rng() * width, y: this.rng() * height }
    }
    return this.cursor
  }

  // ---- actions --------------------------------------------------------------

  /** Play a timeline, each step at its time from the start; a late step delays only itself. */
  async play(steps: Step[]): Promise<void> {
    const host = this.host
    const timeline = validateSteps(steps)
    const start = host.now()
    for (const [kind, values, t] of timeline) {
      // A timer may fire early, so wait until the step is due.
      for (let ms = start + t - host.now(); ms > 0; ms = start + t - host.now()) await host.sleep(ms)
      if (kind === 'move') {
        await host.move(values[0], values[1])
        this.moved(values[0], values[1])
      } else if (kind === 'down') await host.down(values[0])
      else if (kind === 'up') {
        await host.up(values[0])
        this.releasedAt = host.now()
      } else if (kind === 'wheel') await host.wheel(values[0], values[1])
      else if (kind === 'key') await (values[1] === 'down' ? host.keyDown(values[0]) : host.keyUp(values[0]))
      else await host.insertText(values[0])
    }
  }

  /** Move the cursor to (x, y). */
  move(x: number, y: number): Promise<void> {
    return this.part('move', [x, y])
  }

  /** Press where the cursor is, `clickCount` times, holding `modifiers`. */
  async press(button: Button = 'left', clickCount = 1, modifiers: string[] = []): Promise<void> {
    for (const key of modifiers) await this.host.keyDown(key)
    await this.part('press', [button, clickCount])
    this.releasedAt = this.host.now()
    for (const key of [...modifiers].reverse()) await this.host.keyUp(key)
  }

  /** Move to (x, y) and press there. */
  async clickAt(x: number, y: number, button: Button = 'left', clickCount = 1): Promise<void> {
    await this.part('move', [x, y])
    await this.press(button, clickCount)
  }

  /** Scroll `dy` px down, then `dx` px right. */
  wheel(dx: number, dy: number): Promise<void> {
    return this.part('wheel', [dx, dy])
  }

  /** Type `text` into what has focus. */
  type(text: string): Promise<void> {
    return this.part('type', [text])
  }

  /** Press a key or chord in Playwright's notation ('Enter', 'Control+a'). */
  key(key: string): Promise<void> {
    return this.part('key', [key])
  }

  /** Scroll `target` into view with the wheel. */
  intoView(target: T): Promise<void> {
    return this.part('intoView', [target])
  }

  /** The scroll plan of `target` in page px (`SCROLL_PLAN_JS`), or null when it is not visible. */
  async measure(target: T): Promise<Measured | null> {
    const offset = await this.host.offset(target)
    if (!offset) return null
    const [dx, dy] = offset
    const here = await this.here()
    const plan = await this.host.evaluate<ScrollPlanArgs, ScrollPlan | null>(target, SCROLL_PLAN_JS, {
      finishPosition: this.finishPosition,
      pad: SCROLL_PAD,
      edge: SCROLL_EDGE,
      fromX: here.x - dx,
      fromY: here.y - dy,
    })
    if (!plan) return null
    const shift = (r: BoundingBox | null) => r && { ...r, x: r.x + dx, y: r.y + dy }
    return { ...plan, hoverX: plan.hoverX + dx, hoverY: plan.hoverY + dy, region: shift(plan.region), box: shift(plan.box) as BoundingBox }
  }

  /**
   * Scroll `target` into view, move onto it and press. Without `position`,
   * the point is chosen in the element's visible part. Unless `force`, the
   * press must reach the element. A miss is tried again, until `attempts`
   * tries or `timeout` ms, then throws {@link Missed}. With `press: false` the
   * cursor stops on the element.
   */
  async click(target: T, options: ClickOptions = {}): Promise<void> {
    const { button = 'left', clickCount = 1, modifiers = [], position, force = false, press = true, timeout, attempts } = options
    const host = this.host
    const deadline = timeout ? host.now() + timeout : Infinity
    for (let attempt = 0; ; attempt++) {
      try {
        await this.part('intoView', [target])
        const plan = await this.measure(target)
        if (!plan) throw new Missed('element is not visible')
        let p: Vector
        if (position) {
          const [left, top] = plan.borders
          p = { x: plan.box.x + left + position.x, y: plan.box.y + top + position.y }
        } else if (!plan.region) throw new Missed('element is outside of the viewport or covered')
        else p = await this.part<Vector>('point', [plan.region, attempt])
        await this.part('move', [p.x, p.y])
        if (!force) {
          const at = this.placed && this.cursor ? this.cursor : p
          const reason = await this.part<string | null>('reaches', [target, at.x, at.y, press])
          if (reason) throw new Missed(reason)
        }
        if (press) await this.press(button, clickCount, modifiers)
        return
      } catch (e) {
        if (!(e instanceof Missed) || (attempts !== undefined && attempt + 1 >= attempts) || host.now() >= deadline) throw e
        await this.wait(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)])
      }
    }
  }

  // ---- default parts ----------------------------------------------------------

  protected async defaultMove(x: number, y: number): Promise<void> {
    const [width, height] = await this.host.viewport()
    const settle = (p: Vector): Vector => ({
      x: Math.min(Math.max(Math.round(p.x), 0), width - 1),
      y: Math.min(Math.max(Math.round(p.y), 0), height - 1),
    })
    const end = settle({ x, y })
    if (this.placed && this.cursor?.x === end.x && this.cursor.y === end.y) return
    const start = await this.here()
    const points = moveWith(
      start,
      end,
      this.rng,
      { moveSpeed: this.moveSpeed, overshoot: shouldOvershoot(start, end, this.overshootThreshold), settings: this.settings.overshoot },
      settle,
    )
    const steps: Step[] = []
    let last = this.placed ? this.cursor : null
    for (const p of points) {
      const pos = settle(p)
      // Only macOS reports a mouse that has not left its pixel; elsewhere it sends nothing.
      if (last && pos.x === last.x && pos.y === last.y && this.os !== 'macos') continue
      steps.push(['move', pos.x, pos.y, p.t])
      last = pos
    }
    await this.play(steps)
  }

  protected async defaultPress(button: Button, clickCount: number): Promise<void> {
    const host = this.host
    const now = host.now()
    const resting = this.movedAt < this.releasedAt
    const since = resting ? now - this.releasedAt : undefined
    const planned = planClick(this.rng, { os: this.os, clickCount, sinceReleaseMs: since })
    await this.wait(resting ? planned.dwellMs : this.movedAt + planned.dwellMs - now)
    // A press continuing a run is the run's next click.
    const first = since !== undefined && since < CLICK_RUN_MS ? 2 : 1
    const presses = planned.presses
    for (const [i, [down, up]] of presses.entries()) {
      if (i) await this.wait(down - presses[i - 1][1])
      await host.click(button, first + i, this.holdMs ?? up - down)
    }
  }

  protected async defaultPoint(box: BoundingBox, attempt: number): Promise<Vector> {
    const here = await this.here()
    // Another attempt aims somewhere new, not again where the last one missed.
    return attempt === 0 ? planPoint(box, this.rng, { start: here }) : getRandomBoxPoint(box, undefined, here, undefined, this.rng)
  }

  protected async defaultReaches(target: T, x: number, y: number, pressing: boolean): Promise<string | null> {
    const offset = await this.host.offset(target)
    if (!offset) return 'element is not visible'
    return await this.host.evaluate<HitTestArgs | null, string | null>(target, HIT_TEST_JS, {
      x: x - offset[0],
      y: y - offset[1],
      pressing,
    })
  }

  protected async defaultIntoView(target: T): Promise<void> {
    for (let i = 0; i < this.scrollPasses; i++) {
      const plan = await this.measure(target)
      if (!plan || plan.inView || Math.abs(plan.deltaY) < 1) return
      // Over the scroller the plan chose, so the wheel scrolls it.
      await this.part('move', [plan.hoverX, plan.hoverY])
      await this.part('wheel', [0, plan.deltaY])
      await this.landed(target)
    }
  }

  /**
   * Wait until the element stops moving, as a person waits for a scroll to
   * land before aiming; a page that never stops is given `LANDING_MS`.
   */
  private async landed(target: T): Promise<void> {
    const [every, limit] = LANDING_MS
    const deadline = this.host.now() + limit
    let last = await this.measure(target)
    while (this.host.now() < deadline) {
      await this.wait(every)
      const plan = await this.measure(target)
      if (JSON.stringify(plan?.box) === JSON.stringify(last?.box)) return
      last = plan
    }
  }

  protected async defaultWheel(dx: number, dy: number): Promise<void> {
    const s = this.settings.scroll
    const spec = { device: this.device, wheel: s.wheel, speedIrregularity: s.realism.speedIrregularity }
    await this.play(wheelSteps(dx, dy, this.rng, this.os, spec))
  }

  protected async defaultType(text: string): Promise<void> {
    const steps = planType(text, this.rng, { os: this.os, wpm: this.wpm, mistakeMultiplier: this.settings.typing.mistakeMultiplier })
    await this.play(keySteps(steps))
  }

  protected async defaultKey(key: string): Promise<void> {
    await this.play(keySteps(planPress(key, this.rng, { os: this.os, wpm: this.wpm })))
  }
}
