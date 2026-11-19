"""The Cursor: a human-like cursor bound to a :class:`Driver`, on myuri's
smart actions (``actions.py``). Mirror of ``js/src/cursor.ts``."""
from __future__ import annotations

import asyncio
import math
import time
from contextlib import contextmanager
from typing import Any, Iterator, List, Optional, Union

from .actions import Actions, Flow
from .drivers.base import Driver, _accepts_positional, define_driver  # noqa: F401 (re-exported convenience)
from .drivers.playwright import driver_from_page
from .geometry import get_better_starting_position, get_random_box_point, is_point_excluded
from .motion.click_model import drag_carry_speed, drag_end_ms, drag_start_ms, pre_click_dwell_ms
from .options import ClickOptions, DragOptions, MoveOptions, MoveToOptions, ScrollOptions, TypeOptions
from .page import bounding_box_of, scroll_offset_of, viewport_of, wait_for_element
from .page_functions import FOCUSED_FIELD_JS, on_selector
from .plan import wheel_steps, wheel_style_for
from .profile import profile_from_seed
from .rng import Rng, generate_random_seed, make_rng
from .target_os import primary_modifier
from .types import BoundingBox, Vector, point_in_box
from .typing_engine.typer import HumanTyper

_BOX_FIELDS = (
    "width_padding_percentage", "height_padding_percentage",
    "padding_left", "padding_right", "padding_top", "padding_bottom",
)
_PRESENT = on_selector("() => true")


async def _delay(ms: float) -> None:
    if ms < 1:
        return
    await asyncio.sleep(ms / 1000.0)


class _DriverHost:
    """A driver as the smart actions' host. A target is a selector, measured in the top page."""

    def __init__(self, driver: Driver) -> None:
        self.driver = driver
        self._sent: List[asyncio.Future] = []

    def move(self, x: float, y: float) -> Any:
        return self.driver.move(x, y)

    async def click(self, button: str, click_count: int, hold_ms: float) -> None:
        # Drivers written before click_count/hold_ms get what they take.
        click = self.driver.click
        if _accepts_positional(click, 3):
            await click(button, click_count, hold_ms)
        elif _accepts_positional(click, 2):
            await click(button, click_count)
        else:
            await click(button)

    def down(self, button: str) -> Any:
        return self.driver.mouse_down(button)

    def up(self, button: str) -> Any:
        return self.driver.mouse_up(button)

    def wheel(self, dx: float, dy: float) -> None:
        """Sent without waiting for the page, as a device sends them: a browser
        acknowledges a wheel event only on its next frame, so awaiting each one
        stretches a gesture. Tasks start in creation order over one connection,
        so they arrive in order. :meth:`landed` waits for them."""
        self._sent.append(asyncio.ensure_future(self.driver.wheel(dx, dy)))

    async def landed(self) -> None:
        sent, self._sent = self._sent, []
        errors = [r for r in await asyncio.gather(*sent, return_exceptions=True) if isinstance(r, BaseException)]
        if errors:
            raise errors[0]

    def key_down(self, key: str) -> Any:
        return self.driver.down(key)

    def key_up(self, key: str) -> Any:
        return self.driver.up(key)

    def insert_text(self, text: str) -> Any:
        return self.driver.insert_text(text)

    def evaluate(self, selector: str, fn: str, arg: Any) -> Any:
        return self.driver.evaluate(on_selector(fn), {"selector": selector, "arg": arg})

    async def offset(self, selector: str) -> Optional[tuple]:
        return (0, 0) if await self.driver.evaluate(_PRESENT, {"selector": selector, "arg": None}) else None

    async def viewport(self) -> tuple:
        vp = await viewport_of(self.driver)
        return (vp.width, vp.height)

    def now(self) -> float:
        return time.monotonic() * 1000.0

    def sleep(self, ms: float) -> Any:
        return _delay(ms)


