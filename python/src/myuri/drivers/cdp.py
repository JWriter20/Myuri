"""Chromium-only driver that dispatches mouse input over CDP.

Wraps a Playwright (async) Chromium page: mouse events go through a CDP session
(``Input.dispatchMouseEvent``), while keyboard and ``evaluate`` reuse the page.
The session is created lazily and detached on :meth:`dispose`.
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from .base import Driver

# Hold when the caller gives none; the cursor passes one drawn per click.
_CLICK_HOLD_S = 0.095
_BUTTON_BITS = {"left": 1, "right": 2, "middle": 4}


class CdpDriver(Driver):
    def __init__(self, page: Any) -> None:
        self._page = page
        self._session: Any = None
        self._x = 0.0
        self._y = 0.0
        # The button a drag holds; CDP moves must carry it or the page sees a hover.
        self._held: Optional[str] = None

    async def _client(self) -> Any:
        if self._session is None:
            self._session = await self._page.context.new_cdp_session(self._page)
        return self._session

    async def move(self, x: float, y: float) -> None:
        self._x, self._y = x, y
        client = await self._client()
        event = {"type": "mouseMoved", "x": x, "y": y}
        if self._held:
            event.update(button=self._held, buttons=_BUTTON_BITS[self._held])
        await client.send("Input.dispatchMouseEvent", event)

    async def mouse_down(self, button: str = "left") -> None:
        client = await self._client()
        self._held = button
        await client.send(
            "Input.dispatchMouseEvent",
            {"type": "mousePressed", "x": self._x, "y": self._y, "button": button, "buttons": _BUTTON_BITS[button], "clickCount": 1},
        )

    async def mouse_up(self, button: str = "left") -> None:
        client = await self._client()
        self._held = None
        await client.send(
            "Input.dispatchMouseEvent",
            {"type": "mouseReleased", "x": self._x, "y": self._y, "button": button, "clickCount": 1},
        )

    async def click(self, button: str = "left", click_count: int = 1, hold_ms: Optional[float] = None) -> None:
        hold_s = _CLICK_HOLD_S if hold_ms is None else hold_ms / 1000.0
        client = await self._client()
        base = {"x": self._x, "y": self._y, "button": button, "clickCount": click_count}
        await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", **base})
        if hold_s > 0:
            await asyncio.sleep(hold_s)
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
