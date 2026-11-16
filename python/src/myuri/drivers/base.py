"""The Driver seam: the small async interface myuri needs to drive a browser.

Split into input primitives (dispatch synthetic events) and a query seam
(``evaluate``) that every DOM measurement is built on. ``evaluate`` takes a JS
arrow-function *source string* and one JSON-serializable argument, mirroring
Playwright's ``page.evaluate(js, arg)`` and raw CDP ``Runtime.evaluate`` — so any
backend that can run JS in the page and dispatch input can be wrapped.

Build one by subclassing :class:`Driver`, using :func:`define_driver` with
callables, or a prebuilt wrapper (e.g. :class:`myuri.drivers.PlaywrightDriver`).
"""
from __future__ import annotations

import inspect
from abc import ABC, abstractmethod
from typing import Any, Awaitable, Callable, Optional

# Deep in-page snippet used by the default clipboard implementation.
_SET_CLIPBOARD_JS = """
(text) => {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}
"""

_IS_MAC_JS = "() => /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)"


class Driver(ABC):
    """Abstract async driver. Required members are abstract; optional members
    have working defaults built on :meth:`evaluate`."""

    # ---- input primitives (required) ----
    @abstractmethod
    async def move(self, x: float, y: float) -> None: ...

    @abstractmethod
    async def click(self, button: str = "left", click_count: int = 1, hold_ms: Optional[float] = None) -> None:
        """Press-and-release at the current position. ``click_count`` is the
        click's place in a multi-click (2 and 3 continue a double/triple click,
        which browsers use to select a word/line). ``hold_ms`` is how long to
        hold the button; the cursor draws one per click from recorded people.
        A driver that ignores it holds for its own fixed time."""

    @abstractmethod
    async def down(self, key: str) -> None: ...

    @abstractmethod
    async def up(self, key: str) -> None: ...

    @abstractmethod
    async def wheel(self, delta_x: float, delta_y: float) -> None: ...

    @abstractmethod
    async def press(self, key: str, delay: Optional[float] = None) -> None: ...

    # ---- query seam (required) ----
    @abstractmethod
    async def evaluate(self, js: str, arg: Any = None) -> Any:
        """Run ``js`` (a ``(arg) => ...`` source string) in the page and return
        its JSON-serializable result."""

    # ---- optional (default implementations) ----
    def is_closed(self) -> bool:
        return False

    async def set_clipboard(self, text: str) -> None:
        await self.evaluate(_SET_CLIPBOARD_JS, text)

    async def insert_text(self, text: str) -> None:
        # No native insert: place on the clipboard and paste with the *browser's*
        # platform modifier (detected in-page, not from the automation host).
        await self.set_clipboard(text)
        is_mac = await self.evaluate(_IS_MAC_JS, None)
        mod = "Meta" if is_mac else "Control"
        await self.down(mod)
        await self.press("v")
        await self.up(mod)

    async def mouse_down(self, button: str = "left") -> None:
        """Press a mouse button without releasing it (for drags)."""
        raise NotImplementedError("myuri: this driver has no mouse_down(), which drag needs")

    async def mouse_up(self, button: str = "left") -> None:
        """Release a button pressed with :meth:`mouse_down`."""
        raise NotImplementedError("myuri: this driver has no mouse_up(), which drag needs")

    async def dispose(self) -> None:
        return None


AsyncFn = Callable[..., Awaitable[Any]]


def _accepts_positional(fn: Callable[..., Any], count: int) -> bool:
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return True
    if any(p.kind is inspect.Parameter.VAR_POSITIONAL for p in params):
        return True
    positional = (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    return sum(p.kind in positional for p in params) >= count


class _FunctionDriver(Driver):
    """A Driver assembled from plain callables (see :func:`define_driver`)."""

    def __init__(self, **fns: Any) -> None:
        self._fns = fns

    async def move(self, x: float, y: float) -> None:
        await self._fns["move"](x, y)

    async def click(self, button: str = "left", click_count: int = 1, hold_ms: Optional[float] = None) -> None:
        fn = self._fns["click"]
        # Older click callables take only ``button`` (plain clicks) or no hold.
        if hold_ms is not None and _accepts_positional(fn, 3):
            await fn(button, click_count, hold_ms)
        elif click_count != 1 and _accepts_positional(fn, 2):
            await fn(button, click_count)
        else:
            await fn(button)

    async def down(self, key: str) -> None:
        await self._fns["down"](key)

    async def up(self, key: str) -> None:
        await self._fns["up"](key)

    async def wheel(self, delta_x: float, delta_y: float) -> None:
        await self._fns["wheel"](delta_x, delta_y)

    async def press(self, key: str, delay: Optional[float] = None) -> None:
        await self._fns["press"](key, delay)

    async def evaluate(self, js: str, arg: Any = None) -> Any:
        return await self._fns["evaluate"](js, arg)

    def is_closed(self) -> bool:
        fn = self._fns.get("is_closed")
        return bool(fn()) if fn else False

    async def set_clipboard(self, text: str) -> None:
        fn = self._fns.get("set_clipboard")
        if fn:
            await fn(text)
        else:
            await super().set_clipboard(text)

    async def insert_text(self, text: str) -> None:
        fn = self._fns.get("insert_text")
        if fn:
            await fn(text)
        else:
            await super().insert_text(text)

    async def mouse_down(self, button: str = "left") -> None:
        fn = self._fns.get("mouse_down")
        if fn is None:
            await super().mouse_down(button)
        else:
            await fn(button)

    async def mouse_up(self, button: str = "left") -> None:
        fn = self._fns.get("mouse_up")
        if fn is None:
            await super().mouse_up(button)
        else:
            await fn(button)

    async def dispose(self) -> None:
        fn = self._fns.get("dispose")
        if fn:
            await fn()


def define_driver(
    *,
    move: AsyncFn,
    click: AsyncFn,
    down: AsyncFn,
    up: AsyncFn,
    wheel: AsyncFn,
    press: AsyncFn,
    evaluate: AsyncFn,
    is_closed: Optional[Callable[[], bool]] = None,
    set_clipboard: Optional[AsyncFn] = None,
    insert_text: Optional[AsyncFn] = None,
    dispose: Optional[AsyncFn] = None,
    mouse_down: Optional[AsyncFn] = None,
    mouse_up: Optional[AsyncFn] = None,
) -> Driver:
    """Assemble a :class:`Driver` from callables. Only the input primitives and
    ``evaluate`` are required; the rest get sensible defaults."""
    return _FunctionDriver(
        move=move,
        click=click,
        down=down,
        up=up,
        wheel=wheel,
        press=press,
        evaluate=evaluate,
        is_closed=is_closed,
        set_clipboard=set_clipboard,
        insert_text=insert_text,
        dispose=dispose,
        mouse_down=mouse_down,
        mouse_up=mouse_up,
    )
