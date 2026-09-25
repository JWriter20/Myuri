import { type Driver, type MouseButton, type PageFunction, type PressOptions } from './types.js'

/** Structural shape of a Puppeteer `Page`. */
export interface PuppeteerLikePage {
  mouse: {
    move(x: number, y: number): Promise<void>
    down(options?: { button?: MouseButton; clickCount?: number }): Promise<void>
    up(options?: { button?: MouseButton; clickCount?: number }): Promise<void>
    wheel(options: { deltaX?: number; deltaY?: number }): Promise<void>
  }
  keyboard: {
    down(key: string): Promise<void>
    up(key: string): Promise<void>
    press(key: string, options?: { delay?: number }): Promise<void>
  }
  evaluate<A, R>(fn: PageFunction<A, R>, arg: A): Promise<R>
  isClosed(): boolean
}

const CLICK_HOLD_MS = 45

/** Driver wrapping a Puppeteer page. `insertText` falls back to clipboard paste. */
export function puppeteerDriver(page: PuppeteerLikePage): Driver {
  return {
    async move(x, y) {
      await page.mouse.move(x, y)
    },
    async click(button: MouseButton = 'left', clickCount = 1) {
      await page.mouse.down({ button, clickCount })
      if (CLICK_HOLD_MS > 0) await new Promise((r) => setTimeout(r, CLICK_HOLD_MS))
      await page.mouse.up({ button, clickCount })
    },
    async down(key) {
      await page.keyboard.down(key)
    },
    async up(key) {
      await page.keyboard.up(key)
    },
    async wheel(deltaX, deltaY) {
      await page.mouse.wheel({ deltaX, deltaY })
    },
    async press(key, options?: PressOptions) {
      await page.keyboard.press(key, options?.delay != null ? { delay: options.delay } : undefined)
    },
    evaluate<A, R>(fn: PageFunction<A, R>, arg: A): Promise<R> {
      return page.evaluate(fn, arg)
    },
    isClosed() {
      return page.isClosed()
    },
  }
}
