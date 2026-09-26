import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'
import { createCursor, type CursorOptions } from '../src/index.js'

/**
 * Live-browser regression for issue #6. `clearExisting` used to select all
 * with Ctrl+A or Cmd+A picked from navigator.platform. Browsers only honor the
 * shortcut of the OS they really run on, so under a spoofed platform the field
 * silently kept its old text ("Glassdoor" -> "GlassdooHello"); and whichever
 * modifier is sent, the page can read it and learn the real OS.
 *
 * Clearing is now triple-click (+ Shift+ArrowDown for multi-line content), so
 * these tests also assert that no Control/Meta key ever reaches the page. The
 * page always claims the OS this test is NOT running on.
 */

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
})()

const spoofedPlatform = process.platform === 'darwin' ? 'Linux x86_64' : 'MacIntel'
const hostModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

const FRAME_HTML = `<!doctype html>
<input id="input" value="Glassdoor" style="width:240px">
<textarea id="textarea" style="width:240px;height:70px">first line
second line
third line</textarea>`
const EDITOR_HTML = '<!doctype html><body contenteditable style="margin:6px"><p>Rich one</p><p>Rich two</p></body>'
const srcdoc = (html: string) => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

const PAGE_HTML = `<!doctype html>
<input id="input" value="Glassdoor" style="width:300px">
<input id="email" type="email" value="ada@example.com" style="width:300px">
<textarea id="textarea" style="width:300px;height:90px">first paragraph here
second paragraph

fourth after a blank line
last</textarea>
<div id="editable" contenteditable style="width:300px;border:1px solid"><p>Para one</p><p>Para two</p><p>Para three</p></div>
<iframe id="frame" style="margin-left:40px;border:7px solid #888;width:300px;height:150px" srcdoc="${srcdoc(FRAME_HTML)}"></iframe>
<iframe id="editorframe" style="border:3px solid #888;width:300px;height:90px" srcdoc="${srcdoc(EDITOR_HTML)}"></iframe>`

// Runs in every frame: spoof the platform, and record any modifier keydown
// into the top page (key events inside an iframe never reach the parent).
function instrumentFrame(platform: string) {
  Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform })
  const top = window.top as unknown as { modifierKeys?: string[] }
  top.modifierKeys ??= []
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.key === 'Control' || e.key === 'Meta') top.modifierKeys!.push(e.key)
  }, true)
}

describe.skipIf(!hasChromium)('clearExisting under a spoofed navigator.platform (live browser)', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser?.close()
  })

  async function open(options: CursorOptions = {}) {
    const context = await browser.newContext()
    await context.addInitScript(instrumentFrame, spoofedPlatform)
    const page = await context.newPage()
    // Navigate for real: setContent() would wipe the listeners instrumentFrame
    // registered, and the modifier assertions would pass without recording.
    await page.route('https://myuri.test/', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }))
    await page.goto('https://myuri.test/')
    await page.waitForFunction(() =>
      ['#frame', '#editorframe'].every((id) => (document.querySelector(id) as HTMLIFrameElement).contentDocument?.readyState === 'complete'),
    )
    expect(await page.evaluate(() => navigator.platform)).toBe(spoofedPlatform)
    const cursor = createCursor(page, { seed: 6, settings: { typing: { mistakeMultiplier: 0 } }, ...options })
    return { page, cursor, close: async () => (await cursor.dispose(), await context.close()) }
  }

  // Resolves `frame >>> inner` too, reading from inside the iframe.
  const fieldText = (page: Page, selector: string) =>
    page.evaluate((sel) => {
      const [frame, inner] = sel.split(' >>> ')
      const root = inner ? (document.querySelector(frame) as HTMLIFrameElement).contentDocument! : document
      const el = root.querySelector(inner ?? frame) as HTMLElement
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? (el as HTMLInputElement).value : el.innerText
    }, selector)
  const modifierKeys = (page: Page) => page.evaluate(() => (window as unknown as { modifierKeys: string[] }).modifierKeys)

  const selectors = [
    '#input',
    '#email',
    '#textarea',
    '#editable',
    '#frame >>> #input',
    '#frame >>> #textarea',
    '#editorframe >>> body',
  ]
  for (const selector of selectors) {
    it(`replaces ${selector} without sending a modifier key`, async () => {
      const { page, cursor, close } = await open()
      await cursor.type('Hello', selector, { clearExisting: true })
      expect((await fieldText(page, selector)).trim()).toBe('Hello')
      expect(await modifierKeys(page)).toEqual([])
      await close()
    }, 60000)
  }

  it('clears the already-focused field when no selector is given', async () => {
    const { page, cursor, close } = await open()
    await page.focus('#input')
    await cursor.type('Hello', undefined, { clearExisting: true })
    expect(await fieldText(page, '#input')).toBe('Hello')
    expect(await modifierKeys(page)).toEqual([])
    await close()
  }, 60000)

  // Also proves the recorder sees modifiers in both the top page and a frame,
  // so the zero-modifier assertions above can't pass vacuously.
  for (const selector of ['#input', '#frame >>> #input']) {
    it(`uses keyboard select-all on ${selector} only when selectAllModifier is set`, async () => {
      const { page, cursor, close } = await open({ selectAllModifier: hostModifier })
      await cursor.type('Hello', selector, { clearExisting: true })
      expect(await fieldText(page, selector)).toBe('Hello')
      expect(await modifierKeys(page)).toContain(hostModifier)
      await close()
    }, 60000)
  }
})
