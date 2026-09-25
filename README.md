# myuri

Human-like browser **cursor, keyboard, and scroll** simulation — driver-agnostic.

`myuri` moves the mouse along recorded human trajectories (via
[cursory](https://github.com/Vinyzu/cursory)), scrolls with fitted wheel dynamics, and
types with a Markov model that makes natural errors and corrections. It does
**not** talk to a browser itself. You inject a small **Driver** — the functions that
actually move the mouse, press keys, scroll, and read the DOM — so myuri works with
Playwright, Puppeteer, raw CDP, or anything you can wrap.

Available for **TypeScript/JavaScript** (`js/`) and **Python** (`python/`) with a mirrored API.

## See it move

Each dot in the trail is one real `mousemove` event that myuri sent, so dots bunch up
where the hand slows down. The overlay reads the browser's own events; nothing is drawn
from the planned path.

| Mouse movement | Typing | Scrolling |
|:---:|:---:|:---:|
| <img src="docs/media/mouse.gif" width="300" alt="Cursor moving between buttons along curved, human-paced paths and clicking each"> | <img src="docs/media/typing.gif" width="300" alt="Two form fields filled with an uneven typing rhythm, including a typo that is backspaced and corrected"> | <img src="docs/media/scroll.gif" width="300" alt="A long page scrolled in wheel bursts down to a target button, which is clicked, then scrolled back up"> |
| Recorded human paths, overshoot and correction | Markov rhythm, typos, backspace fixes | Wheel bursts with momentum, then a click |

The GIFs come from [`js/scripts/record-demos.mjs`](js/scripts/record-demos.mjs)
(`npm run build && node scripts/record-demos.mjs` in `js/`), with seed `20260925`.

```
┌──────────────────────────────┐
│  myuri core (pure, portable) │  scroll model · Markov typing · seeded RNG
│  + cursory / cursory-js      │  recorded human mouse trajectories
└──────────────┬───────────────┘
               │ Driver interface
   ┌───────────┼───────────┬─────────────┐
 Playwright   CDP     Puppeteer      your custom
 (default)  wrapper    wrapper         driver
```

## Why a Driver?

Older versions hard-coded Playwright/CDP "interaction strategies". myuri instead takes a
single `Driver` object with two groups of capabilities:

- **Input** (required) — `move`, `click`, `down`, `up`, `wheel`, `press`
- **Query** (required) — `evaluate(fn, arg)`
- **Optional** (defaults supplied) — `insertText`, `setClipboard`, `isClosed`, `dispose`

Every DOM measurement myuri needs (element boxes, occlusion, scroll offsets, viewport)
runs through `evaluate`, so any driver that can run JS in the page and dispatch input works.
Convenience wrappers ship for the common cases, so most users inject nothing.

## TypeScript

```ts
import { createCursor } from '@jobharvest/myuri'
import { chromium } from 'playwright'

const page = await (await chromium.launch()).newPage()
await page.goto('https://example.com')

// Playwright driver is inferred from the page object.
const cursor = createCursor(page, { seed: 1234 })

await cursor.move('#username')
await cursor.click('#username')
await cursor.type('hello@example.com')
await cursor.scroll('#footer')
await cursor.dispose()          // detaches CDP sessions, clears timers
```

Bring your own driver:

```ts
import { createCursor, defineDriver } from '@jobharvest/myuri'

const cursor = createCursor({
  driver: defineDriver({
    // required input primitives
    move: (x, y) => myBackend.mouseMove(x, y),
    // clickCount 2/3 continue a double/triple click (used to clear fields)
    click: (button, clickCount) => myBackend.mouseClick(button, clickCount),
    down: (k) => myBackend.keyDown(k),
    up: (k) => myBackend.keyUp(k),
    wheel: (dx, dy) => myBackend.wheel(dx, dy),
    press: (key, opts) => myBackend.press(key, opts),
    // required query seam: run a JS function in the page and return its result
    evaluate: (fn, arg) => myBackend.eval(fn, arg),
    // optional (these have defaults built on evaluate/press)
    insertText: (t) => myBackend.type(t),
    setClipboard: (t) => myBackend.clipboard(t),
    isClosed: () => myBackend.closed(),
  }),
})
```

Prebuilt wrappers:

```ts
import { playwrightDriver, cdpDriver, puppeteerDriver } from '@jobharvest/myuri/drivers'
const cursor = createCursor({ driver: cdpDriver(page) })
```

## Python

```python
from myuri import create_cursor
from playwright.async_api import async_playwright

async with async_playwright() as p:
    page = await (await p.chromium.launch()).new_page()
    await page.goto("https://example.com")

    cursor = create_cursor(page, seed=1234)   # PlaywrightDriver inferred
    await cursor.move("#username")
    await cursor.click("#username")
    await cursor.type("hello@example.com")
    await cursor.scroll("#footer")
    await cursor.dispose()
```

Custom driver: subclass `myuri.Driver` (or pass any object implementing the protocol) and
hand it to `create_cursor(driver=...)`.

## Determinism

Both packages use a seeded Mulberry32 PRNG. Pass `seed` to reproduce identical mouse paths,
scroll dynamics, and typing rhythm; read it back with `cursor.get_seed()` / `cursor.getSeed()`.

### Seed → behavioral profile

A seed doesn't just fix the *motion stream* — it also derives a stable **behavioral
profile** (a *behavioral fingerprint*): how fast this identity types, how often it
mistypes, how aggressively it overshoots, how quickly it scrolls. When you construct a
cursor with a `seed` and no explicit `settings`, that profile is applied automatically:

```ts
import { createCursor, generateProfile } from '@jobharvest/myuri'

const cursor = createCursor(page, { seed: 1234 }) // profile derived from 1234
cursor.getSettings()                              // inspect the resolved traits
generateProfile(1234)                             // or derive one standalone
```

```python
from myuri import create_cursor, profile_from_seed

cursor = create_cursor(page, seed=1234)
cursor.get_settings()
profile_from_seed(1234)
```

Because both languages share the PRNG and draw order, a given seed produces a
byte-identical profile in TypeScript and Python. An explicit `settings` override always
wins over the derived profile.

## Repo layout

| Path | What |
|------|------|
| `js/` | npm package `@jobharvest/myuri` (private) |
| `python/` | Python package `myuri` (private; git-installed) |
| `docs/media/` | demo GIFs used in this README |

## Mouse trajectories: cursory

myuri doesn't generate mouse paths itself. It uses **[cursory](https://github.com/Vinyzu/cursory)**
by [Vinyzu](https://github.com/Vinyzu/). cursory finds the closest match to each movement in a
database of recorded human trajectories, then morphs, jitters, and resamples it onto the
requested endpoints.

| Package | Uses |
|---|---|
| `@jobharvest/myuri` (TypeScript) | [`cursory-js`](https://github.com/JWriter20/cursory-js), a TypeScript port of cursory |
| `myuri` (Python) | [`cursory`](https://pypi.org/project/cursory/), the original |

cursory-js reproduces cursory's numpy random stream bit for bit. myuri gives both libraries
a seed drawn from its own seeded stream, so a given myuri `seed` produces the same mouse path
in TypeScript and Python (to within about 1e-12 px of floating-point rounding).

## Thanks to

- [Vinyzu](https://github.com/Vinyzu/), for [cursory](https://github.com/Vinyzu/cursory), which
  every mouse movement in myuri comes from.
- [Pointergeist](https://github.com/Pointergeist), for helping Vinyzu understand mouse
  trajectories better.
- [Margit Antal, Norbert Fejer and Krisztian Buza](https://github.com/margitantal68), for
  [SapiMouse](https://ieeexplore.ieee.org/document/9465583), and
  [MIMIC-LOGICS](https://github.com/MIMIC-LOGICS/), for
  [Mouse-Synthesizer](https://github.com/MIMIC-LOGICS/Mouse-Synthesizer): the recordings
  behind cursory's trajectory database.

## License

[GNU LGPL v3 or later](LICENSE) © Jake Writer. You can use myuri in commercial and
closed-source projects. If you distribute a modified myuri, its source has to stay
available under the same license.

cursory is © Vinyzu, dual-licensed under LGPLv3-or-later and GPLv3-or-later; cursory-js is
LGPLv3-or-later. myuri depends on them and doesn't redistribute them. See [`NOTICE`](NOTICE).
