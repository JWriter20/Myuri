import { type Vector, overshoot as overshootPoint } from './math.js'
import { type Rng, makeRng, generateRandomSeed } from './rng.js'
import { type Driver, type MouseButton, type ResolvedDriver, defineDriver } from './drivers/types.js'
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
import { generateWheelPath } from './motion/wheel-model.js'
import { clickHoldMs, dragCarrySpeed, dragEndMs, dragStartMs, multiClickGapMs, preClickDwellMs } from './motion/click-model.js'
import { HumanTyper, type TyperInput } from './typing/typer.js'
import type { BoundingBox } from './math.js'
import type {
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

const pointInBox = (p: Vector, b: BoundingBox): boolean =>
  p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height

interface FocusedField {
  /** Viewport box in top-page coordinates. */
  box: BoundingBox
  empty: boolean
  /** Whether the field's whole content is selected. */
  selection: 'all' | 'partial'
  /** Paragraph count; triple-click selects one paragraph at a time. */
  lines: number
  /** An <input>: triple-click selects it all wherever it lands. */
  singleLine: boolean
  /**
   * The first line's text span (x from..to, y band), in top-page coordinates.
   * Firefox selects nothing when a triple-click in a textarea or editor lands
   * in the blank space after the text.
   */
  firstLineSpan: { left: number; right: number; top: number; bottom: number }
  /** Rendered line count (wrapped paragraphs span several). */
  visualLines: number
  scrollTop: number
  /** A point on the first line of text (near its start), in top-page coordinates. */
  firstLine: Vector
}

/**
 * Page function for clearExisting: the focused field, found by following focus
 * through open shadow roots and same-origin iframes. Null when no field has
 * focus (or it sits in a cross-origin frame). Tag names, not instanceof, since
 * elements in an iframe belong to that frame's realm.
 */
const focusedField = (): FocusedField | null => {
  let el = document.activeElement as HTMLElement | null
  let ox = 0
  let oy = 0
  for (;;) {
    if (!el) return null
    if (el.shadowRoot?.activeElement) {
      el = el.shadowRoot.activeElement as HTMLElement
    } else if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      let doc: Document | null = null
      try {
        doc = (el as HTMLIFrameElement).contentDocument
      } catch {
        doc = null
      }
      if (!doc) return null
      const fr = el.getBoundingClientRect()
      ox += fr.x + el.clientLeft
      oy += fr.y + el.clientTop
      el = doc.activeElement as HTMLElement | null
    } else {
      break
    }
  }
  const doc = el.ownerDocument
  // A frame's body only counts when it is itself the editor (designMode or
  // contenteditable), as rich-text editors built on iframes do.
  if (el === doc.body && !el.isContentEditable) return null
  const r = el.getBoundingClientRect()
  const cs = (doc.defaultView ?? window).getComputedStyle(el)
  const isTextControl = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
  const control = el as HTMLInputElement
  const text = isTextControl ? control.value : el.innerText.replace(/\n+$/, '')
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
  let firstLine = {
    x: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + 6,
    y: r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - el.scrollTop + lineHeight / 2,
  }
  const contentLeft = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)
  const lineTop = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - el.scrollTop
  let span = { left: contentLeft, right: contentLeft, top: lineTop, bottom: lineTop + lineHeight }
  if (el.tagName === 'TEXTAREA') {
    const ctx = doc.createElement('canvas').getContext('2d')
    if (ctx) {
      ctx.font = cs.font
      span.right = contentLeft + ctx.measureText(text.split('\n')[0]).width
    }
  }
  let selection: 'all' | 'partial'
  if (isTextControl) {
    // email/number inputs expose no selection range; they are single-line,
    // which triple-click always selects whole.
    selection =
      control.selectionStart == null || (control.selectionStart === 0 && control.selectionEnd === text.length)
        ? 'all'
        : 'partial'
  } else {
    selection = String(doc.getSelection()).trim() === el.innerText.trim() ? 'all' : 'partial'
    // Rich content: aim at the first visible character instead.
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent ?? '').search(/\S/)
      if (i < 0) continue
      const range = doc.createRange()
      range.setStart(n, i)
      range.setEnd(n, i + 1)
      const c = range.getBoundingClientRect()
      firstLine = { x: c.left + c.width / 2 + 4, y: c.top + c.height / 2 }
      range.setEnd(n, (n.textContent ?? '').length)
      const line = range.getClientRects()[0] ?? c
      span = { left: c.left, right: line.right, top: line.top, bottom: line.bottom }
      break
    }
  }
  return {
    box: { x: r.x + ox, y: r.y + oy, width: r.width, height: r.height },
    empty: text.trim() === '',
    selection,
    lines: text === '' ? 1 : text.split('\n').length,
    singleLine: el.tagName === 'INPUT',
    firstLineSpan: { left: span.left + ox, right: span.right + ox, top: span.top + oy, bottom: span.bottom + oy },
    visualLines: Math.ceil(el.scrollHeight / lineHeight),
    scrollTop: el.scrollTop,
    firstLine: { x: firstLine.x + ox, y: firstLine.y + oy },
  }
}

