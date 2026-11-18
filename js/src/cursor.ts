import { type Vector, pointInBox } from './math.js'
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
  getRandomBoxPoint,
  getBetterStartingPosition,
  clampToBrowserBounds,
  shouldOvershoot,
  type PlannedPoint,
} from './geometry.js'
import { SCROLL_EDGE, SCROLL_PAD, SCROLL_PLAN_FOR_SELECTOR, type ScrollPlan } from './scroll-plan.js'
import { dragCarrySpeed, dragEndMs, dragStartMs, preClickDwellMs } from './motion/click-model.js'
import { clicksWith, moveWith, planClick, wheelStyleFor, wheelWith } from './plan.js'
import { primaryModifier, type Os } from './target-os.js'
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

/** A human-like cursor bound to a {@link Driver}. */
export class Cursor {
  private readonly driver: ResolvedDriver
  private readonly rng: Rng
  private readonly seed: number
  private readonly settings: MyuriSettings
  private readonly defaults: NonNullable<CursorOptions['defaults']>
  private readonly selectAllModifier: 'Control' | 'Meta' | undefined
  private readonly os: Os | undefined
  private typer: HumanTyper

  private previous: Vector
  /** The browser's pointer is at `previous` (until the first move it is only a guess). */
  private placed = false
  /** `Date.now()` of the last mouse move, for the pause before a press. */
  private lastMoveAt = 0
  /** `Date.now()` of the last release by `clicks`, for a run of presses in place. */
  private lastReleaseAt = Number.NEGATIVE_INFINITY
  private isMoving = false
  private performingRandomMoves = false
  private randomMoveTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** Auto-calibrated wheel scaling; driver/DPR combos apply a fraction of delta. */
  private scrollMultiplier: number | null = null

  constructor(driver: Driver, options: CursorOptions = {}) {
    if (options.os !== undefined && options.selectAllModifier !== undefined && options.selectAllModifier !== primaryModifier(options.os)) {
      throw new Error(`myuri: selectAllModifier ${options.selectAllModifier} is not select-all on ${options.os}`)
    }
    this.driver = defineDriver(driver, { os: options.os })
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
    this.settings.scroll.wheel.style = wheelStyleFor(options.os, options.settings)
    this.defaults = options.defaults ?? {}
    this.selectAllModifier = options.selectAllModifier
    this.os = options.os
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
   * Clicks `first`..`last` of a multi-click where the cursor is, timed like a
   * person (`planClick` and `clicksWith` in `plan.ts`): click 1 waits a drawn
   * beat after the last move, or, with the pointer still where it released,
   * continues that run; later ones a drawn gap after the release before.
   */
  private async clicks(button: MouseButton, first: number, last: number, holdMs?: number): Promise<void> {
    const resting = this.lastMoveAt < this.lastReleaseAt
    const { dwellMs, presses } =
      first === 1
        ? planClick(this.rng, { clickCount: last, sinceReleaseMs: resting ? Date.now() - this.lastReleaseAt : undefined })
        : (({ leadMs, presses }) => ({ dwellMs: leadMs, presses }))(clicksWith(this.rng, first, last))
    await delay(first === 1 && !resting ? this.lastMoveAt + dwellMs - Date.now() : dwellMs)
    for (let i = 0; i < presses.length; i++) {
      if (i > 0) await delay(presses[i][0] - presses[i - 1][1])
      await this.driver.click(button, first + i, holdMs ?? presses[i][1] - presses[i][0])
    }
    this.lastReleaseAt = Date.now()
  }

  private async moveAlong(destination: Vector, options: MoveToOptions, allowOvershoot: boolean): Promise<void> {
    const vp = await viewportOf(this.driver)
    const settle = (p: Vector): Vector => {
      const clamped = clampToBrowserBounds(p.x, p.y, vp)
      return { x: Math.round(clamped.x), y: Math.round(clamped.y) }
    }
    const points = moveWith(
      this.previous,
      destination,
      this.rng,
      { moveSpeed: options.moveSpeed, overshoot: allowOvershoot, settings: this.settings.overshoot },
      settle,
    )
    await this.tracePath(points, settle)
  }

  /** Move through `points` on their schedule (an absolute one, so dispatch latency doesn't accumulate). */
  private async tracePath(points: PlannedPoint[], settle: (p: Vector) => Vector): Promise<void> {
    const start = Date.now()
    for (const p of points) {
      if (this.driver.isClosed()) return
      await delay(start + p.t - Date.now())
      const pos = settle(p)
      // Only macOS reports a mouse that has not left its pixel; elsewhere it sends nothing.
      if (this.placed && this.os !== 'macos' && pos.x === this.previous.x && pos.y === this.previous.y) continue
      await this.driver.move(pos.x, pos.y)
      this.previous = pos
      this.placed = true
      this.lastMoveAt = Date.now()
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
      // A person already on the target presses where they are.
      if (
        this.placed &&
        pointInBox(this.previous, plan.region) &&
        !excludeBoxes.some((b) => pointInBox(this.previous, b)) &&
        (await pointHitsTarget(this.driver, this.previous, selector))
      ) {
        return
      }
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
      await this.clicks(opts.button ?? 'left', 1, count, opts.holdMs)
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
      await this.clicks('left', firstClick, 3)
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

  /** One pass of the scroll planner (`scroll-plan.ts`) for `selector`. */
  private async computeScrollPlan(selector: string, finishPosition: number): Promise<ScrollPlan | null> {
    const { x: fromX, y: fromY } = this.previous
    return this.driver.evaluate(SCROLL_PLAN_FOR_SELECTOR, {
      selector,
      finishPosition,
      pad: SCROLL_PAD,
      edge: SCROLL_EDGE,
      fromX,
      fromY,
    })
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
    const { events, end, total: dispatched } = wheelWith(wantedDistance, this.rng, {
      device: this.settings.scroll.device,
      wheel: this.settings.scroll.wheel,
      speedIrregularity: opts.realism?.speedIrregularity ?? this.settings.scroll.realism.speedIrregularity,
    })
    // A wheel moves in whole notches, so calibrate against the planned total.
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
    const start = Date.now()
    for (const [at, delta] of events) {
      // An absolute schedule, so timer overshoot doesn't accumulate.
      await delay(start + at / sf - Date.now())
      if ('error' in failure) break // e.g. the page closed mid-gesture
      const wheel = this.driver.wheel(0, delta)
      sent.push(wheel)
      wheel.catch((error: unknown) => {
        if (!('error' in failure)) failure.error = error
      })
    }
    await delay(start + end / sf - Date.now())
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
    this.placed = true
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
