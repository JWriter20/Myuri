import { type ResolvedDriver } from './drivers/types.js'
import type { BoundingBox, ViewportSize } from './math.js'
import { BOX_JS, onSelector } from './page-functions.js'

/**
 * The Cursor's reads of the page, each one `driver.evaluate`, so a driver
 * needs no selector engine. Selectors are resolved in the page
 * (`RESOLVE_SELECTOR_JS`: CSS through open shadow roots, `a >> b` into a's
 * shadow root, `a >>> b` into a's same-origin iframe, XPath with `xpath=` or a
 * leading `/` or `(`). Geometry is in the top page's viewport, where mouse
 * input is dispatched.
 */

/** Viewport dimensions, robust to quirks mode and null-viewport fingerprints. */
export async function viewportOf(driver: ResolvedDriver): Promise<ViewportSize> {
  const vp = await driver.evaluate(
    () => ({
      width: window.innerWidth || document.documentElement.clientWidth,
      height: window.innerHeight || document.documentElement.clientHeight,
    }),
    null,
  )
  if (!vp || !vp.width || !vp.height) throw new Error('myuri: could not read viewport size')
  return vp
}

/** Bounding box of a selector in the top page's viewport, or null if it is not found or has no size. */
export async function boundingBoxOf(driver: ResolvedDriver, selector: string): Promise<BoundingBox | null> {
  return await driver.evaluate(onSelector(BOX_JS), { selector, arg: null })
}

/** The page's vertical scroll offset. */
export async function scrollOffsetOf(driver: ResolvedDriver): Promise<number> {
  return await driver.evaluate(() => window.scrollY, null)
}

/** Poll until the selector names an element with a size, or `timeout` ms pass. Returns whether it did. */
export async function waitForElement(driver: ResolvedDriver, selector: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (driver.isClosed()) return false
    if (await boundingBoxOf(driver, selector)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