/** One pass of the container-aware scroll planner (see computeScrollPlan). */
interface ScrollPlan {
  /** Target's click region is on-screen, inside the clear band, and unoccluded. */
  inView: boolean
  /** Wheel delta for the chosen scroller this pass; 0 when nothing can move the target. */
  deltaY: number
  hoverX: number
  hoverY: number
  /** The chosen scroller is the page (drives wheel-multiplier calibration). */
  isPage: boolean
  /**
   * Visible, clickable clip of the target: element rect ∩ ancestor scroller
   * rects ∩ pinned-bar clear band. Null when nothing usable is on-screen —
   * callers must NOT move toward the element in that case (that is the
   * edge-riding failure mode this exists to prevent).
   */
  region: BoundingBox | null
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
   * Clear fields with a keyboard select-all (this modifier + A) instead of the
   * default triple-click. Off by default because the modifier reveals the real
   * OS: pages can read `ctrlKey`/`metaKey`, and browsers only honor the one for
   * the OS they actually run on (Cmd on macOS, Ctrl elsewhere), whatever
   * `navigator.platform` claims. Use it for editors where triple-click fails.
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

/** A human-like cursor bound to a {@link Driver}. */
export class Cursor {
  private readonly driver: ResolvedDriver
  private readonly rng: Rng
  private readonly seed: number
  private readonly settings: MyuriSettings
  private readonly defaults: NonNullable<CursorOptions['defaults']>
  private readonly selectAllModifier: 'Control' | 'Meta' | undefined
  private typer: HumanTyper

  private previous: Vector
  /** `Date.now()` of the last mouse move, for the pause before a press. */
  private lastMoveAt = 0
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
    this.selectAllModifier = options.selectAllModifier
    this.previous = options.start ?? getBetterStartingPosition(options.dimensions, this.rng)

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
    return { ...this.previous }
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

  /**
   * Press and release a button where the cursor is, timed like a person: the
   * first click of a gesture waits a drawn beat after the last move, and the
   * button is held for a drawn time (see `motion/click-model.ts`).
   */
  private async press(button: MouseButton, clickCount: number, holdMs?: number): Promise<void> {
    if (clickCount === 1) await delay(this.lastMoveAt + preClickDwellMs(this.rng) - Date.now())
    const drawn = clickHoldMs(this.rng)
    await this.driver.click(button, clickCount, holdMs ?? drawn)
  }

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
      this.lastMoveAt = Date.now()
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

      // The mouse can only travel within the visible viewport, so a target
      // outside it (e.g. a form field far below the fold) must be scrolled in
      // first — via the stealthy wheel model, never an instant scrollIntoView.
      // Loop over fresh plans: the wheel multiplier calibrates on the first
      // pass (a single scroll can undershoot a far target), and each pass may
      // escalate to an outer scroller once an inner one is exhausted.
      const scrollOpts: ScrollOptions = {
        finishPosition: this.settings.scroll.finishPosition,
        speedFactor: this.settings.scroll.speedFactor,
        realism: { ...this.settings.scroll.realism },
      }
      const finishPosition = scrollOpts.finishPosition ?? 0.5
      let plan = await this.computeScrollPlan(selector, finishPosition)
      for (let s = 0; s < 3 && plan && !plan.inView && Math.abs(plan.deltaY) >= 1; s++) {
        await this.performScroll(plan, scrollOpts)
        plan = await this.computeScrollPlan(selector, finishPosition)
      }
      if (!plan) {
        lastError = new Error(`myuri: element has no box: ${selector}`)
        continue
      }
      // No usable on-screen region even after scrolling: fail the attempt
      // WITHOUT moving. Walking toward a clamped point at the viewport edge
      // (the old behavior) reads as robotic and can never land anyway.
      if (!plan.region) {
        lastError = new Error(
          `myuri: could not bring ${selector} into view (off-screen or covered by a pinned overlay)`,
        )
        continue
      }

