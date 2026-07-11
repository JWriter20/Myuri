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
  private typer: HumanTyper

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
      keyDelay: this.settings.typing.keyDelay,
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
   * precise fields like emails/dates). Rebuilds the typer on the SAME rng stream,
   * so motion/timing determinism for a given seed is preserved.
   */
  setMistakeMultiplier(multiplier: number): void {
    ;(this.settings.typing as { mistakeMultiplier: number }).mistakeMultiplier = multiplier
    this.typer = new HumanTyper(
      {
        press: (key, opts) => this.driver.press(key, opts),
        down: (key) => this.driver.down(key),
        up: (key) => this.driver.up(key),
      },
      {
        wpm: this.settings.typing.wpm,
        layout: this.settings.typing.layout,
        mistakeMultiplier: multiplier,
        keyDelay: this.settings.typing.keyDelay,
        rng: this.rng,
      },
    )
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
          // Playwright shadow-piercing selector (a >> b >> c): descend into each
          // matched element's shadow root for the next segment.
          if (s.includes('>>')) {
            const parts = s.split(/\s*>>\s*/).filter(Boolean)
            let root: Document | ShadowRoot | Element = document
            let el: Element | null = null
            for (const part of parts) {
              el = (root as ParentNode).querySelector(part)
              if (!el) return null
              root = (el as Element).shadowRoot || (el as Element)
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
        const stepUp = (node: Element): Element | null => {
          if (node.parentElement) return node.parentElement
          const r = node.getRootNode() as ShadowRoot
          return r && r.host ? (r.host as Element) : null
        }
        const vh = window.innerHeight || document.documentElement.clientHeight
        const vw = window.innerWidth || document.documentElement.clientWidth
        const elRect = el.getBoundingClientRect()

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
          const st = getComputedStyle(cur)
          const scrollable =
            cur.scrollHeight > cur.clientHeight + 1 &&
            (st.overflowY === 'scroll' || st.overflowY === 'auto')
          if (cur === document.body) {
            // body-as-scroller only matters when the page itself doesn't scroll.
            if (scrollable && !(document.documentElement.scrollHeight > vh + 10)) {
              chain.push(cur as HTMLElement)
            }
            break
          }
          if (scrollable) chain.push(cur as HTMLElement)
          if (st.position === 'fixed') {
            pageCanMoveTarget = false
            break
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
        const pinnedRectAt = (x: number, y: number): { top: number; bottom: number } | null => {
          const hit = document.elementFromPoint(x, y)
          if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null
          let n: Element | null = hit
          while (n && n !== document.body && n !== document.documentElement) {
            const pos = getComputedStyle(n).position
            if (pos === 'fixed' || pos === 'sticky') {
              return n.contains(el) ? null : n.getBoundingClientRect()
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

        // Click region: the target's on-screen clip. Element rect ∩ every
        // ancestor scroller's rect ∩ clear band ∩ viewport edges.
        let clipTop = clearTop
        let clipBottom = clearBottom
        let clipLeft = arg.edge
        let clipRight = vw - arg.edge
        for (const c of chain) {
          const cr = c.getBoundingClientRect()
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
            const r = node.getBoundingClientRect()
            bTop = Math.max(bTop, r.top)
            bBottom = Math.min(bBottom, r.bottom)
            bLeft = Math.max(bLeft, r.left)
            bRight = Math.min(bRight, r.right)
            for (let j = i + 1; j < chain.length; j++) {
              const outer = chain[j].getBoundingClientRect()
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
          const current = isPageStep ? window.scrollY : node.scrollTop
          const maxScroll = isPageStep
            ? Math.max(0, document.documentElement.scrollHeight - vh)
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
          const st = getComputedStyle(n)
          if (st.overflowY !== 'auto' && st.overflowY !== 'scroll') return false
          if (n.scrollHeight <= n.clientHeight + 1) return false
          return chosenDelta > 0
            ? n.scrollTop + n.clientHeight < n.scrollHeight - 1
            : n.scrollTop > 1
        }
        const wheelReaches = (x: number, y: number): boolean => {
          const hit = document.elementFromPoint(x, y)
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

    if (pre != null) {
      const post = await this.settleScroll(pre)
      const actualDelta = post - pre
      if (this.scrollMultiplier == null && Math.abs(wantedDistance) > 10 && Math.abs(actualDelta) > 10) {
        // Clamp: a first scroll truncated by maxScroll (or partially consumed by
        // an inner scroller) would otherwise poison every subsequent scroll with
        // a wildly inflated multiplier.
        this.scrollMultiplier = Math.min(3, Math.max(0.3, Math.round((wantedDistance / actualDelta) * 100) / 100))
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
