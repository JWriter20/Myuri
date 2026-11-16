"""Default driver: wraps a Playwright (async) Page.

Typed against ``Any`` so myuri has no hard dependency on ``playwright`` — it is an
optional extra. Any object exposing the same ``mouse``/``keyboard``/``evaluate``/
``is_closed`` surface works (real Playwright pages, patchright, etc.).
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from .base import Driver

# Hold when the caller gives none; the cursor passes one drawn per click.
_CLICK_HOLD_S = 0.095


class PlaywrightDriver(Driver):
    def __init__(self, page: Any) -> None:
        self._page = page

    async def move(self, x: float, y: float) -> None:
        await self._page.mouse.move(x, y)

    async def click(self, button: str = "left", click_count: int = 1, hold_ms: Optional[float] = None) -> None:
        hold_s = _CLICK_HOLD_S if hold_ms is None else hold_ms / 1000.0
        await self._page.mouse.down(button=button, click_count=click_count)
        if hold_s > 0:
            await asyncio.sleep(hold_s)
        await self._page.mouse.up(button=button, click_count=click_count)

    async def mouse_down(self, button: str = "left") -> None:
        await self._page.mouse.down(button=button)

    async def mouse_up(self, button: str = "left") -> None:
        await self._page.mouse.up(button=button)

    async def down(self, key: str) -> None:
        await self._page.keyboard.down(key)

    async def up(self, key: str) -> None:
        await self._page.keyboard.up(key)

    async def wheel(self, delta_x: float, delta_y: float) -> None:
        await self._page.mouse.wheel(delta_x, delta_y)

    async def press(self, key: str, delay: Optional[float] = None) -> None:
        if delay is not None:
            await self._page.keyboard.press(key, delay=delay)
        else:
            await self._page.keyboard.press(key)

    async def insert_text(self, text: str) -> None:
        await self._page.keyboard.insert_text(text)

    async def evaluate(self, js: str, arg: Any = None) -> Any:
        return await self._page.evaluate(js, arg)

    def is_closed(self) -> bool:
        return bool(self._page.is_closed())


def from_playwright(page: Any) -> Driver:
    """Convenience constructor: ``create_cursor(from_playwright(page))``."""
    return PlaywrightDriver(page)


def driver_from_page(page: Any) -> Driver:
    """Infer a driver from a page object. Currently returns a
    :class:`PlaywrightDriver` (also covers patchright). Pass an explicit driver
    for other backends."""
    return PlaywrightDriver(page)