class _CursorActions(Actions):
    """The smart actions with the Cursor's options: where in a box to press, and a calibrated wheel."""

    def __init__(self, host: _DriverHost, rng: Rng, **options: Any) -> None:
        super().__init__(host, rng, asynchronous=True, **options)
        # Padding and boxes to avoid when choosing a point, for the action under way.
        self.box_options: Optional[MoveOptions] = None
        self.exclude: List[BoundingBox] = []
        # Wheel px per page px, calibrated on the first page scroll (drivers and DPRs scale a delta).
        self._scroll_multiplier: Optional[float] = None

    @property
    def since_move(self) -> float:
        return self.host.now() - self._moved_at

    def _default_point(self, box: BoundingBox, attempt: int) -> Flow:
        if self.box_options is None:
            return (yield from super()._default_point(box, attempt))
        here = self.cursor
        # A person already on the target presses where they are.
        if here is not None and self._placed and point_in_box(here, box) and not is_point_excluded(here, self.exclude):
            return (here.x, here.y)
        p = get_random_box_point(box, self.box_options, here, self.exclude, self.rng)
        return (p.x, p.y)

    def _default_wheel(self, dx: float, dy: float) -> Flow:
        host = self.host
        m = self._scroll_multiplier or 1
        steps = wheel_steps(dx * m, dy * m, self.rng, os=self.os, spec=self._wheel_spec())
        dispatched = sum(step[2] for step in steps if step[0] == "wheel")
        pre = yield scroll_offset_of(host.driver)
        yield from self.play(steps)
        yield host.landed()
        moved = (yield self._settle(pre)) - pre
        # Clamped: a first scroll cut short by the end of the page would inflate every later one.
        if self._scroll_multiplier is None and abs(dispatched) > 10 and abs(moved) > 10:
            self._scroll_multiplier = min(3.0, max(0.3, round((dispatched / moved) * 100) / 100))

    async def _settle(self, previous: float) -> float:
        """The page's scroll offset once it stops moving (a container scroll leaves it still)."""
        last = previous
        stable = 0
        deadline = time.monotonic() + 0.6
        while True:
            await _delay(40)
            cur = await scroll_offset_of(self.host.driver)
            if cur == last:
                stable += 1
            else:
                stable = 0
                last = cur
            if stable >= 3 or time.monotonic() >= deadline:
                return cur


def _pick(opt: Any, name: str, default: Any) -> Any:
    value = getattr(opt, name, None) if opt is not None else None
    return default if value is None else value


class _DriverTyperInput:
    """Adapts a Driver's key methods to the typer's input protocol."""

    def __init__(self, driver: Driver) -> None:
        self._d = driver

    async def down(self, key: str) -> None:
        await self._d.down(key)

    async def up(self, key: str) -> None:
        await self._d.up(key)

    async def insert_text(self, text: str) -> None:
        # Code points no US-layout key produces (an AZERTY 'é' typo slip,
        # emoji): Playwright's keyboard would throw "Unknown key".
        await self._d.insert_text(text)


