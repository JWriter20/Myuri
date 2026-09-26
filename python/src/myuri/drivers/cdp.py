"""Chromium-only driver that dispatches mouse input over CDP.

Wraps a Playwright (async) Chromium page: mouse events go through a CDP session
(``Input.dispatchMouseEvent``), while keyboard and ``evaluate`` reuse the page.
The session is created lazily and detached on :meth:`dispose`.
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from .base import Driver

_CLICK_HOLD_S = 0.045


class CdpDriver(Driver):
    def __init__(self, page: Any) -> None:
        self._page = page
        self._session: Any = None
        self._x = 0.0
        self._y = 0.0

    async def _client(self) -> Any:
        if self._session is None:
            self._session = await self._page.context.new_cdp_session(self._page)
        return self._session

    async def move(self, x: float, y: float) -> None:
        self._x, self._y = x, y
        client = await self._client()
        await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})

    async def click(self, button: str = "left", click_count: int = 1) -> None:
        client = await self._client()
        base = {"x": self._x, "y": self._y, "button": button, "clickCount": click_count}
        await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", **base})
        if _CLICK_HOLD_S > 0:
            await asyncio.sleep(_CLICK_HOLD_S)
        await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", **base})

    async def wheel(self, delta_x: float, delta_y: float) -> None:
        client = await self._client()
        await client.send(
            "Input.dispatchMouseEvent",
            {"type": "mouseWheel", "x": self._x, "y": self._y, "deltaX": delta_x, "deltaY": delta_y},
        )

    async def down(self, key: str) -> None:
        await self._page.keyboard.down(key)

    async def up(self, key: str) -> None:
        await self._page.keyboard.up(key)

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

    async def dispose(self) -> None:
        if self._session is not None:
            try:
                await self._session.detach()
            except Exception:
                pass  # session may already be gone if the page closed
            self._session = None


def from_cdp(page: Any) -> Driver:
    """Convenience constructor: ``create_cursor(from_cdp(page))``."""
    return CdpDriver(page)
