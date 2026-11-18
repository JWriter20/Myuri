"""The Cursor's reads of the page, each one ``driver.evaluate``, so a driver
needs no selector engine. Mirrors the JS ``page.ts``: selectors are resolved in
the page (``RESOLVE_SELECTOR_JS``) and geometry is in the top page's viewport,
where mouse input is dispatched.
"""
from __future__ import annotations

import asyncio
import time
from typing import Optional

from .drivers.base import Driver
from .page_functions import BOX_JS, on_selector
from .types import BoundingBox, ViewportSize

_VIEWPORT_JS = (
    "() => ({width: window.innerWidth || document.documentElement.clientWidth,"
    " height: window.innerHeight || document.documentElement.clientHeight})"
)
_BOX_ON_SELECTOR = on_selector(BOX_JS)


async def viewport_of(driver: Driver) -> ViewportSize:
    """Viewport dimensions, robust to quirks mode and null-viewport fingerprints."""
    vp = await driver.evaluate(_VIEWPORT_JS, None)
    if not vp or not vp.get("width") or not vp.get("height"):
        raise RuntimeError("myuri: could not read viewport size")
    return ViewportSize(width=vp["width"], height=vp["height"])


async def bounding_box_of(driver: Driver, selector: str) -> Optional[BoundingBox]:
    """Bounding box of a selector in the top page's viewport, or None if it is not found or has no size."""
    box = await driver.evaluate(_BOX_ON_SELECTOR, {"selector": selector, "arg": None})
    return None if box is None else BoundingBox(x=box["x"], y=box["y"], width=box["width"], height=box["height"])


async def scroll_offset_of(driver: Driver) -> float:
    """The page's vertical scroll offset."""
    return await driver.evaluate("() => window.scrollY", None)


async def wait_for_element(driver: Driver, selector: str, timeout: float) -> bool:
    """Poll until the selector names an element with a size, or ``timeout`` ms pass. Returns whether it did."""
    deadline = time.monotonic() + timeout / 1000.0
    while True:
        if driver.is_closed():
            return False
        if await bounding_box_of(driver, selector):
            return True
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.05)
