<p align="center"><img src="https://cdn.jsdelivr.net/npm/myuri/myuri.png" width="160" alt="myuri"></p>

# myuri

Human-like browser **cursor, keyboard, and scroll** simulation — driver-agnostic.

`myuri` generates realistic mouse trajectories (recorded human motion via cursory), fitted
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
    click: (button, clickCount) => backend.click(button, clickCount),
    wheel: (dx, dy) => backend.wheel(dx, dy),
    down: (k) => backend.keyDown(k),
    up: (k) => backend.keyUp(k),
    press: (k, o) => backend.press(k, o),
    evaluate: (fn, arg) => backend.evaluate(fn, arg),
  }),
})
```

## Prebuilt driver wrappers

`fromPlaywright` / `fromCDP` / `fromPuppeteer` turn a page into a driver:

```ts
import { createCursor, fromPlaywright, fromCDP } from 'myuri'

const cursor = createCursor(fromPlaywright(page), { seed: 1234 })
// or let createCursor infer the driver from a raw page:
const cursor2 = createCursor(page, { seed: 1234 })
```

(`playwrightDriver`/`cdpDriver`/`puppeteerDriver` from `myuri/drivers` are
the same functions under descriptive names.)

The `Driver` needs input primitives (`move`, `click`, `down`, `up`, `wheel`, `press`)
plus one query seam, `evaluate(fn, arg)`, which every DOM measurement is built on.
Optional `insertText`/`setClipboard`/`isClosed`/`dispose` get sensible defaults.

## Determinism

Seeded Mulberry32 PRNG — the **same seed produces the same numbers as the Python
package**. Pass `{ seed }` to reproduce motion, scrolls, and typing rhythm; read it back
with `cursor.getSeed()`.

Part of the [Myuri](https://github.com/JWriter20/Myuri) project (TypeScript + Python).
Mouse trajectories come from [cursory-js](https://github.com/JWriter20/cursory-js), a TypeScript port of
[cursory](https://github.com/Vinyzu/cursory) by [Vinyzu](https://github.com/Vinyzu/).

Licensed under the [GNU LGPL v3 or later](https://github.com/JWriter20/Myuri/blob/main/LICENSE). See [`NOTICE`](https://github.com/JWriter20/Myuri/blob/main/NOTICE) for credits.
