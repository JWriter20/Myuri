import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'
import { createCursor } from '../src/index.js'
import { fromPlaywright } from '../src/drivers/index.js'
import { boundingBoxOf } from '../src/page.js'
import { HIT_TEST_JS, onSelector } from '../src/page-functions.js'
import { defineDriver } from '../src/drivers/types.js'

/**
 * Same-origin iframe piercing: `a >>> b` hops into a's contentDocument (the
 * iframe analog of the ` >> ` shadow hop). ATS platforms (iCIMS et al.) render
 * the whole application flow inside a same-origin child iframe, so the cursor
 * must resolve selectors through the frame boundary and translate all geometry
 * into top-page viewport coordinates (mouse input is dispatched at page level).
 */

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
})()

// Inner document: an Apply button at a known offset, a tall filler, and a
// below-fold submit — clicking it requires scrolling the IFRAME's own window.
const FRAME_HTML = `
  <style>* { margin: 0; } #apply { position: absolute; left: 40px; top: 30px; width: 160px; height: 36px; }
    #below { position: absolute; left: 40px; top: 1400px; width: 160px; height: 36px; }</style>
  <button id="apply">Apply for this job</button>
  <div style="height:1500px"></div>
  <button id="below">Submit</button>
  <script>
    parent.__frameClicks = parent.__frameClicks || []
    document.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => parent.__frameClicks.push(b.id)))
  </script>`

const PAGE_HTML = `<!doctype html>
<html><head><style>
  * { margin: 0; box-sizing: border-box; }
  #appframe { position: absolute; left: 120px; top: 90px; width: 500px; height: 400px; border: 0; }
</style></head><body>
  <div style="height: 60px">host page header</div>
  <iframe id="appframe" srcdoc="${FRAME_HTML.replace(/"/g, '&quot;')}"></iframe>
  <div style="height: 800px"></div>
</body></html>`

describe.skipIf(!hasChromium)('same-origin iframe piercing (live browser)', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser?.close()
  })

  async function setupPage(): Promise<Page> {
    page = await browser.newPage({ viewport: { width: 900, height: 600 } })
    await page.setContent(PAGE_HTML)
    await page.waitForFunction(() => {
      const f = document.getElementById('appframe') as HTMLIFrameElement
      return !!f.contentDocument?.getElementById('apply')
    })
    return page
  }

  it('boundingBoxOf translates in-iframe rects to top-page coordinates', async () => {
    await setupPage()
    const driver = defineDriver(fromPlaywright(page))
    const box = await boundingBoxOf(driver, '#appframe >>> #apply')
    expect(box).not.toBeNull()
    // iframe at (120, 90), button at (40, 30) inside it.
    expect(box!.x).toBeCloseTo(160, 0)
    expect(box!.y).toBeCloseTo(120, 0)
    expect(box!.width).toBeCloseTo(160, 0)
    await page.close()
  })

  it('clicks a visible in-iframe target', async () => {
    await setupPage()
    const cursor = createCursor(fromPlaywright(page), { seed: 7 })
    await cursor.click('#appframe >>> #apply')
    expect(await page.evaluate(() => (window as any).__frameClicks)).toEqual(['apply'])
    await page.close()
  })

  it('the hit test sees through the frame boundary', async () => {
    await setupPage()
    const driver = defineDriver(fromPlaywright(page))
    const hit = (x: number, y: number) =>
      driver.evaluate(onSelector(HIT_TEST_JS), { selector: '#appframe >>> #apply', arg: { x, y, pressing: false } })
    // Center of the apply button in top coords: (120+40+80, 90+30+18).
    expect(await hit(240, 138)).toBeNull()
    // A point on the host page header must NOT count as hitting the target.
    expect(await hit(240, 20)).not.toBeNull()
    await page.close()
  })

  it("scrolls the iframe's own document to reach a below-fold target, then clicks it", async () => {
    await setupPage()
    const cursor = createCursor(fromPlaywright(page), { seed: 7 })
    await cursor.click('#appframe >>> #below')
    expect(await page.evaluate(() => (window as any).__frameClicks)).toEqual(['below'])
    // The iframe's window must have scrolled; the host page may scroll too, but
    // the target only becomes reachable via the frame's own scroll.
    const frameScroll = await page.evaluate(
      () => (document.getElementById('appframe') as HTMLIFrameElement).contentWindow!.scrollY,
    )
    expect(frameScroll).toBeGreaterThan(0)
    await page.close()
  })

  it('pierces nested same-origin iframes', async () => {
    page = await browser.newPage({ viewport: { width: 900, height: 600 } })
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    const inner = `<style>*{margin:0}</style><button id="deep" style="position:absolute;left:10px;top:10px;width:120px;height:30px">Deep</button>
      <script>document.getElementById('deep').addEventListener('click', () => { (top).__deepClicked = true })</script>`
    const mid = `<style>*{margin:0}</style><iframe id="innerframe" style="position:absolute;left:30px;top:20px;width:300px;height:200px;border:0" srcdoc="${esc(inner)}"></iframe>`
    await page.setContent(`<!doctype html><html><body style="margin:0">
      <iframe id="outerframe" style="position:absolute;left:50px;top:40px;width:600px;height:400px;border:0" srcdoc="${esc(mid)}"></iframe>
    </body></html>`)
    await page.waitForFunction(() => {
      const o = document.getElementById('outerframe') as HTMLIFrameElement
      const i = o.contentDocument?.getElementById('innerframe') as HTMLIFrameElement | null
      return !!i?.contentDocument?.getElementById('deep')
    })
    const driver = defineDriver(fromPlaywright(page))
    const box = await boundingBoxOf(driver, '#outerframe >>> #innerframe >>> #deep')
    expect(box).not.toBeNull()
    // 50+30+10, 40+20+10
    expect(box!.x).toBeCloseTo(90, 0)
    expect(box!.y).toBeCloseTo(70, 0)
    const cursor = createCursor(fromPlaywright(page), { seed: 7 })
    await cursor.click('#outerframe >>> #innerframe >>> #deep')
    expect(await page.evaluate(() => (window as any).__deepClicked)).toBe(true)
    await page.close()
  })

  it('returns null (no throw) for a cross-origin frame hop', async () => {
    page = await browser.newPage({ viewport: { width: 900, height: 600 } })
    // data: URLs have an opaque origin — contentDocument is inaccessible.
    await page.setContent(`<!doctype html><html><body>
      <iframe id="xorigin" src="data:text/html,<button id='b'>x</button>" style="width:300px;height:200px"></iframe>
    </body></html>`)
    const driver = defineDriver(fromPlaywright(page))
    expect(await boundingBoxOf(driver, '#xorigin >>> #b')).toBeNull()
    await page.close()
  })
})