      const excludeBoxes = await this.resolveExcludeBoxes(opts.excludeSelectors)
      // Widen the retry sample slightly each attempt to escape a repeated miss.
      const attemptOpts = attempt === 0 ? opts : { ...opts, widthPaddingPercentage: Math.max(0, (opts.widthPaddingPercentage ?? 25) - this.settings.correction.retrySpread * attempt) }
      // Sample from the on-screen clip of the target, so a partially covered
      // or partially scrolled-in element is clicked on its visible part.
      const destination = getRandomBoxPoint(plan.region, attemptOpts, this.previous, excludeBoxes, this.rng)

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
    const opts: DragOptions = {
      button: 'left',
      waitForRelease: 50,
      widthPaddingPercentage: 25,
      heightPaddingPercentage: 70,
      waitForSelector: 10000,
      maxTries: 3,
      overshootThreshold: this.settings.overshoot.threshold,
      moveSpeed: 1,
      ...this.defaults.move,
      ...options,
    }
    const button = opts.button ?? 'left'
    const wasRandom = this.startAction()
    try {
      if (typeof from === 'string') await this.moveToElement(from, { ...opts, moveDelay: 0, randomizeMoveDelay: false })
      else await this.moveAlong(from, opts, false)
      await delay(this.lastMoveAt + preClickDwellMs(this.rng) - Date.now())
      await this.driver.mouseDown(button)
      let released = false
      try {
        await delay(dragStartMs(this.rng))
        let target: Vector
        if (typeof to === 'string') {
          const box = await boundingBoxOf(this.driver, to)
          if (!box) throw new Error(`myuri: drag target not found or not visible: ${to}`)
          target = getRandomBoxPoint(box, opts, this.previous, [], this.rng)
        } else {
          target = to
        }
        // Carrying something, people move slower and steer straight to the drop: no overshoot.
        const moveSpeed = (opts.moveSpeed ?? 1) * dragCarrySpeed(this.rng)
        await this.moveAlong(target, { ...opts, moveSpeed }, false)
        await delay(this.lastMoveAt + dragEndMs(this.rng) - Date.now())
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
      const count = Math.max(1, Math.min(3, Math.round(opts.clickCount ?? 1)))
      for (let clickCount = 1; clickCount <= count; clickCount++) {
        if (clickCount > 1) await delay(multiClickGapMs(this.rng))
        await this.press(opts.button ?? 'left', clickCount, opts.holdMs)
      }
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
   * at the cursor, so it counts as click 1 of the triple.
   */
  private async clearFocusedField(focusClicked: boolean): Promise<void> {
    let field = await this.driver.evaluate(focusedField, null)
    if (!field) throw new Error('myuri: clearExisting needs a focused field (pass a selector)')
    if (field.empty) return
    if (this.selectAllModifier) {
      await this.typer.deleteAll({ count: 0, selectAllModifier: this.selectAllModifier })
    } else {
      if (!pointInBox(this.previous, field.box)) {
        await this.moveAlong(getRandomBoxPoint(field.box, {}, this.previous, [], this.rng), {}, false)
        focusClicked = false
      }
      let firstClick = focusClicked ? 2 : 1
      const s = field.firstLineSpan
      const onFirstLine =
        s == null ||
        (this.previous.x >= s.left && this.previous.x <= s.right - 2 && this.previous.y >= s.top && this.previous.y <= s.bottom)
      if (field.lines > 1 || (field.singleLine === false && !onFirstLine)) {
        // Triple-click selects one paragraph, so start on the first one: wheel
        // the field back to its top if needed, then triple-click there. One
        // line in a textarea or editor needs it too unless the cursor is
        // already on the text (see firstLineSpan).
        for (let i = 0; i < 30 && field.scrollTop > 0; i++) {
          await this.driver.wheel(0, -Math.min(field.scrollTop, 80 + this.rng() * 80))
          await delay(30 + this.rng() * 40)
          field = (await this.driver.evaluate(focusedField, null)) ?? field
        }
        const { x, y } = field.firstLine
        await this.moveAlong({ x: x + this.rng() * 12, y: y + (this.rng() - 0.5) * 3 }, {}, false)
        firstClick = 1
      }
      for (let clickCount = firstClick; clickCount <= 3; clickCount++) {
        if (clickCount > 1) await delay(multiClickGapMs(this.rng))
        await this.press('left', clickCount)
      }
      if (field.lines > 1) {
        await delay(120 + this.rng() * 120)
        await this.driver.down('Shift')
        const maxPresses = Math.max(field.lines, field.visualLines) + 2
        for (let i = 0; i < maxPresses && (await this.driver.evaluate(focusedField, null))?.selection === 'partial'; i++) {
          await this.driver.press('ArrowDown')
          await delay(40 + this.rng() * 60)
        }
        await this.driver.up('Shift')
      }
      await delay(60 + this.rng() * 90)
      await this.typer.deleteAll({ count: 1 })
    }
    if (!(await this.driver.evaluate(focusedField, null))?.empty) {
      throw new Error('myuri: clearExisting could not empty the focused field')
    }
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
        await this.clearFocusedField(selector != null)
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
      const finishPosition = opts.finishPosition ?? 0.5
      let plan = await this.computeScrollPlan(selector, finishPosition)
      for (let attempt = 0; attempt < maxTries && plan && !plan.inView && Math.abs(plan.deltaY) >= 1; attempt++) {
        await this.performScroll(plan, opts)
        plan = await this.computeScrollPlan(selector, finishPosition)
      }
    } finally {
      await this.endAction(wasRandom, { moveDelay: 0, randomizeMoveDelay: false })
    }
  }

  /**
   * Container-aware scroll plan. One pass computes:
   *
   *  - the CLEAR BAND: the viewport minus pinned (fixed/sticky) top/bottom bars,
   *    probed at the target's column — a target behind a sticky action footer is
   *    only reachable inside this band, so all positioning targets it rather
   *    than raw viewport fractions (finishPosition·vh lands exactly on a 50vh
   *    footer's edge);
   *  - the CHOSEN SCROLLER: the innermost scrollable ancestor that can actually
   *    MOVE the target toward finishPosition inside its own visible band. An
   *    exhausted scroller (a top-anchored first option in a list already at
   *    scrollTop 0) yields delta 0 and we ESCALATE to the next ancestor up the
   *    chain, ending at the page. A position:fixed ancestor caps the chain:
   *    window scroll cannot move anything inside it, so such targets are only
   *    ever revealed by scrolling their own containers (via wheel over them);
   *  - the CLICK REGION: the target's on-screen clip (element ∩ scroller rects
   *    ∩ clear band), with occlusion judged across the region — not just the
   *    center point, which passed for targets straddling a footer edge.
   */
  private async computeScrollPlan(selector: string, finishPosition: number): Promise<ScrollPlan | null> {
    const pad = Math.max(20, VIEWPORT_PADDING + 5)
    const from = this.previous
    return (await this.driver.evaluate(
      (arg: {
        selector: string
        finishPosition: number
        pad: number
        edge: number
        fromX: number
        fromY: number
      }) => {
        function resolve(s: string): Element | null {
          // `a >> b`: descend into a's shadow root; `a >>> b`: descend into a's
          // same-origin iframe document.
          if (s.includes('>>')) {
            const tokens = s.split(/\s*(>>>|>>)\s*/).filter(Boolean)
            let root: Document | ShadowRoot | Element = document
            let el: Element | null = null
            let hop = ''
            for (const t of tokens) {
              if (t === '>>' || t === '>>>') {
                hop = t
                continue
              }
              if (el) {
                if (hop === '>>>') {
                  let doc: Document | null = null
                  try {
                    doc = (el as HTMLIFrameElement).contentDocument
                  } catch {
                    doc = null // cross-origin
                  }
                  if (!doc) return null
                  root = doc
                } else {
                  root = (el as Element).shadowRoot || (el as Element)
                }
              }
              el = (root as ParentNode).querySelector(t)
              if (!el) return null
            }
            return el
          }
          if (s.indexOf('xpath=') === 0 || s[0] === '/' || s[0] === '(') {
            const expr = s.indexOf('xpath=') === 0 ? s.slice(6) : s
            try {
              return document.evaluate(expr, document, null, 9, null).singleNodeValue as Element | null
            } catch {
              return null
            }
          }
          const direct = document.querySelector(s)
          if (direct) return direct
          const stack: Array<Document | ShadowRoot> = [document]
          while (stack.length) {
            const root = stack.pop() as Document | ShadowRoot
            const found = root.querySelector(s)
            if (found) return found
            root.querySelectorAll('*').forEach((e) => {
              if ((e as Element).shadowRoot) stack.push((e as Element).shadowRoot as ShadowRoot)
            })
          }
          return null
        }
        const el = resolve(arg.selector) as HTMLElement | null
        if (!el) return null
        // Offset of a node's document viewport in top-page coordinates: mouse
        // input is page-level, so every rect from inside a same-origin iframe
        // is translated before any band/clip math.
        const frameOffset = (node: Element): { x: number; y: number } => {
          let x = 0
          let y = 0
          let win = node.ownerDocument ? node.ownerDocument.defaultView : null
          while (win && win !== window && win.frameElement) {
            const fe = win.frameElement as HTMLElement
            const fr = fe.getBoundingClientRect()
            x += fr.x + fe.clientLeft
            y += fr.y + fe.clientTop
            win = win.parent as Window & typeof globalThis
          }
          return { x, y }
        }
        type Rect = { x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number }
        const rectOf = (node: Element): Rect => {
          const r = node.getBoundingClientRect()
          const o = frameOffset(node)
          return {
            x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height,
            top: r.top + o.y, bottom: r.bottom + o.y, left: r.left + o.x, right: r.right + o.x,
          }
        }
        const styleOf = (node: Element): CSSStyleDeclaration =>
          ((node.ownerDocument && node.ownerDocument.defaultView) || window).getComputedStyle(node)
        // Is this node the root of a scrollable (i.e. window-scrolled) iframe doc?
        const isFrameDocRoot = (node: Element): boolean =>
          !!node.ownerDocument &&
          node === node.ownerDocument.documentElement &&
          node.ownerDocument.defaultView !== window
        // Walk up through shadow hosts AND same-origin frame boundaries.
        const stepUp = (node: Element): Element | null => {
          if (node.parentElement) return node.parentElement
          const r = node.getRootNode() as ShadowRoot | Document
          if ((r as ShadowRoot).host) return (r as ShadowRoot).host as Element
          try {
            return ((r as Document).defaultView?.frameElement as Element | null) ?? null
          } catch {
            return null
          }
        }
        const vh = window.innerHeight || document.documentElement.clientHeight
        const vw = window.innerWidth || document.documentElement.clientWidth
        const elRect = rectOf(el)

        // Every scrollable ancestor, innermost first. A position:fixed ancestor
        // is a hard barrier: neither the page nor anything above it can move the
        // target (fixed boxes don't move with window scroll), so the chain stops
        // there — but the fixed element itself may be the scroller (sticky-bar
        // form layouts), so it's tested for scrollability before the cut.
        const chain: HTMLElement[] = []
        let pageCanMoveTarget = true
        let cur = stepUp(el)
        let depth = 0
        while (cur && depth < 60 && cur !== document.documentElement) {
          if (isFrameDocRoot(cur)) {
            // An iframe's document scrolls through its own window — a page-step
            // scoped to the frame. Continue past it into the host document.
            const w = cur.ownerDocument.defaultView!
            if (cur.scrollHeight > w.innerHeight + 1) chain.push(cur as HTMLElement)
            cur = stepUp(cur)
            depth++
            continue
          }
          const st = styleOf(cur)
          const scrollable =
            cur.scrollHeight > cur.clientHeight + 1 &&
            (st.overflowY === 'scroll' || st.overflowY === 'auto')
          if (cur.ownerDocument && cur === cur.ownerDocument.body) {
            // body-as-scroller only matters when its document doesn't scroll.
            const docRoot = cur.ownerDocument.documentElement
            const docVh = cur.ownerDocument.defaultView?.innerHeight ?? vh
            if (scrollable && !(docRoot.scrollHeight > docVh + 10)) {
              chain.push(cur as HTMLElement)
            }
            if (cur === document.body) break
            cur = stepUp(cur)
            depth++
            continue
          }
          if (scrollable) chain.push(cur as HTMLElement)
          if (st.position === 'fixed') {
            // Fixed pins to its OWN frame's viewport. Only a top-document fixed
            // ancestor defeats the page-step — the host page still moves a whole
            // iframe. Inside a frame, skip to the frame element: nothing above
            // `cur` in this frame can move the target, but host scrollers can.
            if (cur.ownerDocument === document) {
              pageCanMoveTarget = false
              break
            }
            try {
              cur = (cur.ownerDocument.defaultView?.frameElement as Element | null) ?? null
            } catch {
              cur = null
            }
            depth++
            continue
          }
          cur = stepUp(cur)
          depth++
        }

        // Pinned occluder under a point: the nearest fixed/sticky ancestor of
        // whatever elementFromPoint hits there — unless it's the target itself,
        // one of its descendants, or one of its ancestors (a fixed scroll
        // container is the thing we scroll, not an occluder). Only pinned
        // occluders count: anything that scrolls WITH the target (open dropdown
        // layers, decorative wrappers) would re-occlude after every scroll and
        // wedge the retry loop into its timeout.
        // elementFromPoint that descends into same-origin iframes at the point,
        // translating into each frame's viewport coordinates as it goes.
        const hitAtPoint = (x: number, y: number): Element | null => {
          let hit = document.elementFromPoint(x, y)
          for (;;) {
            if (!hit || (hit.tagName !== 'IFRAME' && hit.tagName !== 'FRAME')) return hit
            let inner: Document | null = null
            try {
              inner = (hit as HTMLIFrameElement).contentDocument
            } catch {
              inner = null // cross-origin
            }
            if (!inner) return hit
            const fr = hit.getBoundingClientRect()
            x -= fr.x + (hit as HTMLElement).clientLeft
            y -= fr.y + (hit as HTMLElement).clientTop
            const next = inner.elementFromPoint(x, y)
            if (!next) return hit
            hit = next
          }
        }
        // `contains` across shadow and same-origin frame boundaries.
        const containsDeep = (ancestor: Element, node: Element | null): boolean => {
          let n: Element | null = node
          while (n) {
            if (n === ancestor) return true
            n = stepUp(n)
          }
          return false
        }
        const pinnedRectAt = (x: number, y: number): { top: number; bottom: number } | null => {
          const hit = hitAtPoint(x, y)
          if (!hit || hit === el || containsDeep(el, hit) || containsDeep(hit, el)) return null
          let n: Element | null = hit
          while (n && n !== document.body && n !== document.documentElement) {
            if (isFrameDocRoot(n) || (n.ownerDocument && n === n.ownerDocument.body)) {
              n = stepUp(n)
              continue
            }
            const pos = styleOf(n).position
            if (pos === 'fixed' || pos === 'sticky') {
              return containsDeep(n, el) ? null : rectOf(n)
            }
            n = stepUp(n)
          }
          return null
        }

        // Clear band: the viewport minus pinned bars, probed at the target's
        // column. Iterates a few levels for stacked bars (banner over header).
        let clearTop = arg.pad
        let clearBottom = vh - arg.pad
        const probeX = Math.min(Math.max(elRect.left + elRect.width / 2, 5), vw - 5)
        for (let i = 0; i < 4; i++) {
          const r = pinnedRectAt(probeX, clearTop + 1)
          if (r && r.bottom > clearTop) clearTop = Math.min(r.bottom + 2, vh)
          else break
        }
        for (let i = 0; i < 4; i++) {
          const r = pinnedRectAt(probeX, clearBottom - 1)
          if (r && r.top < clearBottom) clearBottom = Math.max(r.top - 2, 0)
          else break
        }
        if (clearBottom - clearTop < 40) {
          // Band collapsed (e.g. a full-screen fixed overlay): fall back to the
          // padded viewport so scroll math stays sane; the region occlusion
          // check below still reports the target unreachable if it truly is.
          clearTop = arg.pad
          clearBottom = vh - arg.pad
        }

        // Visible band of a chain scroller: for an iframe doc root that's the
        // frame ELEMENT's box (the content box is taller than the viewport).
        const scrollerRectOf = (c: Element): Rect => {
          if (isFrameDocRoot(c)) {
            try {
              const fe = c.ownerDocument.defaultView?.frameElement as Element | null
              if (fe) return rectOf(fe)
            } catch { /* cross-origin — fall through */ }
          }
          return rectOf(c)
        }
        // Click region: the target's on-screen clip. Element rect ∩ every
        // ancestor scroller's rect ∩ clear band ∩ viewport edges.
        let clipTop = clearTop
        let clipBottom = clearBottom
        let clipLeft = arg.edge
        let clipRight = vw - arg.edge
        for (const c of chain) {
          const cr = scrollerRectOf(c)
          clipTop = Math.max(clipTop, cr.top)
          clipBottom = Math.min(clipBottom, cr.bottom)
          clipLeft = Math.max(clipLeft, cr.left)
          clipRight = Math.min(clipRight, cr.right)
        }
        const regionLeft = Math.max(elRect.left, clipLeft)
        const regionTop = Math.max(elRect.top, clipTop)
        const regionRight = Math.min(elRect.right, clipRight)
        const regionBottom = Math.min(elRect.bottom, clipBottom)
        const region =
          regionRight - regionLeft >= 6 && regionBottom - regionTop >= 6
            ? {
                x: regionLeft,
                y: regionTop,
                width: regionRight - regionLeft,
                height: regionBottom - regionTop,
              }
            : null

        // Occlusion across the click region (center + 4 interior points), not
        // just the element center — a target straddling a footer edge has a
        // clear center but a covered click region.
        let occluded = false
        if (region) {
          const cx = region.x + region.width / 2
          const cy = region.y + region.height / 2
          const samples: Array<[number, number]> = [
            [cx, cy],
            [cx - region.width * 0.3, cy],
            [cx + region.width * 0.3, cy],
            [cx, cy - region.height * 0.3],
            [cx, cy + region.height * 0.3],
          ]
          occluded = samples.some(([px, py]) => pinnedRectAt(Math.round(px), Math.round(py)) != null)
        }

        const bandHeight = clipBottom - clipTop
        const fullyVisible = elRect.top >= clipTop && elRect.bottom <= clipBottom
        // A target taller than its band can never be fully contained; it's in
        // view once it fills most of the band.
        const tallTarget = elRect.height > bandHeight - 4
        const inView =
          region != null &&
          !occluded &&
          (fullyVisible || (tallTarget && region.height >= bandHeight * 0.6))

        // Chosen scroller: innermost ancestor whose scroll can actually MOVE the
        // target toward finishPosition inside ITS visible band (its rect ∩ outer
        // scroller rects ∩ clear band). delta 0 = exhausted (or already placed):
        // escalate to the next ancestor, ending at the page when permitted.
        let chosen: HTMLElement | null = null
        let chosenDelta = 0
        let chosenIsPage = false
        let hoverTop = clearTop
        let hoverBottom = clearBottom
        let hoverLeft = 5
        let hoverRight = vw - 5
        const steps = chain.length + (pageCanMoveTarget ? 1 : 0)
        for (let i = 0; i < steps; i++) {
          const isPageStep = i === chain.length
          const node = isPageStep ? (document.documentElement as HTMLElement) : chain[i]
          let bTop = clearTop
          let bBottom = clearBottom
          let bLeft = 5
          let bRight = vw - 5
          if (!isPageStep) {
            const r = scrollerRectOf(node)
            bTop = Math.max(bTop, r.top)
            bBottom = Math.min(bBottom, r.bottom)
            bLeft = Math.max(bLeft, r.left)
            bRight = Math.min(bRight, r.right)
            for (let j = i + 1; j < chain.length; j++) {
              const outer = scrollerRectOf(chain[j])
              bTop = Math.max(bTop, outer.top)
              bBottom = Math.min(bBottom, outer.bottom)
              bLeft = Math.max(bLeft, outer.left)
              bRight = Math.min(bRight, outer.right)
            }
          }
          const bH = bBottom - bTop
          // A band too small to ever show the target can't help — skip outward.
          if (bH < Math.min(elRect.height, 24) + 6) continue
          const desiredTop = bTop + Math.max(0, bH - elRect.height) * arg.finishPosition
          // An iframe doc root scrolls through its own window (Gecko reports
          // scrollTop 0 on document roots).
          const frameWin = isFrameDocRoot(node) ? node.ownerDocument.defaultView! : null
          const current = isPageStep ? window.scrollY : frameWin ? frameWin.scrollY : node.scrollTop
          const maxScroll = isPageStep
            ? Math.max(0, document.documentElement.scrollHeight - vh)
            : frameWin
              ? Math.max(0, node.scrollHeight - frameWin.innerHeight)
              : Math.max(0, node.scrollHeight - node.clientHeight)
          const target = Math.max(0, Math.min(current + (elRect.top - desiredTop), maxScroll))
          const delta = target - current
          if (Math.abs(delta) >= 1) {
            chosen = node
            chosenDelta = delta
            chosenIsPage = isPageStep
            hoverTop = bTop
            hoverBottom = bBottom
            hoverLeft = bLeft
            hoverRight = bRight
            break
          }
        }

        // Hover: the NEAREST point to the cursor from which a wheel actually
        // reaches the chosen scroller. Humans scroll from wherever the mouse
        // sits and nudge toward a gutter when an inner scroller (open dropdown
        // list, overflowing textarea) would swallow the wheel — so probe small
        // lateral offsets first, then small vertical ones. For a container the
        // walk up from the hit must MEET the scroller: a point over a fixed
        // footer never scrolls the container behind it. The hover stays inside
        // the scroller's visible band ∩ clear band, never over a pinned bar.
        const clampHX = (x: number) =>
          Math.min(Math.max(x, Math.max(hoverLeft + 5, 5)), Math.min(hoverRight - 5, vw - 5))
        const clampHY = (y: number) =>
          Math.min(Math.max(y, Math.max(hoverTop + 5, 5)), Math.min(hoverBottom - 5, vh - 5))
        // Wheel routing matches Chromium: a wheel is consumed by the nearest
        // scrollable ancestor that can still MOVE in the wheel's direction, and
        // bubbles past one already at its limit. Treating every overflow:auto
        // wrapper as a trap (the old probe) nudged the cursor sideways on
        // layouts full of decorative scroll wrappers even though the wheel
        // would have landed fine where it sat.
        const consumesWheel = (n: Element): boolean => {
          if (isFrameDocRoot(n)) {
            // A wheel over a scrollable iframe doc is consumed by the frame's
            // window until it hits its limit, then bubbles to the host.
            const w = n.ownerDocument.defaultView!
            return chosenDelta > 0
              ? w.scrollY + w.innerHeight < n.scrollHeight - 1
              : w.scrollY > 1
          }
          const st = styleOf(n)
          if (st.overflowY !== 'auto' && st.overflowY !== 'scroll') return false
          if (n.scrollHeight <= n.clientHeight + 1) return false
          return chosenDelta > 0
            ? n.scrollTop + n.clientHeight < n.scrollHeight - 1
            : n.scrollTop > 1
        }
        const wheelReaches = (x: number, y: number): boolean => {
          const hit = hitAtPoint(x, y)
          if (!hit) return chosenIsPage
          let n: Element | null = hit
          while (n && n !== document.documentElement && n !== document.body) {
            if (!chosenIsPage && n === chosen) return true
            if (consumesWheel(n)) return false
            n = stepUp(n)
          }
          return chosenIsPage
        }
        let hoverX = clampHX(arg.fromX)
        let hoverY = clampHY(arg.fromY)
        if (chosen) {
          // Equal-distance probes break toward the side with more gutter room,
          // so asymmetric layouts don't accumulate a systematic drift from a
          // fixed left-first order.
          const roomLeft = arg.fromX - Math.max(hoverLeft + 5, 5)
          const roomRight = Math.min(hoverRight - 5, vw - 5) - arg.fromX
          const lateral =
            roomRight > roomLeft
              ? [0, 60, -60, 120, -120, 200, -200]
              : [0, -60, 60, -120, 120, -200, 200]
          const baseY = hoverY
          probe: for (const dy of [0, -40, 40, -90, 90]) {
            const y = clampHY(baseY + dy)
            for (const dx of lateral) {
              const x = clampHX(arg.fromX + dx)
              if (wheelReaches(x, y)) {
                hoverX = x
                hoverY = y
                break probe
              }
            }
          }
        }
        return { inView, deltaY: chosenDelta, hoverX, hoverY, isPage: chosenIsPage, region }
      },
      { selector, finishPosition, pad, edge: VIEWPORT_PADDING, fromX: from.x, fromY: from.y },
    )) as ScrollPlan | null
  }

  /** Execute one planned scroll pass: hover over the chosen scroller, wheel the delta. */
  private async performScroll(plan: ScrollPlan, opts: ScrollOptions): Promise<void> {
    const wantedDistance = plan.deltaY * (this.scrollMultiplier ?? 1)
    if (Math.abs(wantedDistance) < 1) return

    // Hover over the chosen scroller so the wheel scrolls IT, not the page.
    await this.moveAlong(
      { x: plan.hoverX, y: plan.hoverY },
      { moveDelay: 0, randomizeMoveDelay: false },
      false,
    )

    // Calibration reads window scroll, so only calibrate off page scrolls (the
    // wheel→px DPR ratio is identical for containers).
    const pre = plan.isPage ? (await scrollMetricsOf(this.driver)).offset : null
    const speedIrregularity = opts.realism?.speedIrregularity ?? this.settings.scroll.realism.speedIrregularity
    const mouse = this.settings.scroll.device === 'mouse'
    const events = mouse
      ? generateWheelPath(wantedDistance, this.rng, this.settings.scroll.wheel)
      : scrollModel.generateScrollPath(wantedDistance, this.rng, undefined, speedIrregularity)
    // A wheel moves in whole notches, so calibrate against what was sent.
    const dispatched = events.reduce((sum, ev) => sum + ev.deltaY, 0)
    const sf = opts.speedFactor ?? 1

    // Emit the gesture on the model's clock, like an input device: never wait
    // for the page to acknowledge an event before sending the next. A browser
    // acknowledges a wheel event only on its next frame (~16.7 ms at 60 Hz),
    // so awaiting each one stretched gestures planned at ~8 ms cadence to
    // 1.25-1.6x their intended duration. Events queued in the browser meanwhile
    // are handled natively (Chromium coalesces them; Firefox delivers each), as
    // they would be from real hardware. Every driver sends over a single
    // connection, so they arrive in order.
    const sent: Promise<void>[] = []
    const failure: { error?: unknown } = {}
    const send = (deltaY: number): void => {
      const wheel = this.driver.wheel(0, deltaY)
      sent.push(wheel)
      wheel.catch((error: unknown) => {
        if (!('error' in failure)) failure.error = error
      })
    }

    // Batch sub-threshold deltas: Chromium ignores very small wheel deltas.
    let accumulator = 0
    const start = Date.now()
    let due = 0
    for (const ev of events) {
      if ('error' in failure) break // e.g. the page closed mid-gesture
      accumulator += ev.deltaY
      // A notch is one event however small; only trackpad deltas batch.
      if (mouse || Math.abs(accumulator) >= 8) {
        const dispatch = Math.trunc(accumulator)
        accumulator -= dispatch
        send(dispatch)
      }
      // An absolute schedule, so timer overshoot doesn't accumulate.
      due += ev.deltaTime / sf
      await delay(start + due - Date.now())
    }
    if (!('error' in failure) && Math.abs(Math.round(accumulator)) >= 1) send(Math.round(accumulator))
    // Everything must have landed (or failed) before measuring where the
    // scroll ended.
    await Promise.all(sent)

    if (pre != null) {
      const post = await this.settleScroll(pre)
      const actualDelta = post - pre
      if (this.scrollMultiplier == null && Math.abs(dispatched) > 10 && Math.abs(actualDelta) > 10) {
        // Clamp: a first scroll truncated by maxScroll (or partially consumed by
        // an inner scroller) would otherwise poison every subsequent scroll with
        // a wildly inflated multiplier.
        this.scrollMultiplier = Math.min(3, Math.max(0.3, Math.round((dispatched / actualDelta) * 100) / 100))
      }
    } else {
      await delay(120) // let the container settle (window-scroll settle doesn't apply)
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
