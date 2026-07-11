import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'
import { createCursor } from '../src/index.js'
import { fromPlaywright } from '../src/drivers/index.js'
import type { Driver } from '../src/drivers/types.js'

/**
 * Live-browser regression for spurious sideways hover nudges before scrolling.
 *
 * The hover probe must model Chromium's wheel routing: a wheel is consumed by
 * the nearest scrollable ancestor that can still move in the wheel's
 * direction, and BUBBLES PAST one already at its scroll limit. The old probe
 * flagged every overflow:auto wrapper with overflow as a trap, so on layouts
 * full of decorative scroll wrappers (Workday/Greenhouse/Lever shells) the
 * cursor visibly nudged sideways before most scrolls even though the wheel
 * would have landed fine where it sat.
 */

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
})()

// An overflow-y:auto wrapper (x 250–550) under the cursor, and a target far
// below the fold that needs a PAGE scroll to reach.
const PAGE_HTML = `<!doctype html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { height: 2000px; }
  .wrapper { position: absolute; left: 250px; top: 40px; width: 300px; height: 300px; overflow-y: auto; background: #eee; }
  .inner { height: 400px; }
  #target { position: absolute; top: 1500px; left: 350px; width: 120px; height: 30px; }
</style></head><body>
  <div class="wrapper"><div class="inner"></div></div>
  <button id="target">go</button>
</body></html>`

/** Wrap a driver to record dispatched moves and wheels in order. */
function recordingDriver(inner: Driver): {
  driver: Driver
  ops: Array<{ op: 'move' | 'wheel'; x: number; y: number }>
} {
  const ops: Array<{ op: 'move' | 'wheel'; x: number; y: number }> = []
  return {
    ops,
    driver: {
      ...inner,
      move: async (x: number, y: number) => {
        ops.push({ op: 'move', x, y })
        await inner.move(x, y)
      },
      wheel: async (dx: number, dy: number) => {
        ops.push({ op: 'wheel', x: dx, y: dy })
        await inner.wheel(dx, dy)
      },
    },
  }
}

/** Cursor position when the first wheel of the run was dispatched. */
function firstWheelHover(ops: Array<{ op: string; x: number; y: number }>): { x: number; y: number } {
  const wheelIdx = ops.findIndex((o) => o.op === 'wheel')
  expect(wheelIdx).toBeGreaterThan(0)
  const lastMove = ops
    .slice(0, wheelIdx)
    .reverse()
    .find((o) => o.op === 'move')
  expect(lastMove).toBeDefined()
  return lastMove!
}

describe.skipIf(!hasChromium)('wheel routing hover probe (live browser)', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser?.close()
  })

  async function setup(wrapperScrollTop: number): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(PAGE_HTML)
    await page.evaluate((top: number) => {
      document.querySelector('.wrapper')!.scrollTop = top
    }, wrapperScrollTop)
    return page
  }

  it('does not nudge sideways over a wrapper at its scroll limit (wheel bubbles to the page)', async () => {
    const page = await setup(100) // 400 - 300 = at the bottom limit; a down-wheel bubbles past it
    const { driver, ops } = recordingDriver(fromPlaywright(page))
    const cursor = createCursor({ driver, seed: 11, start: { x: 400, y: 190 } })

    await cursor.click('#target')

    // The wheel was dispatched from (about) where the cursor already sat —
    // no sideways escape from a wrapper that cannot consume a down-wheel.
    const hover = firstWheelHover(ops)
    expect(Math.abs(hover.x - 400)).toBeLessThanOrEqual(25)
    // ...and it really did bubble: the page scrolled, the wrapper didn't move.
    expect(await page.evaluate(() => document.querySelector('.wrapper')!.scrollTop)).toBe(100)
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    await page.close()
  })

  it('still escapes a wrapper that WOULD consume the wheel (dropdown protection intact)', async () => {
    const page = await setup(0) // can scroll down: a down-wheel over it would be swallowed
    const { driver, ops } = recordingDriver(fromPlaywright(page))
    const cursor = createCursor({ driver, seed: 12, start: { x: 400, y: 190 } })

    await cursor.click('#target')

    const hover = firstWheelHover(ops)
    expect(hover.x < 250 || hover.x > 550).toBe(true)
    // The wrapper was never wheeled: the page did all the scrolling.
    expect(await page.evaluate(() => document.querySelector('.wrapper')!.scrollTop)).toBe(0)
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    await page.close()
  })

  it('breaks equal-distance probe ties toward the roomier gutter (no systematic left drift)', async () => {
    // Both escapes are the ±200 probes; the side with more room must win.
    for (const [startX, side] of [
      [390, 'right'],
      [410, 'left'],
    ] as const) {
      const page = await setup(0)
      const { driver, ops } = recordingDriver(fromPlaywright(page))
      const cursor = createCursor({ driver, seed: 13, start: { x: startX, y: 190 } })
      await cursor.click('#target')
      const hover = firstWheelHover(ops)
      if (side === 'right') expect(hover.x).toBeGreaterThan(550)
      else expect(hover.x).toBeLessThan(250)
      await page.close()
    }
  })
})
