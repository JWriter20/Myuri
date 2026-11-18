import { type BoundingBox, type Vector, pointInBox } from './math.js'
import { type Rng, makeRng, generateRandomSeed } from './rng.js'
import { type Driver, type MouseButton, type ResolvedDriver, defineDriver } from './drivers/types.js'
import { driverFromPage } from './drivers/index.js'
import { resolveSettings, type MyuriSettings, type DeepPartial } from './settings.js'
import { generateProfile } from './profile.js'
import { boundingBoxOf, scrollOffsetOf, viewportOf, waitForElement } from './page.js'
import { FOCUSED_FIELD_JS, onSelector } from './page-functions.js'
import { Actions, type Host, type Step } from './actions.js'
import { getRandomBoxPoint, getBetterStartingPosition, isPointExcluded } from './geometry.js'
import { dragCarrySpeed, dragEndMs, dragStartMs, preClickDwellMs } from './motion/click-model.js'
import { wheelStyleFor, wheelSteps } from './plan.js'
import { primaryModifier, type Os } from './target-os.js'
import { HumanTyper, type TyperInput } from './typing/typer.js'
import type {
  BoxOptions,
  MoveOptions,
  ClickOptions,
  DragOptions,
  MoveToOptions,
  ScrollOptions,
  TypeOptions,
  RandomMoveOptions,
} from './options.js'

