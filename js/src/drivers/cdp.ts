import { type Driver, type MouseButton, type PageFunction, type PressOptions } from './types.js'

/**
 * Structural shape of a Chromium-backed Playwright page that can open a CDP
 * session. Input is dispatched via `Input.dispatchMouseEvent` (lower level than
 * Playwright's mouse), while queries and keyboard reuse the page. The CDP
 * session is created lazily and detached on `dispose()`.
 */
export interface CdpCapablePage {
  context(): {
    newCDPSession(page: CdpCapablePage): Promise<CdpSession>
  }
  keyboard: {
    down(key: string): Promise<void>
    up(key: string): Promise<void>
    press(key: string, options?: { delay?: number }): Promise<void>
    insertText(text: string): Promise<void>
  }
  evaluate<A, R>(fn: PageFunction<A, R>, arg: A): Promise<R>
  isClosed(): boolean
}

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  detach(): Promise<void>
}

const CLICK_HOLD_MS = 45

/** Chromium-only driver dispatching mouse input over CDP. */
export function cdpDriver(page: CdpCapablePage): Driver {
  let sessionPromise: Promise<CdpSession> | null = null
  let session: CdpSession | null = null
  let x = 0
  let y = 0

  const client = async (): Promise<CdpSession> => {
    if (sessionPromise == null) {
      sessionPromise = page
        .context()
        .newCDPSession(page)
        .then((s) => {
          session = s
          return s
        })
        .catch((err) => {
          sessionPromise = null
          throw err
        })
    }
    return sessionPromise
  }

  return {
    async move(nx, ny) {
      x = nx
      y = ny
      const c = await client()
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    },
    async click(button: MouseButton = 'left', clickCount = 1) {
      const c = await client()
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount })
      if (CLICK_HOLD_MS > 0) await new Promise((r) => setTimeout(r, CLICK_HOLD_MS))
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount })
    },
    async wheel(deltaX, deltaY) {
      const c = await client()
      await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
    },
    async down(key) {
      await page.keyboard.down(key)
    },
    async up(key) {
      await page.keyboard.up(key)
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
    async dispose() {
      if (session) {
        try {
          await session.detach()
        } catch {
          // session may already be gone if the page closed
        }
        session = null
        sessionPromise = null
      }
    },
  }
}
