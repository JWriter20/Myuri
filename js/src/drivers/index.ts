export {
  type Driver,
  type ResolvedDriver,
  type MouseButton,
  type PressOptions,
  type PageFunction,
  type WaitForElementOptions,
  type BoundingBox,
  type ViewportSize,
  defineDriver,
} from './types.js'

export { playwrightDriver, type PlaywrightLikePage } from './playwright.js'
export { cdpDriver, type CdpCapablePage, type CdpSession } from './cdp.js'
export { puppeteerDriver, type PuppeteerLikePage } from './puppeteer.js'

// Ergonomic aliases: `createCursor(fromPlaywright(page))`.
export { playwrightDriver as fromPlaywright } from './playwright.js'
export { cdpDriver as fromCDP } from './cdp.js'
export { puppeteerDriver as fromPuppeteer } from './puppeteer.js'

import { type Driver } from './types.js'
import { playwrightDriver, type PlaywrightLikePage } from './playwright.js'
import { puppeteerDriver, type PuppeteerLikePage } from './puppeteer.js'

/**
 * Best-effort driver detection for the `createCursor(page)` convenience form.
 * Playwright/patchright/camoufox pages expose `context()`; Puppeteer pages
 * expose `browser()`. Anything else is assumed Playwright-compatible. For full
 * control (or a non-standard page) pass `createCursor({ driver })` explicitly.
 */
export function driverFromPage(page: unknown): Driver {
  const p = page as Record<string, unknown>
  if (p && typeof p.context === 'function') {
    return playwrightDriver(page as PlaywrightLikePage)
  }
  if (p && typeof p.browser === 'function' && typeof (p.mouse as never) !== 'undefined') {
    return puppeteerDriver(page as PuppeteerLikePage)
  }
  return playwrightDriver(page as PlaywrightLikePage)
}