const delay = async (ms: number): Promise<void> => {
  if (ms < 1) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** A driver as the smart actions' host. A target is a selector, measured in the top page. */
class DriverHost implements Host<string> {
  private sent: Promise<void>[] = []

  constructor(readonly driver: ResolvedDriver) {}

  move(x: number, y: number) {
    return this.driver.move(x, y)
  }
  click(button: MouseButton, clickCount: number, holdMs: number) {
    return this.driver.click(button, clickCount, holdMs)
  }
  down(button: MouseButton) {
    return this.driver.mouseDown(button)
  }
  up(button: MouseButton) {
    return this.driver.mouseUp(button)
  }
  /**
   * Sent without waiting for the page, as a device sends them: a browser
   * acknowledges a wheel event only on its next frame, so awaiting each one
   * stretches a gesture. {@link landed} waits for them.
   */
  wheel(dx: number, dy: number) {
    const sent = this.driver.wheel(dx, dy)
    sent.catch(() => {})
    this.sent.push(sent)
  }
  async landed(): Promise<void> {
    const sent = this.sent
    this.sent = []
    await Promise.all(sent)
  }
  keyDown(key: string) {
    return this.driver.down(key)
  }
  keyUp(key: string) {
    return this.driver.up(key)
  }
  insertText(text: string) {
    return this.driver.insertText(text)
  }
  /** Called after {@link offset} has found the target, so the selector resolves. */
  evaluate<A, R>(selector: string, fn: (el: any, arg: A) => R, arg: A) {
    return this.driver.evaluate(onSelector(fn), { selector, arg }) as Promise<R>
  }
  async offset(selector: string): Promise<[number, number] | null> {
    return (await this.driver.evaluate(onSelector(() => true), { selector, arg: null })) ? [0, 0] : null
  }
  async viewport(): Promise<[number, number]> {
    const { width, height } = await viewportOf(this.driver)
    return [width, height]
  }
  now() {
    return performance.now()
  }
  sleep(ms: number) {
    return delay(ms)
  }
}

/** The smart actions with the Cursor's options: where in a box to press, and a calibrated wheel. */
class CursorActions extends Actions<string> {
  /** Padding and boxes to avoid when choosing a point, for the action under way. */
  boxOptions: (BoxOptions & { exclude?: BoundingBox[] }) | undefined = undefined
  speedFactor: number
  speedIrregularity: number
  /** Wheel px per page px, calibrated on the first page scroll (drivers and DPRs scale a delta). */
  private scrollMultiplier: number | null = null

  constructor(host: DriverHost, rng: Rng, options: ConstructorParameters<typeof Actions<string>>[2]) {
    super(host, rng, options)
    this.speedFactor = this.settings.scroll.speedFactor
    this.speedIrregularity = this.settings.scroll.realism.speedIrregularity
  }

  get sinceMove(): number {
    return this.host.now() - this.movedAt
  }

  protected override async defaultPoint(box: BoundingBox, attempt: number): Promise<Vector> {
    const opts = this.boxOptions
    if (!opts) return super.defaultPoint(box, attempt)
    const here = this.cursor
    // A person already on the target presses where they are.
    if (here && this.placed && pointInBox(here, box) && !isPointExcluded(here, opts.exclude)) return here
    return getRandomBoxPoint(box, opts, here ?? undefined, opts.exclude, this.rng)
  }

  protected override async defaultWheel(dx: number, dy: number): Promise<void> {
    const host = this.host as DriverHost
    const m = this.scrollMultiplier ?? 1
    const s = this.settings.scroll
    const spec = { device: this.device, wheel: s.wheel, speedIrregularity: this.speedIrregularity }
    const steps = wheelSteps(dx * m, dy * m, this.rng, this.os, spec).map((step) => {
      const out = [...step] as Step
      out[out.length - 1] = (step[step.length - 1] as number) / this.speedFactor
      return out
    })
    const dispatched = steps.reduce((sum, step) => sum + (step[0] === 'wheel' ? step[2] : 0), 0)
    const pre = await scrollOffsetOf(host.driver)
    await this.play(steps)
    await host.landed()
    const moved = (await this.settle(pre)) - pre
    // Clamped: a first scroll cut short by the end of the page would inflate every later one.
    if (this.scrollMultiplier == null && Math.abs(dispatched) > 10 && Math.abs(moved) > 10)
      this.scrollMultiplier = Math.min(3, Math.max(0.3, Math.round((dispatched / moved) * 100) / 100))
  }

  /** The page's scroll offset once it stops moving (a container scroll leaves it still). */
  private async settle(previous: number): Promise<number> {
    const driver = (this.host as DriverHost).driver
    let last = previous
    let stable = 0
    const deadline = Date.now() + 600
    for (;;) {
      await delay(40)
      const cur = await scrollOffsetOf(driver)
      if (cur === last) stable++
      else {
        stable = 0
        last = cur
      }
      if (stable >= 3 || Date.now() >= deadline) return cur
    }
  }
}
/** Options accepted when constructing a Cursor. */
export interface CursorOptions {
  /** PRNG seed. Same seed -> identical motion, scrolls, and typing rhythm. */
  seed?: number
  /** Behavioral tuning overrides (deep-merged onto defaults). */
  settings?: DeepPartial<MyuriSettings>
  /** Initial cursor position; defaults to a natural off-origin point. */
  start?: Vector
  /** Viewport hint used only to pick the default start position. */
  dimensions?: { width: number; height: number }
  /** Begin idle random movements immediately. */
  performRandomMovesInitially?: boolean
  /**
   * The OS the browser claims to run on. It picks the paste modifier, whether
   * a move repeats a position and how a mouse wheel scrolls (see
   * `target-os.ts`), so they match the identity. Timing is the same on every
   * OS. Without it, the paste modifier is read from the page's
   * `navigator.platform` and moves and the wheel are Windows-like.
   */
  os?: Os
  /**
   * Clear fields with a keyboard select-all (this modifier + A) instead of the
   * default triple-click. Off by default because the modifier reveals the real
   * OS: pages can read `ctrlKey`/`metaKey`, and browsers only honor the one for
   * the OS they actually run on (Cmd on macOS, Ctrl elsewhere), whatever
   * `navigator.platform` claims. Use it for editors where triple-click fails.
   * With `os`, it must be that OS's modifier.
   */
  selectAllModifier?: 'Control' | 'Meta'
  /** Default per-action options. */
  defaults?: {
    move?: MoveOptions
    click?: ClickOptions
    moveTo?: MoveToOptions
    scroll?: ScrollOptions
    type?: TypeOptions
    randomMove?: RandomMoveOptions
  }
}

/** Tuning that applies to one Cursor call. */
type Tuning = Partial<Pick<CursorActions, 'moveSpeed' | 'overshootThreshold' | 'holdMs' | 'finishPosition' | 'scrollPasses' | 'boxOptions' | 'speedFactor' | 'speedIrregularity'>>

/** A human-like cursor bound to a {@link Driver}, on myuri's smart actions (`actions.ts`). */
export class Cursor {
  private readonly driver: ResolvedDriver
  private readonly actions: CursorActions
  private readonly rng: Rng
  private readonly seed: number
  private readonly settings: MyuriSettings
  private readonly defaults: NonNullable<CursorOptions['defaults']>
  private readonly selectAllModifier: 'Control' | 'Meta' | undefined
  private typer: HumanTyper

  private isMoving = false
  private performingRandomMoves = false
  private randomMoveTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(driver: Driver, options: CursorOptions = {}) {
    if (options.os !== undefined && options.selectAllModifier !== undefined && options.selectAllModifier !== primaryModifier(options.os)) {
      throw new Error(`myuri: selectAllModifier ${options.selectAllModifier} is not select-all on ${options.os}`)
    }
    this.driver = defineDriver(driver, { os: options.os })
    this.seed = (options.seed ?? generateRandomSeed()) >>> 0
    this.rng = makeRng(this.seed)
    // An explicit `settings` override always wins. Otherwise, a seed derives a
    // stable behavioral profile, so the same seed yields the same "personality".
    const settings =
      options.settings !== undefined
        ? resolveSettings(options.settings)
        : options.seed !== undefined
          ? generateProfile(this.seed)
          : resolveSettings()
    settings.scroll.wheel.style = wheelStyleFor(options.os, options.settings)
    this.actions = new CursorActions(new DriverHost(this.driver), this.rng, { os: options.os, settings })
    this.settings = this.actions.settings
    this.defaults = options.defaults ?? {}
    this.selectAllModifier = options.selectAllModifier
    this.actions.cursor = options.start ?? getBetterStartingPosition(options.dimensions, this.rng)

    const typerInput: TyperInput = {
      down: (key) => this.driver.down(key),
      up: (key) => this.driver.up(key),
      insertText: (text) => this.driver.insertText(text),
    }
    this.typer = new HumanTyper(typerInput, {
      wpm: this.settings.typing.wpm,
      mistakeMultiplier: this.settings.typing.mistakeMultiplier,
      rng: this.rng,
    })

    if (options.performRandomMovesInitially) this.toggleRandomMove(true)
  }

  /** The seed driving this cursor's PRNG. */
  getSeed(): number {
    return this.seed
  }

  /** The resolved behavioral settings (profile) this cursor is running with. */
  getSettings(): MyuriSettings {
    return this.settings
  }

  /** Current cursor position (viewport coordinates). */
  getLocation(): Vector {
    return { ...(this.actions.cursor as Vector) }
  }

  /** Current typing mistake multiplier (0 disables self-correcting typos). */
  getMistakeMultiplier(): number {
    return this.settings.typing.mistakeMultiplier
  }

  /**
   * Adjust the typing mistake multiplier at runtime (e.g. 0 to disable typos on
   * precise fields like emails/dates). Keeps the typer, so the session's speed
   * and hold style carry on.
   */
  setMistakeMultiplier(multiplier: number): void {
    ;(this.settings.typing as { mistakeMultiplier: number }).mistakeMultiplier = multiplier
    this.typer.setMistakeMultiplier(multiplier)
  }

  // ---- action lifecycle ---------------------------------------------------

  private startAction(): boolean {
    const wasRandom = this.performingRandomMoves
    if (wasRandom) this.setRandomMove(false)
    if (this.randomMoveTimer != null) {
      clearTimeout(this.randomMoveTimer)
      this.randomMoveTimer = null
    }
    this.isMoving = true
    return wasRandom
  }

  private async endAction(
    wasRandom: boolean,
    moveDelay?: { moveDelay?: number; randomizeMoveDelay?: boolean },
  ): Promise<void> {
    this.isMoving = false
    const base = moveDelay?.moveDelay ?? 0
    const jitter = moveDelay?.randomizeMoveDelay ? this.rng() : 1
    await delay(base * jitter)
    if (wasRandom) this.setRandomMove(true)
  }

  /** Run `fn` with `tuning` applied to the actions, then restore them. */
  private async tuned<R>(tuning: Tuning, fn: () => Promise<R>): Promise<R> {
    const a = this.actions as unknown as Record<string, unknown>
    const saved: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(tuning)) {
      if (v === undefined) continue
      saved[k] = a[k]
      a[k] = v
    }
    try {
      return await fn()
    } finally {
      Object.assign(a, saved)
    }
  }

  /** A move straight to a point, without an overshoot. */
  private glide(to: Vector, moveSpeed?: number): Promise<void> {
    return this.tuned({ moveSpeed, overshootThreshold: Infinity }, () => this.actions.move(to.x, to.y))
  }

  /** Enable/disable idle random movements. */
  toggleRandomMove(random: boolean): void {
    this.setRandomMove(random)
  }

  private setRandomMove(random: boolean): void {
    if (this.performingRandomMoves === random) return
    this.performingRandomMoves = random
    if (random) {
      this.scheduleRandomMove()
    } else if (this.randomMoveTimer != null) {
      clearTimeout(this.randomMoveTimer)
      this.randomMoveTimer = null
    }
  }

  private scheduleRandomMove(): void {
    if (this.randomMoveTimer != null) clearTimeout(this.randomMoveTimer)
    if (!this.performingRandomMoves || this.isMoving) return
    const opts = this.defaults.randomMove ?? {}
    const base = opts.moveDelay ?? 2000
    const delayTime = base * (opts.randomizeMoveDelay !== false ? 0.5 + this.rng() * 0.5 : 1)
    this.randomMoveTimer = setTimeout(() => {
      if (!this.performingRandomMoves || this.isMoving || this.driver.isClosed()) return
      void this.performRandomMove(opts).catch(() => this.setRandomMove(false))
    }, delayTime)
  }

  private async performRandomMove(opts: RandomMoveOptions): Promise<void> {
    const vp = await viewportOf(this.driver)
    const target = getRandomBoxPoint(
      { x: 0, y: 0, width: vp.width, height: vp.height },
      undefined,
      this.actions.cursor ?? undefined,
      undefined,
      this.rng,
    )
    await this.moveTo(target, { moveSpeed: opts.moveSpeed, moveDelay: 0, randomizeMoveDelay: false })
    if (this.performingRandomMoves) this.scheduleRandomMove()
  }

  // ---- motion -------------------------------------------------------------

  /** Move to an absolute viewport point. */
  async moveTo(destination: Vector, options?: MoveToOptions): Promise<void> {
    const opts: MoveToOptions = { moveDelay: 0, randomizeMoveDelay: true, ...this.defaults.moveTo, ...options }
    const wasRandom = this.startAction()
    try {
      await this.glide(destination, opts.moveSpeed)
    } finally {
      await this.endAction(wasRandom, opts)
    }
  }

  /** The tuning and box options of a move onto an element. */
  private async onto(opts: MoveOptions): Promise<Tuning> {
    const exclude: BoundingBox[] = []
    const list = opts.excludeSelectors == null ? [] : typeof opts.excludeSelectors === 'string' ? [opts.excludeSelectors] : opts.excludeSelectors
    for (const sel of list) {
      const box = await boundingBoxOf(this.driver, sel)
      if (box) exclude.push(box)
    }
    const { widthPaddingPercentage, heightPaddingPercentage, paddingLeft, paddingRight, paddingTop, paddingBottom } = opts
    const box = { widthPaddingPercentage, heightPaddingPercentage, paddingLeft, paddingRight, paddingTop, paddingBottom }
    const custom = exclude.length > 0 || Object.values(box).some((v) => v !== undefined)
    return {
      moveSpeed: opts.moveSpeed,
      overshootThreshold: opts.overshootThreshold,
      boxOptions: custom ? { ...box, exclude } : undefined,
    }
  }

  /**
   * Scroll an element into view, move onto it and, with `press`, press it.
   * A miss is tried again, as Playwright retries an action, until `maxTries`
   * tries or `timeout` ms.
   */
  private async reach(selector: string, opts: ClickOptions, press: boolean): Promise<void> {
    const tuning = await this.onto(opts)
    await this.tuned({ ...tuning, holdMs: opts.holdMs }, () =>
      this.actions.click(selector, {
        button: opts.button,
        clickCount: opts.clickCount,
        press,
        timeout: opts.timeout ?? 10000,
        attempts: opts.maxTries,
      }),
    )
  }

  /** Move the cursor onto an element, scrolling it into view and trying again if it misses. */
  async move(selector: string, options?: MoveOptions): Promise<void> {
    const opts: MoveOptions = { moveDelay: 0, randomizeMoveDelay: true, ...this.defaults.move, ...options }
    const wasRandom = this.startAction()
    try {
      await this.reach(selector, opts, false)
    } finally {
      await this.endAction(wasRandom, opts)
    }
  }

  /**
   * Press on `from`, move to `to` with the button held, and release, timed
   * like recorded people (see `motion/click-model.ts`). Each end is a selector
   * (a point inside the element is chosen, as for `click`) or a viewport point.
   * `to` is measured after the press, so a drop zone that appears once a drag
   * starts works. Needs a driver with `mouseDown`/`mouseUp` (all built-in
   * drivers have them). HTML5 drag-and-drop works where the driver supports
   * it (Playwright does).
   */
  async drag(from: string | Vector, to: string | Vector, options?: DragOptions): Promise<void> {
    const opts: DragOptions = { button: 'left', waitForRelease: 50, ...this.defaults.move, ...options }
    const button = opts.button ?? 'left'
    const wasRandom = this.startAction()
    try {
      if (typeof from === 'string') await this.reach(from, opts, false)
      else await this.glide(from, opts.moveSpeed)
      await delay(preClickDwellMs(this.rng) - this.actions.sinceMove)
      await this.driver.mouseDown(button)
      let released = false
      try {
        await delay(dragStartMs(this.rng))
        let target: Vector
        if (typeof to === 'string') {
          const box = await boundingBoxOf(this.driver, to)
          if (!box) throw new Error(`myuri: drag target not found or not visible: ${to}`)
          target = getRandomBoxPoint(box, opts, this.actions.cursor ?? undefined, [], this.rng)
        } else {
          target = to
        }
        // Carrying something, people move slower and steer straight to the drop: no overshoot.
        await this.glide(target, (opts.moveSpeed ?? 1) * dragCarrySpeed(this.rng))
        await delay(dragEndMs(this.rng) - this.actions.sinceMove)
        released = true
        await this.driver.mouseUp(button)
      } finally {
        if (!released) await this.driver.mouseUp(button).catch(() => {})
      }
      await delay(opts.waitForRelease ?? 50)
    } finally {
      await this.endAction(wasRandom, { moveDelay: 0, randomizeMoveDelay: false })
    }
  }

  /** Click an element (scrolling to and moving onto it first) or click at the current position. */
  async click(selector?: string, options?: ClickOptions): Promise<void> {
    const opts: ClickOptions = {
      button: 'left',
      waitForClick: 50,
      moveDelay: 0,
      randomizeMoveDelay: true,
      ...this.defaults.move,
      ...this.defaults.click,
      ...options,
    }
    const wasRandom = this.startAction()
    try {
      const clickCount = Math.max(1, Math.min(3, Math.round(opts.clickCount ?? 1)))
      if (selector != null) await this.reach(selector, { ...opts, clickCount }, true)
      else await this.tuned({ holdMs: opts.holdMs }, () => this.actions.press(opts.button, clickCount))
      await delay(Math.max(opts.waitForClick ?? 0, 15))
    } finally {
      await this.endAction(wasRandom, opts)
    }
  }

  // ---- typing -------------------------------------------------------------

  /**
   * Empty the focused field. By default this never sends a modifier key:
   * triple-click selects a single-line field outright, and multi-line content
   * is then extended to the end with Shift+ArrowDown (the same keys on every
   * OS). `focusClicked` means the click that focused the field just happened
   * at the cursor, so the triple-click continues it.
   */
  private async clearFocusedField(focusClicked: boolean): Promise<void> {
    let field = await this.driver.evaluate(FOCUSED_FIELD_JS, null)
    if (!field) throw new Error('myuri: clearExisting needs a focused field (pass a selector)')
    if (field.empty) return
    if (this.selectAllModifier) {
      await this.typer.deleteAll({ count: 0, selectAllModifier: this.selectAllModifier })
    } else {
      const here = this.actions.cursor as Vector
      if (!pointInBox(here, field.box)) {
        await this.glide(getRandomBoxPoint(field.box, {}, here, [], this.rng))
        focusClicked = false
      }
      const at = this.actions.cursor as Vector
      const s = field.firstLineSpan
      const onFirstLine = s == null || (at.x >= s.left && at.x <= s.right - 2 && at.y >= s.top && at.y <= s.bottom)
      let clicks = focusClicked ? 2 : 3
      if (field.lines > 1 || (field.singleLine === false && !onFirstLine)) {
        // Triple-click selects one paragraph, so start on the first one: wheel
        // the field back to its top if needed, then triple-click there. One
        // line in a textarea or editor needs it too unless the cursor is
        // already on the text (see firstLineSpan).
        for (let i = 0; i < 30 && field.scrollTop > 0; i++) {
          await this.driver.wheel(0, -Math.min(field.scrollTop, 80 + this.rng() * 80))
          await delay(30 + this.rng() * 40)
          field = (await this.driver.evaluate(FOCUSED_FIELD_JS, null)) ?? field
        }
        const { x, y } = field.firstLine
        await this.glide({ x: x + this.rng() * 12, y: y + (this.rng() - 0.5) * 3 })
        clicks = 3
      }
      // Right after the focusing click, a double click in place continues it into a triple.
      await this.actions.press('left', clicks)
      if (field.lines > 1) {
        await delay(120 + this.rng() * 120)
        await this.driver.down('Shift')
        const maxPresses = Math.max(field.lines, field.visualLines) + 2
        for (let i = 0; i < maxPresses && (await this.driver.evaluate(FOCUSED_FIELD_JS, null))?.selection === 'partial'; i++) {
          await this.driver.press('ArrowDown')
          await delay(40 + this.rng() * 60)
        }
        await this.driver.up('Shift')
      }
      await delay(60 + this.rng() * 90)
      await this.typer.deleteAll({ count: 1 })
    }
    if (!(await this.driver.evaluate(FOCUSED_FIELD_JS, null))?.empty) {
      throw new Error('myuri: clearExisting could not empty the focused field')
    }
  }

  /** Type text, optionally clicking a field first. */
  async type(text: string, selector?: string, options?: TypeOptions): Promise<void> {
    const opts: TypeOptions = { ...this.defaults.type, ...options }
    const wasRandom = this.startAction()
    try {
      if (selector != null) await this.click(selector, { waitForClick: 30, timeout: opts.timeout, maxTries: opts.maxTries })
      if (opts.clearExisting) await this.clearFocusedField(selector != null)
      await this.typer.type(text)
    } finally {
      await this.endAction(wasRandom, { moveDelay: 0, randomizeMoveDelay: false })
    }
  }

  /** Insert text at the current focus (paste semantics). */
  async paste(value: string, selector?: string): Promise<void> {
    const wasRandom = this.startAction()
    try {
      if (selector != null) await this.click(selector, { waitForClick: 30 })
      await this.driver.insertText(value)
      await delay(this.rng() * 25 + 25)
    } finally {
      await this.endAction(wasRandom, { moveDelay: 0, randomizeMoveDelay: false })
    }
  }

  // ---- scrolling ----------------------------------------------------------

  /** Scroll an element into view with the wheel, honoring `finishPosition`. */
  async scroll(selector: string, options?: ScrollOptions): Promise<void> {
    const opts: ScrollOptions = {
      speedFactor: this.settings.scroll.speedFactor,
      finishPosition: this.settings.scroll.finishPosition,
      realism: { ...this.settings.scroll.realism },
      timeout: 10000,
      maxTries: 3,
      ...this.defaults.scroll,
      ...options,
    }
    const wasRandom = this.startAction()
    try {
      // Ensure the mouse is over the page so wheel events land.
      const here = this.actions.cursor as Vector
      await this.glide({ x: here.x + this.rng() * 20 - 10, y: here.y + this.rng() * 20 - 10 })
      if (!(await waitForElement(this.driver, selector, opts.timeout ?? 10000))) throw new Error(`myuri: element not found: ${selector}`)
      await this.tuned(
        {
          finishPosition: opts.finishPosition,
          scrollPasses: opts.maxTries,
          speedFactor: opts.speedFactor,
          speedIrregularity: opts.realism?.speedIrregularity,
        },
        () => this.actions.intoView(selector),
      )
    } finally {
      await this.endAction(wasRandom, { moveDelay: 0, randomizeMoveDelay: false })
    }
  }

  // ---- misc ---------------------------------------------------------------

  /** Teleport the cursor to a point without an animated path. */
  async setCursorLocation(location: Vector): Promise<void> {
    const vp = await viewportOf(this.driver)
    const x = Math.min(Math.max(Math.round(location.x), 0), vp.width - 1)
    const y = Math.min(Math.max(Math.round(location.y), 0), vp.height - 1)
    await this.driver.move(x, y)
    this.actions.moved(x, y)
  }

  /** Release backend resources (CDP sessions, timers). Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.setRandomMove(false)
    if (this.randomMoveTimer != null) {
      clearTimeout(this.randomMoveTimer)
      this.randomMoveTimer = null
    }
    await this.driver.dispose()
  }
}

/** A config object form of {@link createCursor} that supplies an explicit driver. */
export interface CursorDriverConfig extends CursorOptions {
  driver: Driver
}

function isDriverConfig(value: unknown): value is CursorDriverConfig {
  return typeof value === 'object' && value !== null && 'driver' in value
}

function isDriverLike(value: unknown): value is Driver {
  const v = value as Record<string, unknown> | null
  return (
    !!v &&
    typeof v.move === 'function' &&
    typeof v.click === 'function' &&
    typeof v.evaluate === 'function'
  )
}

/**
 * Create a {@link Cursor}. Pass a driver (e.g. `fromPlaywright(page)`), a raw
 * Playwright/Puppeteer page (the driver is inferred), or a `{ driver }` config.
 */
export function createCursor(driver: Driver, options?: CursorOptions): Cursor
export function createCursor(page: unknown, options?: CursorOptions): Cursor
export function createCursor(config: CursorDriverConfig): Cursor
export function createCursor(arg: unknown, options?: CursorOptions): Cursor {
  if (isDriverConfig(arg)) {
    const { driver, ...opts } = arg
    return new Cursor(driver, opts)
  }
  if (isDriverLike(arg)) return new Cursor(arg, options)
  return new Cursor(driverFromPage(arg), options)
}
