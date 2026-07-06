import { type Vector, overshoot as overshootPoint } from './math.js'
import { type Rng, makeRng, generateRandomSeed } from './rng.js'
import { type Driver, type ResolvedDriver, defineDriver } from './drivers/types.js'
import { driverFromPage } from './drivers/index.js'
import { resolveSettings, type MyuriSettings, type DeepPartial } from './settings.js'
import { generateProfile } from './profile.js'
import {
  viewportOf,
  boundingBoxOf,
  scrollMetricsOf,
  waitForElement,
  pointHitsTarget,
} from './page.js'
import {
  path,
  getRandomBoxPoint,
  getBetterStartingPosition,
  clampToBrowserBounds,
  shouldOvershoot,
  VIEWPORT_PADDING,
} from './geometry.js'
import { scrollModel } from './motion/scroll-model.js'
import { HumanTyper, type TyperInput } from './typing/typer.js'
import type { BoundingBox } from './math.js'
import type {
  MoveOptions,
  ClickOptions,
  MoveToOptions,
  ScrollOptions,
  TypeOptions,
  RandomMoveOptions,
} from './options.js'

const delay = async (ms: number): Promise<void> => {
  if (ms < 1) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const pointInBox = (p: Vector, b: BoundingBox): boolean =>
  p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height

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

/** A human-like cursor bound to a {@link Driver}. */
export class Cursor {
  private readonly driver: ResolvedDriver
  private readonly rng: Rng
  private readonly seed: number
  private readonly settings: MyuriSettings
  private readonly defaults: NonNullable<CursorOptions['defaults']>
  private readonly typer: HumanTyper

  private previous: Vector
  private isMoving = false
  private performingRandomMoves = false
  private randomMoveTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** Auto-calibrated wheel scaling; driver/DPR combos apply a fraction of delta. */
  private scrollMultiplier: number | null = null

  constructor(driver: Driver, options: CursorOptions = {}) {
    this.driver = defineDriver(driver)
    this.seed = (options.seed ?? generateRandomSeed()) >>> 0
    this.rng = makeRng(this.seed)
    // An explicit `settings` override always wins (back-compat). Otherwise, if
    // the caller supplied a seed, derive a stable behavioral profile from it so
    // the same seed yields the same "personality"; with neither, use defaults.
    this.settings =
      options.settings !== undefined
        ? resolveSettings(options.settings)
        : options.seed !== undefined
          ? generateProfile(this.seed)
          : resolveSettings()
    this.defaults = options.defaults ?? {}
    this.previous = options.start ?? getBetterStartingPosition(options.dimensions, this.rng)

    const typerInput: TyperInput = {
      press: (key, opts) => this.driver.press(key, opts),
      down: (key) => this.driver.down(key),
      up: (key) => this.driver.up(key),
    }
    this.typer = new HumanTyper(typerInput, {
      wpm: this.settings.typing.wpm,
      layout: this.settings.typing.layout,
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
    return { ...this.previous }
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
      this.previous,
      undefined,
      this.rng,
    )
    await this.moveTo(target, { moveSpeed: opts.moveSpeed, moveDelay: 0, randomizeMoveDelay: false })
    if (this.performingRandomMoves) this.scheduleRandomMove()
  }

  // ---- primitive motion ---------------------------------------------------

  private async tracePath(vectors: ReturnType<typeof path>): Promise<void> {
    if (vectors.length === 0) return
    const vp = await viewportOf(this.driver)
    let prevT = vectors[0].timestamp
    for (const v of vectors) {
      if (this.driver.isClosed()) return
      const clamped = clampToBrowserBounds(v.x, v.y, vp)
      const pos = { x: Math.round(clamped.x), y: Math.round(clamped.y) }
      const targetDelta = v.timestamp - prevT
      prevT = v.timestamp
      const t0 = Date.now()
      await this.driver.move(pos.x, pos.y)
      this.previous = pos
      // Subtract dispatch latency so per-point cadence matches the fitted model.
      await delay(targetDelta - (Date.now() - t0))
    }
  }

  private async moveAlong(destination: Vector, options: MoveToOptions, allowOvershoot: boolean): Promise<void> {
    if (allowOvershoot) {
      const oShoot = overshootPoint(destination, this.settings.overshoot.radius, this.rng)
      await this.tracePath(path(this.previous, oShoot, options, this.rng))
      const dwell = this.settings.overshoot.dwell
      await delay(dwell.minMs + this.rng() * Math.max(0, dwell.maxMs - dwell.minMs))
      const correctionSpeed = (options.moveSpeed ?? 1) * this.settings.overshoot.correctionSpeedFactor
      await this.tracePath(path(this.previous, destination, { moveSpeed: correctionSpeed }, this.rng))
    } else {
      await this.tracePath(path(this.previous, destination, options, this.rng))
    }
  }

  /** Move to an absolute viewport point. */
  async moveTo(destination: Vector, options?: MoveToOptions): Promise<void> {
    const opts: MoveToOptions = { moveDelay: 0, randomizeMoveDelay: true, ...this.defaults.moveTo, ...options }
    const wasRandom = this.startAction()
    try {
      await this.moveAlong(destination, opts, false)
    } finally {
      await this.endAction(wasRandom, opts)
    }
  }

  private async resolveExcludeBoxes(selectors?: string | readonly string[]): Promise<BoundingBox[]> {
    if (selectors == null) return []
    const list = typeof selectors === 'string' ? [selectors] : selectors
    const boxes: BoundingBox[] = []
    for (const sel of list) {
      const box = await boundingBoxOf(this.driver, sel).catch(() => null)
      if (box) boxes.push(box)
    }
    return boxes
  }

  /** Move the cursor onto an element, overshooting for long travels and retrying if it misses. */
  async move(selector: string, options?: MoveOptions): Promise<void> {
    const opts: MoveOptions = {
      maxTries: 3,
      overshootThreshold: this.settings.overshoot.threshold,
      widthPaddingPercentage: 25,
      heightPaddingPercentage: 70,
      moveDelay: 0,
      randomizeMoveDelay: true,
      waitForSelector: 10000,
      moveSpeed: 1,
      ...this.defaults.move,
      ...options,
    }
    const wasRandom = this.startAction()
    try {
      await this.moveToElement(selector, opts)
    } finally {
      await this.endAction(wasRandom, opts)
    }
  }

  /** Core move-onto-element loop (no action lifecycle). */
  private async moveToElement(selector: string, opts: MoveOptions): Promise<void> {
    const maxTries = opts.maxTries ?? 3
    const deadline = opts.timeout != null ? Date.now() + opts.timeout : Infinity
    let lastError: Error | null = null

    for (let attempt = 0; attempt < maxTries; attempt++) {
      if (this.driver.isClosed()) return
      const remaining = deadline === Infinity ? (opts.waitForSelector ?? 10000) : deadline - Date.now()
      if (remaining <= 0) break

      const found = await waitForElement(this.driver, selector, {
        state: 'visible',
        timeout: Math.min(opts.waitForSelector ?? 10000, remaining),
      })
      if (!found) {
        lastError = new Error(`myuri: element not found or not visible: ${selector}`)
        continue
      }

      const box = await boundingBoxOf(this.driver, selector)
      if (!box) {
        lastError = new Error(`myuri: element has no box: ${selector}`)
        continue
      }

      const excludeBoxes = await this.resolveExcludeBoxes(opts.excludeSelectors)
      // Widen the retry sample slightly each attempt to escape a repeated miss.
      const attemptOpts = attempt === 0 ? opts : { ...opts, widthPaddingPercentage: Math.max(0, (opts.widthPaddingPercentage ?? 25) - this.settings.correction.retrySpread * attempt) }
      const destination = getRandomBoxPoint(box, attemptOpts, this.previous, excludeBoxes, this.rng)

      const overshootThreshold = opts.overshootThreshold ?? Number.POSITIVE_INFINITY
      await this.moveAlong(destination, opts, shouldOvershoot(this.previous, destination, overshootThreshold))

      // Verify landing against the (possibly moved) element and occlusion.
      const finalBox = await boundingBoxOf(this.driver, selector)
      if (finalBox && pointInBox(this.previous, finalBox) && (await pointHitsTarget(this.driver, this.previous, selector))) {
        return
      }
      lastError = new Error(`myuri: cursor did not land on ${selector}`)
    }
    if (lastError) throw lastError
  }

  /** Click an element (moving to it first) or click at the current position. */
  async click(selector?: string, options?: ClickOptions): Promise<void> {
    const opts: ClickOptions = {
      button: 'left',
      waitForClick: 50,
      widthPaddingPercentage: 25,
      heightPaddingPercentage: 70,
      moveDelay: 0,
      randomizeMoveDelay: true,
      waitForSelector: 10000,
      maxTries: 3,
      overshootThreshold: this.settings.overshoot.threshold,
      moveSpeed: 1,
      microJitter: false,
      dynamicAdjustment: true,
      ...this.defaults.move,
      ...this.defaults.click,
      ...options,
    }
    const wasRandom = this.startAction()
    try {
      if (selector != null) {
        await this.moveToElement(selector, { ...opts, moveDelay: 0, randomizeMoveDelay: false })

        if (opts.dynamicAdjustment) {
          const finalBox = await boundingBoxOf(this.driver, selector)
          if (finalBox && !(await pointHitsTarget(this.driver, this.previous, selector))) {
            const excludeBoxes = await this.resolveExcludeBoxes(opts.excludeSelectors)
            const target = getRandomBoxPoint(finalBox, opts, this.previous, excludeBoxes, this.rng)
            await this.moveAlong(target, opts, false)
          }
        }

        if (!(await pointHitsTarget(this.driver, this.previous, selector))) {
          throw new Error(`myuri: click point ${JSON.stringify(this.previous)} is occluded for '${selector}'`)
        }

        if (opts.microJitter) {
          await this.driver.move(this.previous.x + (this.rng() - 0.5) * 2, this.previous.y + (this.rng() - 0.5) * 2)
          await delay(15 + this.rng() * 10)
        }
      }
      await this.driver.click(opts.button)
      await delay(Math.max(opts.waitForClick ?? 0, 15))
    } finally {
      await this.endAction(wasRandom, opts)
    }
  }

  // ---- typing -------------------------------------------------------------

  private async platformSelectAllModifier(): Promise<string> {
    const isMac = await this.driver.evaluate(
      () => /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent),
      null,
    )
    return isMac ? 'Meta' : 'Control'
  }

  /** Type text, optionally clicking a field first. */
  async type(text: string, selector?: string, options?: TypeOptions): Promise<void> {
    const opts: TypeOptions = { waitForSelector: 10000, maxTries: 3, ...this.defaults.type, ...options }
    const wasRandom = this.startAction()
    try {
      if (selector != null) {
        await this.click(selector, { waitForClick: 30, waitForSelector: opts.waitForSelector, maxTries: opts.maxTries })
      }
      if (opts.clearExisting) {
        await this.typer.deleteAll({ count: 0, selectAllModifier: await this.platformSelectAllModifier() })
      }
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

  /** Scroll an element into view, honoring `finishPosition`. */
  async scroll(selector: string, options?: ScrollOptions): Promise<void> {
    const opts: ScrollOptions = {
      delay: this.settings.scroll.delay,
      speedFactor: this.settings.scroll.speedFactor,
      overshoot: this.settings.scroll.overshoot,
      finishPosition: this.settings.scroll.finishPosition,
      realism: { ...this.settings.scroll.realism },
      waitForSelector: 10000,
      maxTries: 3,
      ...this.defaults.scroll,
      ...options,
    }
    const wasRandom = this.startAction()
    try {
      // Ensure the mouse is over the page so wheel events land.
      await this.moveAlong(
        { x: this.previous.x + this.rng() * 20 - 10, y: this.previous.y + this.rng() * 20 - 10 },
        { moveDelay: 0, randomizeMoveDelay: false },
        false,
      )
      const found = await waitForElement(this.driver, selector, { state: 'visible', timeout: opts.waitForSelector })
      if (!found) throw new Error(`myuri: element not found: ${selector}`)

      const maxTries = opts.maxTries ?? 3
      for (let attempt = 0; attempt < maxTries; attempt++) {
        await this.scrollToElement(selector, opts)
        if (await this.isElementInView(selector)) break
      }
    } finally {
      await this.endAction(wasRandom, { moveDelay: 0, randomizeMoveDelay: false })
    }
  }

  private async isElementInView(selector: string): Promise<boolean> {
    const box = await boundingBoxOf(this.driver, selector)
    if (!box) return false
    const vp = await viewportOf(this.driver)
    const pad = Math.max(20, VIEWPORT_PADDING + 5)
    return box.y >= pad && box.y + box.height <= vp.height - pad
  }

  private async scrollToElement(selector: string, opts: ScrollOptions): Promise<void> {
    const box = await boundingBoxOf(this.driver, selector)
    if (!box) return
    const vp = await viewportOf(this.driver)
    const finishPosition = opts.finishPosition ?? 0.5
    const targetY = vp.height * finishPosition
    const elementCenterY = box.y + box.height / 2
    const wantedDistance = (elementCenterY - targetY) * (this.scrollMultiplier ?? 1)
    if (Math.abs(wantedDistance) < 1) return

    const pre = (await scrollMetricsOf(this.driver)).offset
    const speedIrregularity = opts.realism?.speedIrregularity ?? this.settings.scroll.realism.speedIrregularity
    const events = scrollModel.generateScrollPath(wantedDistance, this.rng, undefined, speedIrregularity)
    const sf = opts.speedFactor ?? 1

    // Batch sub-threshold deltas: Chromium ignores very small wheel deltas.
    let accumulator = 0
    for (const ev of events) {
      accumulator += ev.deltaY
      const t0 = Date.now()
      if (Math.abs(accumulator) >= 8) {
        const dispatch = Math.trunc(accumulator)
        accumulator -= dispatch
        await this.driver.wheel(0, dispatch)
      }
      await delay(ev.deltaTime / sf - (Date.now() - t0))
    }
    if (Math.abs(Math.round(accumulator)) >= 1) await this.driver.wheel(0, Math.round(accumulator))

    const post = await this.settleScroll(pre)
    const actualDelta = post - pre
    // Calibrate wheel scaling once from the first meaningful scroll.
    if (this.scrollMultiplier == null && Math.abs(wantedDistance) > 10 && Math.abs(actualDelta) > 10) {
      this.scrollMultiplier = Math.round((wantedDistance / actualDelta) * 100) / 100
    }
  }

  private async settleScroll(previousOffset: number): Promise<number> {
    let last = previousOffset
    let stable = 0
    const deadline = Date.now() + 600
    for (;;) {
      await delay(40)
      const cur = (await scrollMetricsOf(this.driver)).offset
      if (cur === last) {
        if (++stable >= 3 || Date.now() >= deadline) return cur
      } else {
        stable = 0
        last = cur
      }
      if (Date.now() >= deadline) return cur
    }
  }

  // ---- misc ---------------------------------------------------------------

  /** Teleport the cursor to a point without an animated path. */
  async setCursorLocation(location: Vector): Promise<void> {
    const vp = await viewportOf(this.driver)
    const clamped = clampToBrowserBounds(location.x, location.y, vp)
    const pos = { x: Math.round(clamped.x), y: Math.round(clamped.y) }
    await this.driver.move(pos.x, pos.y)
    this.previous = pos
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
