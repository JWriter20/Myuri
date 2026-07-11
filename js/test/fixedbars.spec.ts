import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'
import { createCursor } from '../src/index.js'
import { fromPlaywright } from '../src/drivers/index.js'
import { VIEWPORT_PADDING } from '../src/geometry.js'
import type { Driver } from '../src/drivers/types.js'

/**
 * Live-browser regression for the "cursor did not land / edge-riding" failure:
 * a target behind a fixed bottom bar whose nearest scrollable ancestor cannot
 * reveal it.
 *
 * Layout (600px viewport): fixed header (70px), fixed footer (50vh), and a
 * position:fixed overflow-y:auto pane occupying the clear band between them.
 * Inside the pane, a custom dropdown whose options list is ITSELF scrollable
 * (6 × 34px options under a 200px max-height). With the pane at scrollTop 0
 * and the dropdown opened programmatically, the first option sits entirely
 * behind the footer:
 *
 *  - the nearest scrollable ancestor (the options list) is at scrollTop 0 and
 *    can never move its own top-anchored first option — the planner must
 *    escalate to the outer pane;
 *  - the pane is position:fixed, so a page scroll is a no-op — the pane must
 *    be scrolled via wheel over an interior point;
 *  - the old planner did neither, so the cursor chased an off-screen point,
 *    clamped to the viewport edge ("edge-riding"), and threw
 *    "cursor did not land" after 3 attempts.
 */

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
})()

const PAGE_HTML = `<!doctype html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  .header { position: fixed; top: 0; left: 0; right: 0; height: 70px; background: #223; z-index: 30; }
  .footer { position: fixed; bottom: 0; left: 0; right: 0; height: 50vh; background: #322; z-index: 30; }
  .pane { position: fixed; top: 70px; bottom: 50vh; left: 0; right: 0; overflow-y: auto; background: #eee; }
  .filler { height: 200px; }
  .custom-select { position: relative; width: 260px; margin: 0 20px; }
  .custom-select-trigger { height: 34px; border: 1px solid #999; background: #fff; }
  .custom-select-options { display: none; max-height: 200px; overflow-y: auto; border: 1px solid #999; background: #fff; }
  .custom-select.open .custom-select-options { display: block; }
  .option { height: 34px; line-height: 34px; padding-left: 8px; }
</style></head><body>
  <div class="header"></div>
  <div class="pane">
    <div class="filler"></div>
    <div class="custom-select" id="dd">
      <div class="custom-select-trigger" aria-expanded="false">Pick one</div>
      <div class="custom-select-options">
        <div class="option" id="opt-1">Alpha</div>
        <div class="option" id="opt-2">Bravo</div>
        <div class="option" id="opt-3">Charlie</div>
        <div class="option" id="opt-4">Delta</div>
        <div class="option" id="opt-5">Echo</div>
        <div class="option" id="opt-6">Foxtrot</div>
      </div>
    </div>
    <div style="height: 400px"></div>
  </div>
  <div class="footer"></div>
  <script>
    window.__clicked = []
    document.querySelectorAll('.option').forEach((o) =>
      o.addEventListener('click', () => window.__clicked.push(o.id)),
    )
  </script>
</body></html>`

/** Wrap a driver to record every mouse move the cursor dispatches. */
function recordingDriver(inner: Driver): { driver: Driver; moves: Array<{ x: number; y: number }> } {
  const moves: Array<{ x: number; y: number }> = []
  return {
    moves,
    driver: {
      ...inner,
      move: async (x: number, y: number) => {
        moves.push({ x, y })
        await inner.move(x, y)
      },
    },
  }
}

describe.skipIf(!hasChromium)('fixed-bar obstruction (live browser)', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser?.close()
  })

  async function setupPage(): Promise<Page> {
    page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(PAGE_HTML)
    // Open the dropdown programmatically WITHOUT scrolling the trigger into a
    // clear position first — the exact state a prior under-delivered scroll
    // leaves behind. The first option now renders fully behind the footer.
    await page.evaluate(() => {
      const dd = document.getElementById('dd')!
      dd.classList.add('open')
      dd.querySelector('.custom-select-trigger')!.setAttribute('aria-expanded', 'true')
    })
    const optTop = await page.evaluate(
      () => document.getElementById('opt-1')!.getBoundingClientRect().top,
    )
    const footerTop = await page.evaluate(
      () => document.querySelector('.footer')!.getBoundingClientRect().top,
    )
    expect(optTop).toBeGreaterThanOrEqual(footerTop) // precondition: target behind the footer
    return page
  }

  it('clicks a dropdown option hidden behind the fixed footer (escalates past the exhausted inner list)', async () => {
    const page = await setupPage()
    const { driver, moves } = recordingDriver(fromPlaywright(page))
    const cursor = createCursor({ driver, seed: 1234, start: { x: 200, y: 200 } })

    await cursor.click('#opt-1')

    const clicked = await page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked)
    expect(clicked).toEqual(['opt-1'])

    // The landing point must be inside the clear band — above the footer, not
    // on its edge.
    const footerTop = await page.evaluate(
      () => document.querySelector('.footer')!.getBoundingClientRect().top,
    )
    const landing = cursor.getLocation()
    expect(landing.y).toBeLessThan(footerTop)

    // No edge-riding: the cursor must never walk the bottom viewport edge
    // chasing the covered target (the old failure clamped moves to
    // vh - VIEWPORT_PADDING while the target sat behind the footer).
    const bottomEdge = 600 - VIEWPORT_PADDING - 1
    expect(moves.every((m) => m.y < bottomEdge)).toBe(true)

    await page.close()
  })

  it('clicks the last option too (inner list only scrolls once it is on-screen)', async () => {
    const page = await setupPage()
    const { driver, moves } = recordingDriver(fromPlaywright(page))
    const cursor = createCursor({ driver, seed: 99, start: { x: 200, y: 200 } })

    await cursor.click('#opt-6')

    const clicked = await page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked)
    expect(clicked).toEqual(['opt-6'])
    const bottomEdge = 600 - VIEWPORT_PADDING - 1
    expect(moves.every((m) => m.y < bottomEdge)).toBe(true)

    await page.close()
  })

  it('fails fast without edge-riding when the target truly cannot be revealed', async () => {
    page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    // A fixed, NON-scrollable pane clipped by the footer: the target below the
    // fold of the pane is unreachable by any scroll. The cursor must throw
    // without ever walking the viewport edge.
    await page.setContent(`<!doctype html><html><head><style>
      * { margin: 0; box-sizing: border-box; }
      .footer { position: fixed; bottom: 0; left: 0; right: 0; height: 50vh; background: #322; z-index: 30; }
      .pane { position: fixed; top: 0; bottom: 0; left: 0; right: 0; overflow: hidden; }
      .spacer { height: 560px; }
    </style></head><body>
      <div class="pane"><div class="spacer"></div><button id="unreachable">nope</button></div>
      <div class="footer"></div>
    </body></html>`)
    const { driver, moves } = recordingDriver(fromPlaywright(page))
    const cursor = createCursor({ driver, seed: 7, start: { x: 200, y: 200 } })

    await expect(cursor.click('#unreachable', { waitForSelector: 500 })).rejects.toThrow(/myuri:/)
    const bottomEdge = 600 - VIEWPORT_PADDING - 1
    expect(moves.every((m) => m.y < bottomEdge)).toBe(true)
    await page.close()
  })
})
