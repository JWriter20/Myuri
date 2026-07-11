import { type BoundingBox, type ViewportSize } from '../math.js'

/** Mouse button for `click`. */
export type MouseButton = 'left' | 'right' | 'middle'

/** Options accepted by `Driver.press`. */
export interface PressOptions {
  /** Milliseconds to hold the key between keydown and keyup. */
  delay?: number
}

/**
 * A page-context function: it is serialized and executed inside the page, so it
 * may only reference its single argument and page globals (no closures over
 * Node state). Mirrors `page.evaluate(fn, arg)` in Playwright/Puppeteer and
 * `Runtime.evaluate` in raw CDP.
 */
export type PageFunction<A, R> = (arg: A) => R | Promise<R>

/**
 * The single seam myuri needs to drive a browser. Split into input primitives
 * (dispatch synthetic events) and a query seam (`evaluate`) that every DOM
 * measurement is built on. Everything geometric — element boxes, occlusion,
 * scroll offsets, viewport — runs through `evaluate`, so any backend that can
 * run JS in the page and dispatch input can be wrapped.
 *
 * Build one with {@link defineDriver}, which supplies defaults for the optional
 * members, or use a prebuilt wrapper from `myuri/drivers`.
 */
export interface Driver {
  // ---- input primitives (required) ----
  /** Move the mouse to viewport coordinates (already clamped/rounded by core). */
  move(x: number, y: number): Promise<void>
  /** Press-and-release the mouse at its current position. */
  click(button?: MouseButton): Promise<void>
  /** Press a modifier/key down (no release). */
  down(key: string): Promise<void>
  /** Release a previously held key. */
  up(key: string): Promise<void>
  /** Dispatch a wheel event at the current mouse position. */
  wheel(deltaX: number, deltaY: number): Promise<void>
  /** Press-and-release a single key by name (e.g. "a", "Enter", "Backspace"). */
  press(key: string, options?: PressOptions): Promise<void>

  // ---- query seam (required) ----
  /** Run `fn(arg)` in the page and resolve with its JSON-serializable result. */
  evaluate<A, R>(fn: PageFunction<A, R>, arg: A): Promise<R>

  // ---- optional (defaults supplied by defineDriver) ----
  /** Insert text at the focus (fast path for paste). Defaults to clipboard paste. */
  insertText?(text: string): Promise<void>
  /** Put text on the clipboard. Defaults to `navigator.clipboard` via evaluate. */
  setClipboard?(text: string): Promise<void>
  /** Whether the page/target is gone. Defaults to always-open. */
  isClosed?(): boolean
  /** Release backend resources (e.g. detach a CDP session). Defaults to no-op. */
  dispose?(): Promise<void>
}

/** A driver with every optional member resolved — what the core consumes. */
export interface ResolvedDriver extends Required<Omit<Driver, 'dispose'>> {
  dispose(): Promise<void>
}

export interface WaitForElementOptions {
  state?: 'attached' | 'visible'
  timeout?: number
}

/** Re-exported for driver authors. */
export type { BoundingBox, ViewportSize }

/**
 * Normalize a user-supplied {@link Driver} into a {@link ResolvedDriver} by
 * filling in defaults for the optional members. `setClipboard` and `insertText`
 * are implemented in terms of `evaluate`/`press` so a minimal driver only needs
 * the input primitives plus `evaluate`.
 */
export function defineDriver(driver: Driver): ResolvedDriver {
  const setClipboard =
    driver.setClipboard?.bind(driver) ??
    (async (text: string): Promise<void> => {
      await driver.evaluate(async (t: string) => {
        // Prefer the async Clipboard API; fall back to a hidden textarea for
        // pages without clipboard permission.
        const nav = navigator as Navigator & {
          clipboard?: { writeText?: (s: string) => Promise<void> }
        }
        if (nav.clipboard?.writeText) {
          await nav.clipboard.writeText(t)
          return
        }
        const ta = document.createElement('textarea')
        ta.value = t
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }, text)
    })

  const insertText =
    driver.insertText?.bind(driver) ??
    (async (text: string): Promise<void> => {
      // No native insert: place on the clipboard and paste with the platform
      // modifier. Platform is detected in-page (the *browser's* platform),
      // not from the automation host's OS.
      await setClipboard(text)
      const isMac = await driver.evaluate(
        () => /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent),
        null,
      )
      const mod = isMac ? 'Meta' : 'Control'
      await driver.down(mod)
      await driver.press('v')
      await driver.up(mod)
    })

  // Playwright/Puppeteer press() only knows named keys + US-layout printables;
  // any other single code point (an AZERTY 'é' typo slip, emoji, CJK) throws
  // "Unknown key" and aborts typing mid-field — insert those as text instead,
  // exactly what Playwright's own keyboard.type() does for such characters.
  const rawPress = driver.press.bind(driver)
  const press = async (key: string, options?: PressOptions): Promise<void> => {
    if (Array.from(key).length === 1 && !/^[\x20-\x7e]$/.test(key)) return insertText(key)
    return rawPress(key, options)
  }

  return {
    move: driver.move.bind(driver),
    click: driver.click.bind(driver),
    down: driver.down.bind(driver),
    up: driver.up.bind(driver),
    wheel: driver.wheel.bind(driver),
    press,
    evaluate: driver.evaluate.bind(driver),
    insertText,
    setClipboard,
    isClosed: driver.isClosed?.bind(driver) ?? (() => false),
    dispose: driver.dispose?.bind(driver) ?? (async () => {}),
  }
}
