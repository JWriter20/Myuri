import { type Driver, type MouseButton, type PageFunction, type PressOptions } from './types.js'

/**
 * Minimal structural shape of a Playwright `Page`. Declared locally so myuri has
 * no hard dependency on `playwright-core` (it is an optional peer). Any object
 * with these members works — real Playwright pages, patchright, camoufox-js.
 */
export interface PlaywrightLikePage {
  mouse: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>
    down(options?: { button?: MouseButton; clickCount?: number }): Promise<void>
    up(options?: { button?: MouseButton; clickCount?: number }): Promise<void>
    wheel(deltaX: number, deltaY: number): Promise<void>
  }
  keyboard: {
    down(key: string): Promise<void>
    up(key: string): Promise<void>
    press(key: string, options?: { delay?: number }): Promise<void>
    insertText(text: string): Promise<void>
  }
  // Playwright's evaluate has many overloads; this is the (fn, arg) form we use.
  evaluate<A, R>(fn: PageFunction<A, R>, arg: A): Promise<R>
  isClosed(): boolean
}

/** Hold when the caller gives none; the cursor passes one drawn per click. */
const CLICK_HOLD_MS = 95

/**
 * Default driver: wraps a Playwright-compatible page. Mouse position is tracked
 * so `click()` presses at the last moved-to point.
 */
export function playwrightDriver(page: PlaywrightLikePage): Driver {
  return {
    async move(x, y) {
      await page.mouse.move(x, y)
    },
    async click(button: MouseButton = 'left', clickCount = 1, holdMs = CLICK_HOLD_MS) {
      await page.mouse.down({ button, clickCount })
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs))
      await page.mouse.up({ button, clickCount })
    },
    async mouseDown(button: MouseButton = 'left') {
      await page.mouse.down({ button })
    },
    async mouseUp(button: MouseButton = 'left') {
      await page.mouse.up({ button })
    },
    async down(key) {
      await page.keyboard.down(key)
    },
    async up(key) {
      await page.keyboard.up(key)
    },
    async wheel(deltaX, deltaY) {
      await page.mouse.wheel(deltaX, deltaY)
    },
    async press(key, options?: PressOptions) {
      await page.keyboard.press(key, options?.delay != null ? { delay: options.delay } : undefined)
    },
    async insertText(text) {
      await page.keyboard.insertText(text)
    },
    evaluate<A, R>(fn: PageFunction<A, R>, arg: A): Promise<R> {
      return page.evaluate(fn, arg)
    },
    isClosed() {
      return page.isClosed()
    },
  }
}