class Cursor:
    """A human-like cursor bound to a :class:`Driver`, on myuri's smart actions (``actions.py``)."""

    def __init__(
        self,
        driver: Driver,
        *,
        seed: Optional[int] = None,
        settings: Optional[dict] = None,
        start: Optional[Vector] = None,
        dimensions: Optional[dict] = None,
        perform_random_moves_initially: bool = False,
        defaults: Optional[dict] = None,
        select_all_modifier: Optional[str] = None,
        os: Optional[str] = None,
    ) -> None:
        if os is not None and select_all_modifier is not None and select_all_modifier != primary_modifier(os):
            raise ValueError(f"myuri: select_all_modifier {select_all_modifier} is not select-all on {os}")
        # The OS the browser claims: it picks the paste modifier, whether a move
        # repeats a position and how a mouse wheel scrolls (target_os.py).
        # Timing is the same on every OS.
        if os is not None:
            driver.os = os
        self._driver = driver
        self._seed = (seed if seed is not None else generate_random_seed()) & 0xFFFFFFFF
        self._rng = make_rng(self._seed)
        resolved = profile_from_seed(self._seed, settings)
        resolved.scroll.wheel.style = wheel_style_for(os, settings)
        self._actions = _CursorActions(_DriverHost(driver), self._rng, os=os, settings=resolved)
        self._settings = self._actions.settings
        self._defaults = defaults or {}
        # Opt-in keyboard select-all for clear_existing. Off by default: the
        # modifier reveals the real OS (pages read ctrlKey/metaKey, and browsers
        # only honor the host OS's one), so fields are cleared by triple-click.
        self._select_all_modifier = select_all_modifier
        self._actions.cursor = start or get_better_starting_position(dimensions, self._rng)
        self._is_moving = False
        self._performing_random_moves = False
        self._random_move_task: Optional[asyncio.Task] = None
        self._disposed = False

        self._typer = HumanTyper(
            _DriverTyperInput(driver),
            wpm=self._settings.typing.wpm,
            mistake_multiplier=self._settings.typing.mistake_multiplier,
            pauses=self._settings.typing.pauses,
            rng=self._rng,
        )
        if perform_random_moves_initially:
            self._set_random_move(True)

    # ---- public accessors ----
    def get_seed(self) -> int:
        return self._seed

    def get_settings(self):
        """The resolved behavioral settings (profile) this cursor is running with."""
        return self._settings

    def get_location(self) -> Vector:
        here = self._actions.cursor
        return Vector(here.x, here.y)

    # ---- action lifecycle ----
    def _start_action(self) -> bool:
        was_random = self._performing_random_moves
        if was_random:
            self._set_random_move(False)
        self._is_moving = True
        return was_random

    async def _end_action(self, was_random: bool, move_delay: float = 0.0, randomize: bool = False) -> None:
        self._is_moving = False
        jitter = self._rng() if randomize else 1.0
        await _delay(move_delay * jitter)
        if was_random:
            self._set_random_move(True)

    @contextmanager
    def _tuned(self, **tuning: Any) -> Iterator[None]:
        """Apply ``tuning`` to the actions for one call, then restore them."""
        saved = {}
        for name, value in tuning.items():
            if value is not None:
                saved[name] = getattr(self._actions, name)
                setattr(self._actions, name, value)
        try:
            yield
        finally:
            for name, value in saved.items():
                setattr(self._actions, name, value)

    async def _glide(self, to: Vector, move_speed: Optional[float] = None) -> None:
        """A move straight to a point, without an overshoot."""
        with self._tuned(move_speed=move_speed, overshoot_threshold=math.inf):
            await self._actions.run(self._actions.move(to.x, to.y))

    def toggle_random_move(self, random: bool) -> None:
        self._set_random_move(random)

    def _set_random_move(self, random: bool) -> None:
        if self._performing_random_moves == random:
            return
        self._performing_random_moves = random
        if random:
            self._schedule_random_move()
        elif self._random_move_task is not None:
            self._random_move_task.cancel()
            self._random_move_task = None

    def _schedule_random_move(self) -> None:
        if not self._performing_random_moves or self._is_moving:
            return
        opts = self._defaults.get("random_move", {})
        base = opts.get("move_delay", 2000)
        randomize = opts.get("randomize_move_delay", True)
        delay_s = (base * (0.5 + self._rng() * 0.5 if randomize else 1)) / 1000.0

        async def runner() -> None:
            try:
                await asyncio.sleep(delay_s)
                if not self._performing_random_moves or self._is_moving or self._driver.is_closed():
                    return
                await self._perform_random_move(opts)
            except asyncio.CancelledError:
                pass
            except Exception:
                self._set_random_move(False)

        self._random_move_task = asyncio.ensure_future(runner())

    async def _perform_random_move(self, opts: dict) -> None:
        vp = await viewport_of(self._driver)
        target = get_random_box_point(BoundingBox(0, 0, vp.width, vp.height), None, self._actions.cursor, None, self._rng)
        await self.move_to(target, MoveToOptions(move_speed=opts.get("move_speed"), move_delay=0, randomize_move_delay=False))
        if self._performing_random_moves:
            self._schedule_random_move()

    # ---- motion ----
    async def move_to(self, destination: Vector, options: Optional[MoveToOptions] = None) -> None:
        """Move to an absolute viewport point."""
        was_random = self._start_action()
        try:
            await self._glide(destination, _pick(options, "move_speed", None))
        finally:
            await self._end_action(was_random, _pick(options, "move_delay", 0), _pick(options, "randomize_move_delay", True))

    async def _reach(self, selector: str, options: Any, press: bool, click_count: int = 1) -> None:
        """Scroll an element into view, move onto it and, with ``press``, press
        it. A miss is tried again, as Playwright retries an action, until
        ``max_tries`` tries or ``timeout`` ms."""
        selectors = _pick(options, "exclude_selectors", None)
        exclude = []
        for sel in [] if selectors is None else [selectors] if isinstance(selectors, str) else selectors:
            box = await bounding_box_of(self._driver, sel)
            if box:
                exclude.append(box)
        custom = bool(exclude) or any(_pick(options, f, None) is not None for f in _BOX_FIELDS)
        with self._tuned(
            move_speed=_pick(options, "move_speed", None),
            overshoot_threshold=_pick(options, "overshoot_threshold", None),
            hold_ms=_pick(options, "hold_ms", None),
            box_options=options if custom else None,
            exclude=exclude if custom else None,
        ):
            await self._actions.run(self._actions.click(
                selector,
                button=_pick(options, "button", "left"),
                click_count=click_count,
                press=press,
                timeout=_pick(options, "timeout", 10000),
                attempts=_pick(options, "max_tries", None),
            ))

    async def move(self, selector: str, options: Optional[MoveOptions] = None) -> None:
        """Move the cursor onto an element, scrolling it into view and trying again if it misses."""
        was_random = self._start_action()
        try:
            await self._reach(selector, options, False)
        finally:
            await self._end_action(was_random, _pick(options, "move_delay", 0), _pick(options, "randomize_move_delay", True))

    async def drag(self, from_: Union[str, Vector], to: Union[str, Vector], options: Optional[DragOptions] = None) -> None:
        """Press on ``from_``, move to ``to`` with the button held, and release.

        Timed like recorded people (see ``motion/click_model.py``). Each end is a
        selector (a point inside the element is chosen, as for :meth:`click`)
        or a viewport :class:`Vector`. ``to`` is measured after the press, so a
        drop zone that appears once a drag starts works. Needs a driver with
        ``mouse_down``/``mouse_up`` (the built-in drivers have them).
        """
        opts = options if options is not None else DragOptions()
        button = _pick(opts, "button", "left")
        was_random = self._start_action()
        try:
            if isinstance(from_, str):
                await self._reach(from_, opts, False)
            else:
                await self._glide(from_, opts.move_speed)
            await _delay(pre_click_dwell_ms(self._rng) - self._actions.since_move)
            await self._driver.mouse_down(button)
            released = False
            try:
                await _delay(drag_start_ms(self._rng))
                if isinstance(to, str):
                    box = await bounding_box_of(self._driver, to)
                    if not box:
                        raise RuntimeError(f"myuri: drag target not found or not visible: {to}")
                    target = get_random_box_point(box, opts, self._actions.cursor, [], self._rng)
                else:
                    target = to
                # Carrying something, people move slower and steer straight to the drop: no overshoot.
                await self._glide(target, (opts.move_speed or self._actions.move_speed) * drag_carry_speed(self._rng))
                await _delay(drag_end_ms(self._rng) - self._actions.since_move)
                released = True
                await self._driver.mouse_up(button)
            finally:
                if not released:
                    try:
                        await self._driver.mouse_up(button)
                    except Exception:
                        pass
            await _delay(_pick(opts, "wait_for_release", 50))
        finally:
            await self._end_action(was_random, 0, False)

    async def click(self, selector: Optional[str] = None, options: Optional[ClickOptions] = None) -> None:
        """Click an element (scrolling to and moving onto it first) or click at the current position."""
        was_random = self._start_action()
        try:
            count = max(1, min(3, round(_pick(options, "click_count", 1))))
            if selector is not None:
                await self._reach(selector, options, True, count)
            else:
                with self._tuned(hold_ms=_pick(options, "hold_ms", None)):
                    await self._actions.run(self._actions.press(_pick(options, "button", "left"), count))
            await _delay(max(_pick(options, "wait_for_click", 50), 15))
        finally:
            await self._end_action(was_random, _pick(options, "move_delay", 0), _pick(options, "randomize_move_delay", True))

    # ---- typing ----
    async def _clear_focused_field(self, focus_clicked: bool) -> None:
        """Empty the focused field, by default without sending a modifier key.

        Triple-click selects a single-line field outright; multi-line content is
        triple-clicked on its first paragraph and extended with Shift+ArrowDown
        (the same keys on every OS). ``focus_clicked`` means the click that
        focused the field just happened at the cursor, so the triple-click
        continues it.
        """
        field = await self._driver.evaluate(FOCUSED_FIELD_JS, None)
        if not field:
            raise RuntimeError("myuri: clear_existing needs a focused field (pass a selector)")
        if field["empty"]:
            return
        if self._select_all_modifier:
            await self._typer.delete_all(0, self._select_all_modifier)
        else:
            box = BoundingBox(**field["box"])
            if not point_in_box(self._actions.cursor, box):
                await self._glide(get_random_box_point(box, None, self._actions.cursor, [], self._rng))
                focus_clicked = False
            at = self._actions.cursor
            span = field.get("firstLineSpan")
            on_first_line = span is None or (span["left"] <= at.x <= span["right"] - 2 and span["top"] <= at.y <= span["bottom"])
            clicks = 2 if focus_clicked else 3
            if field["lines"] > 1 or (field.get("singleLine") is False and not on_first_line):
                # Triple-click selects one paragraph, so start on the first one:
                # wheel the field back to its top if needed, then triple-click
                # there. One line in a textarea or editor needs it too unless
                # the cursor is already on the text (see firstLineSpan).
                for _ in range(30):
                    if field["scrollTop"] <= 0:
                        break
                    await self._driver.wheel(0, -min(field["scrollTop"], 80 + self._rng() * 80))
                    await _delay(30 + self._rng() * 40)
                    field = await self._driver.evaluate(FOCUSED_FIELD_JS, None) or field
                first = field["firstLine"]
                await self._glide(Vector(first["x"] + self._rng() * 12, first["y"] + (self._rng() - 0.5) * 3))
                clicks = 3
            # Right after the focusing click, a double click in place continues it into a triple.
            await self._actions.run(self._actions.press("left", clicks))
            if field["lines"] > 1:
                await _delay(120 + self._rng() * 120)
                await self._driver.down("Shift")
                for _ in range(max(field["lines"], field["visualLines"]) + 2):
                    current = await self._driver.evaluate(FOCUSED_FIELD_JS, None)
                    if not current or current["selection"] != "partial":
                        break
                    await self._driver.press("ArrowDown")
                    await _delay(40 + self._rng() * 60)
                await self._driver.up("Shift")
            await _delay(60 + self._rng() * 90)
            await self._typer.delete_all(1)
        after = await self._driver.evaluate(FOCUSED_FIELD_JS, None)
        if not (after and after["empty"]):
            raise RuntimeError("myuri: clear_existing could not empty the focused field")

    async def type(self, text: str, selector: Optional[str] = None, options: Optional[TypeOptions] = None) -> None:
        """Type text, optionally clicking a field first."""
        was_random = self._start_action()
        try:
            if selector is not None:
                await self.click(selector, ClickOptions(wait_for_click=30, timeout=_pick(options, "timeout", None), max_tries=_pick(options, "max_tries", None)))
            if _pick(options, "clear_existing", False):
                await self._clear_focused_field(selector is not None)
            await self._typer.type(text)
        finally:
            await self._end_action(was_random, 0, False)

    async def paste(self, value: str, selector: Optional[str] = None) -> None:
        """Insert text at the current focus (paste semantics)."""
        was_random = self._start_action()
        try:
            if selector is not None:
                await self.click(selector, ClickOptions(wait_for_click=30))
            await self._driver.insert_text(value)
            await _delay(self._rng() * 25 + 25)
        finally:
            await self._end_action(was_random, 0, False)

    # ---- scrolling ----
    async def scroll(self, selector: str, options: Optional[ScrollOptions] = None) -> None:
        """Scroll an element into view with the wheel, honoring ``finish_position``."""
        was_random = self._start_action()
        try:
            # Ensure the mouse is over the page so wheel events land.
            here = self._actions.cursor
            await self._glide(Vector(here.x + self._rng() * 20 - 10, here.y + self._rng() * 20 - 10))
            if not await wait_for_element(self._driver, selector, _pick(options, "timeout", 10000)):
                raise RuntimeError(f"myuri: element not found: {selector}")
            realism = _pick(options, "realism", None)
            with self._tuned(
                finish_position=_pick(options, "finish_position", self._settings.scroll.finish_position),
                scroll_passes=_pick(options, "max_tries", 3),
                speed_factor=_pick(options, "speed_factor", None),
                speed_irregularity=_pick(realism, "speed_irregularity", None),
            ):
                await self._actions.run(self._actions.into_view(selector))
        finally:
            await self._end_action(was_random, 0, False)

    # ---- misc ----
    async def set_cursor_location(self, location: Vector) -> None:
        """Teleport the cursor to a point without an animated path."""
        vp = await viewport_of(self._driver)
        x = min(max(round(location.x), 0), vp.width - 1)
        y = min(max(round(location.y), 0), vp.height - 1)
        await self._driver.move(x, y)
        self._actions.moved(x, y)

    async def dispose(self) -> None:
        """Release backend resources (CDP sessions, timers). Safe to call twice."""
        if self._disposed:
            return
        self._disposed = True
        self._set_random_move(False)
        if self._random_move_task is not None:
            self._random_move_task.cancel()
            self._random_move_task = None
        await self._driver.dispose()


def create_cursor(page_or_driver: Any, **options: Any) -> Cursor:
    """Create a :class:`Cursor`. Pass a driver (e.g. ``from_playwright(page)``), a
    raw Playwright page (driver inferred), or a :class:`Driver` instance."""
    driver = page_or_driver if isinstance(page_or_driver, Driver) else driver_from_page(page_or_driver)
    return Cursor(driver, **options)
