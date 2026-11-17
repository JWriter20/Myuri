# myuri (Python)

Human-like browser **cursor, keyboard, and scroll** simulation — driver-agnostic.

`myuri` generates realistic mouse trajectories (recorded human motion via cursory), fitted
scroll dynamics, and Markov-model typing with natural errors and corrections. It does
not talk to a browser itself — you inject a small **Driver**, so it works with
Playwright, raw CDP, or any backend you can wrap.

```bash
pip install myuri            # core
pip install "myuri[playwright]"  # + the default Playwright driver
```

## Quick start (Playwright)

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
    await cursor.drag("#card", "#bin")      # selectors or Vector points
    await cursor.dispose()
```

## Bring your own driver

Subclass `myuri.Driver` (implement the input primitives + `evaluate`) or assemble one
from callables with `define_driver`:

```python
from myuri import create_cursor, define_driver

driver = define_driver(
    move=my_move, click=my_click, down=my_down, up=my_up,
    wheel=my_wheel, press=my_press, evaluate=my_evaluate,
)
cursor = create_cursor(driver, seed=1234)
```

`my_click(button, click_count)` should pass `click_count` through to the browser (2 and 3
continue a double/triple click). `clear_existing` triple-clicks to select a field's text,
so a click that ignores it can't clear fields.

`evaluate(js, arg)` receives a JS arrow-function *source string* and one
JSON-serializable argument, and must run it in the page and return the result — the
same contract as Playwright's `page.evaluate`.

### Prebuilt wrappers

`from_playwright` / `from_cdp` turn a page into a driver, so you can construct directly:

```python
from myuri import create_cursor, from_playwright, from_cdp

cursor = create_cursor(from_playwright(page), seed=1234)
# or dispatch mouse input over CDP on a Chromium page:
cursor = create_cursor(from_cdp(page), seed=1234)
```

## The identity's OS

`create_cursor(page, os="macos")` (or `"windows"`, `"linux"`) matches the input to the OS the
browser claims: the paste and select-all modifier (Cmd on macOS, Ctrl elsewhere), whether a
move repeats the position the pointer is already on (only on macOS), the mouse wheel style,
and which axis a Shift+wheel scroll carries. How long a person takes is the same on every OS.

## Planning without a browser

`plan_move`, `plan_point`, `plan_click`, `plan_type`, `plan_press`, `plan_select_all` and
`plan_wheel` return the timelines a `Cursor` plays, from an `rng` such as `make_rng(seed)`;
the Cursor is built on them. See the [project README](https://github.com/JWriter20/Myuri#planning-without-a-browser).

## Determinism

Seeded Mulberry32 PRNG — the **same seed produces the same numbers as the TypeScript
package**. Pass `seed=` to reproduce motion, scrolls, and typing rhythm; read it back
with `cursor.get_seed()`.

Part of the [Myuri](https://github.com/JWriter20/Myuri) project (TypeScript + Python).
Mouse trajectories come from [cursory](https://github.com/Vinyzu/cursory) by
[Vinyzu](https://github.com/Vinyzu/). Requires Python 3.11+ (cursory's minimum).

Licensed under the [GNU LGPL v3 or later](https://github.com/JWriter20/Myuri/blob/main/LICENSE). See [`NOTICE`](https://github.com/JWriter20/Myuri/blob/main/NOTICE) for credits.
