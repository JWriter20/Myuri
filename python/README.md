# myuri (Python)

Human-like browser **cursor, keyboard, and scroll** simulation — driver-agnostic.

`myuri` generates realistic mouse trajectories (from recorded human motion), fitted
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

`evaluate(js, arg)` receives a JS arrow-function *source string* and one
JSON-serializable argument, and must run it in the page and return the result — the
same contract as Playwright's `page.evaluate`.

### Prebuilt wrappers

`from_playwright` / `from_cdp` turn a page into a driver, so you can construct directly:

```python
from myuri import Myuri, from_playwright, from_cdp

cursor = Myuri(from_playwright(page), seed=1234)
# or dispatch mouse input over CDP on a Chromium page:
cursor = Myuri(from_cdp(page), seed=1234)
```

(`Myuri` is an alias of `Cursor`.)

## Determinism

Seeded Mulberry32 PRNG — the **same seed produces the same numbers as the TypeScript
package**. Pass `seed=` to reproduce motion, scrolls, and typing rhythm; read it back
with `cursor.get_seed()`.

Part of the [myuri](https://github.com/JWriter20/myuri) project (TypeScript + Python).
MIT licensed.
