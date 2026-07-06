# myuri

Human-like browser **cursor, keyboard, and scroll** simulation — driver-agnostic.

`myuri` generates realistic mouse trajectories (from recorded human motion), fitted
scroll dynamics, and Markov-model typing with natural errors and corrections. It does
not talk to a browser itself — you inject a small **Driver**, so it works with
Playwright, Puppeteer, raw CDP, or anything you can wrap.

```bash
npm install myuri
```

## Quick start (Playwright)

```ts
import { createCursor } from 'myuri'
import { chromium } from 'playwright'

const page = await (await chromium.launch()).newPage()
await page.goto('https://example.com')

const cursor = createCursor(page, { seed: 1234 }) // Playwright driver inferred
await cursor.move('#username')
await cursor.click('#username')
await cursor.type('hello@example.com')
await cursor.scroll('#footer')
await cursor.dispose()
```

## Bring your own driver

```ts
import { createCursor, defineDriver } from 'myuri'

const cursor = createCursor({
  driver: defineDriver({
    move: (x, y) => backend.move(x, y),
    click: () => backend.click(),
    wheel: (dx, dy) => backend.wheel(dx, dy),
    down: (k) => backend.keyDown(k),
    up: (k) => backend.keyUp(k),
    press: (k, o) => backend.press(k, o),
    evaluate: (fn, arg) => backend.evaluate(fn, arg),
  }),
})
```

Prebuilt wrappers: `import { playwrightDriver, cdpDriver, puppeteerDriver } from 'myuri/drivers'`.

The `Driver` needs input primitives (`move`, `click`, `down`, `up`, `wheel`, `press`)
plus one query seam, `evaluate(fn, arg)`, which every DOM measurement is built on.
Optional `insertText`/`setClipboard`/`isClosed`/`dispose` get sensible defaults.

## Determinism

Seeded Mulberry32 PRNG — the **same seed produces the same numbers as the Python
package**. Pass `{ seed }` to reproduce motion, scrolls, and typing rhythm; read it back
with `cursor.getSeed()`.

Part of the [myuri](https://github.com/JWriter20/myuri) project (TypeScript + Python).
MIT licensed.
