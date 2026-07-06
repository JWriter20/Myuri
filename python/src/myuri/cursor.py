"""The Cursor: a human-like cursor bound to a :class:`Driver` (mirror of
``js/src/cursor.ts``)."""
from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

from .drivers.base import Driver, define_driver  # noqa: F401 (re-exported convenience)
from .drivers.playwright import driver_from_page
from .geometry import (
    VIEWPORT_PADDING,
    clamp_to_browser_bounds,
    get_better_starting_position,
    get_random_box_point,
    path,
    should_overshoot,
)
from .motion.scroll_model import scroll_model
from .options import ClickOptions, MoveOptions, MoveToOptions, ScrollOptions, TypeOptions
from .page import (
    bounding_box_of,
    point_hits_target,
    scroll_metrics_of,
    viewport_of,
    wait_for_element,
)
from .rng import generate_random_seed, make_rng
from .settings import resolve_settings
from .types import BoundingBox, Vector, overshoot as overshoot_point
from .typing_engine.typer import HumanTyper


async def _delay(ms: float) -> None:
    if ms < 1:
        return
    await asyncio.sleep(ms / 1000.0)


def _point_in_box(p: Vector, b: BoundingBox) -> bool:
    return b.x <= p.x <= b.x + b.width and b.y <= p.y <= b.y + b.height


def _pick(opt: Any, name: str, default: Any) -> Any:
    value = getattr(opt, name, None) if opt is not None else None
    return default if value is None else value


class _DriverTyperInput:
    """Adapts a Driver's key methods to the typer's input protocol."""

    def __init__(self, driver: Driver) -> None:
        self._d = driver

    async def press(self, key: str, delay: Optional[float] = None) -> None:
        await self._d.press(key, delay)

    async def down(self, key: str) -> None:
        await self._d.down(key)

    async def up(self, key: str) -> None:
        await self._d.up(key)


class Cursor:
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
    ) -> None:
        self._driver = driver
        self._seed = (seed if seed is not None else generate_random_seed()) & 0xFFFFFFFF
        self._rng = make_rng(self._seed)
        self._settings = resolve_settings(settings)
        self._defaults = defaults or {}
        self._previous = start or get_better_starting_position(dimensions, self._rng)
        self._is_moving = False
        self._performing_random_moves = False
        self._random_move_task: Optional[asyncio.Task] = None
        self._disposed = False
        self._scroll_multiplier: Optional[float] = None

        self._typer = HumanTyper(
            _DriverTyperInput(driver),
            wpm=self._settings.typing.wpm,
            layout=self._settings.typing.layout,
            mistake_multiplier=self._settings.typing.mistake_multiplier,
            rng=self._rng,
        )
        if perform_random_moves_initially:
            self._set_random_move(True)

    # ---- public accessors ----
    def get_seed(self) -> int:
        return self._seed

    def get_location(self) -> Vector:
        return Vector(self._previous.x, self._previous.y)

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
        target = get_random_box_point(
            BoundingBox(0, 0, vp.width, vp.height), None, self._previous, None, self._rng
        )
        await self.move_to(target, MoveToOptions(move_speed=opts.get("move_speed"), move_delay=0, randomize_move_delay=False))
        if self._performing_random_moves:
            self._schedule_random_move()

    # ---- primitive motion ----
    async def _trace_path(self, vectors) -> None:
        if not vectors:
            return
        vp = await viewport_of(self._driver)
        prev_t = vectors[0].timestamp
        for v in vectors:
            if self._driver.is_closed():
                return
            clamped = clamp_to_browser_bounds(v.x, v.y, vp)
            pos = Vector(round(clamped.x), round(clamped.y))
            target_delta = v.timestamp - prev_t
            prev_t = v.timestamp
            t0 = time.monotonic()
            await self._driver.move(pos.x, pos.y)
            self._previous = pos
            await _delay(target_delta - (time.monotonic() - t0) * 1000.0)

    async def _move_along(self, destination: Vector, options, allow_overshoot: bool) -> None:
        if allow_overshoot:
            o = overshoot_point(destination, self._settings.overshoot.radius, self._rng)
            await self._trace_path(path(self._previous, o, options, self._rng))
            dwell = self._settings.overshoot.dwell
            await _delay(dwell.min_ms + self._rng() * max(0, dwell.max_ms - dwell.min_ms))
            speed = (_pick(options, "move_speed", 1)) * self._settings.overshoot.correction_speed_factor
            await self._trace_path(path(self._previous, destination, MoveToOptions(move_speed=speed), self._rng))
        else:
            await self._trace_path(path(self._previous, destination, options, self._rng))

    async def move_to(self, destination: Vector, options: Optional[MoveToOptions] = None) -> None:
        was_random = self._start_action()
        try:
            await self._move_along(destination, options, False)
        finally:
            await self._end_action(was_random, _pick(options, "move_delay", 0), _pick(options, "randomize_move_delay", True))

    async def _resolve_exclude_boxes(self, selectors) -> list:
        if selectors is None:
            return []
        items = [selectors] if isinstance(selectors, str) else list(selectors)
        boxes = []
        for sel in items:
            try:
                box = await bounding_box_of(self._driver, sel)
            except Exception:
                box = None
            if box:
                boxes.append(box)
        return boxes

    async def move(self, selector: str, options: Optional[MoveOptions] = None) -> None:
        was_random = self._start_action()
        try:
            await self._move_to_element(selector, options)
        finally:
            await self._end_action(was_random, _pick(options, "move_delay", 0), _pick(options, "randomize_move_delay", True))

    async def _move_to_element(self, selector: str, options) -> None:
        max_tries = _pick(options, "max_tries", 3)
        wait_ms = _pick(options, "wait_for_selector", 10000)
        timeout = _pick(options, "timeout", None)
        overshoot_threshold = _pick(options, "overshoot_threshold", self._settings.overshoot.threshold)
        deadline = (time.monotonic() + timeout / 1000.0) if timeout is not None else None
        last_error: Optional[Exception] = None

        for _ in range(max_tries):
            if self._driver.is_closed():
                return
            remaining_ms = wait_ms if deadline is None else (deadline - time.monotonic()) * 1000.0
            if remaining_ms <= 0:
                break
            found = await wait_for_element(self._driver, selector, "visible", min(wait_ms, remaining_ms))
            if not found:
                last_error = RuntimeError(f"myuri: element not found or not visible: {selector}")
                continue
            box = await bounding_box_of(self._driver, selector)
            if not box:
                last_error = RuntimeError(f"myuri: element has no box: {selector}")
                continue
            exclude_boxes = await self._resolve_exclude_boxes(_pick(options, "exclude_selectors", None))
            destination = get_random_box_point(box, options, self._previous, exclude_boxes, self._rng)
            await self._move_along(destination, options, should_overshoot(self._previous, destination, overshoot_threshold))
            final_box = await bounding_box_of(self._driver, selector)
            if final_box and _point_in_box(self._previous, final_box) and await point_hits_target(self._driver, self._previous, selector):
                return
            last_error = RuntimeError(f"myuri: cursor did not land on {selector}")
        if last_error:
            raise last_error

    async def click(self, selector: Optional[str] = None, options: Optional[ClickOptions] = None) -> None:
        was_random = self._start_action()
        try:
            button = _pick(options, "button", "left")
            if selector is not None:
                move_opts = options if options is not None else ClickOptions()
                await self._move_to_element(selector, move_opts)
                if _pick(options, "dynamic_adjustment", True):
                    final_box = await bounding_box_of(self._driver, selector)
                    if final_box and not await point_hits_target(self._driver, self._previous, selector):
                        exclude_boxes = await self._resolve_exclude_boxes(_pick(options, "exclude_selectors", None))
                        target = get_random_box_point(final_box, options, self._previous, exclude_boxes, self._rng)
                        await self._move_along(target, options, False)
                if not await point_hits_target(self._driver, self._previous, selector):
                    raise RuntimeError(f"myuri: click point is occluded for '{selector}'")
                if _pick(options, "micro_jitter", False):
                    await self._driver.move(self._previous.x + (self._rng() - 0.5) * 2, self._previous.y + (self._rng() - 0.5) * 2)
                    await _delay(15 + self._rng() * 10)
            await self._driver.click(button)
            await _delay(max(_pick(options, "wait_for_click", 50), 15))
        finally:
            await self._end_action(was_random, _pick(options, "move_delay", 0), _pick(options, "randomize_move_delay", True))

    # ---- typing ----
    async def _platform_select_all_modifier(self) -> str:
        is_mac = await self._driver.evaluate(
            "() => /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)", None
        )
        return "Meta" if is_mac else "Control"

    async def type(self, text: str, selector: Optional[str] = None, options: Optional[TypeOptions] = None) -> None:
        was_random = self._start_action()
        try:
            if selector is not None:
                await self.click(selector, ClickOptions(wait_for_click=30, wait_for_selector=_pick(options, "wait_for_selector", 10000), max_tries=_pick(options, "max_tries", 3)))
            if _pick(options, "clear_existing", False):
                await self._typer.delete_all(0, await self._platform_select_all_modifier())
            await self._typer.type(text)
        finally:
            await self._end_action(was_random, 0, False)

    async def paste(self, value: str, selector: Optional[str] = None) -> None:
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
        was_random = self._start_action()
        try:
            await self._move_along(
                Vector(self._previous.x + self._rng() * 20 - 10, self._previous.y + self._rng() * 20 - 10),
                MoveToOptions(move_delay=0, randomize_move_delay=False),
                False,
            )
            wait_ms = _pick(options, "wait_for_selector", 10000)
            if not await wait_for_element(self._driver, selector, "visible", wait_ms):
                raise RuntimeError(f"myuri: element not found: {selector}")
            for _ in range(_pick(options, "max_tries", 3)):
                await self._scroll_to_element(selector, options)
                if await self._is_element_in_view(selector):
                    break
        finally:
            await self._end_action(was_random, 0, False)

    async def _is_element_in_view(self, selector: str) -> bool:
        box = await bounding_box_of(self._driver, selector)
        if not box:
            return False
        vp = await viewport_of(self._driver)
        pad = max(20, VIEWPORT_PADDING + 5)
        return box.y >= pad and box.y + box.height <= vp.height - pad

    async def _scroll_to_element(self, selector: str, options) -> None:
        box = await bounding_box_of(self._driver, selector)
        if not box:
            return
        vp = await viewport_of(self._driver)
        finish_position = _pick(options, "finish_position", self._settings.scroll.finish_position)
        target_y = vp.height * finish_position
        element_center_y = box.y + box.height / 2
        wanted = (element_center_y - target_y) * (self._scroll_multiplier or 1)
        if abs(wanted) < 1:
            return
        pre = (await scroll_metrics_of(self._driver)).offset
        realism = _pick(options, "realism", None)
        speed_irregularity = getattr(realism, "speed_irregularity", None) if realism else None
        if speed_irregularity is None:
            speed_irregularity = self._settings.scroll.realism.speed_irregularity
        events = scroll_model.generate_scroll_path(wanted, self._rng, None, speed_irregularity)
        sf = _pick(options, "speed_factor", 1)

        accumulator = 0.0
        for ev in events:
            accumulator += ev.delta_y
            t0 = time.monotonic()
            if abs(accumulator) >= 8:
                dispatch = int(accumulator)
                accumulator -= dispatch
                await self._driver.wheel(0, dispatch)
            await _delay(ev.delta_time / sf - (time.monotonic() - t0) * 1000.0)
        if abs(round(accumulator)) >= 1:
            await self._driver.wheel(0, round(accumulator))

        post = await self._settle_scroll(pre)
        actual = post - pre
        if self._scroll_multiplier is None and abs(wanted) > 10 and abs(actual) > 10:
            self._scroll_multiplier = round((wanted / actual) * 100) / 100

    async def _settle_scroll(self, previous_offset: float) -> float:
        last = previous_offset
        stable = 0
        deadline = time.monotonic() + 0.6
        while True:
            await _delay(40)
            cur = (await scroll_metrics_of(self._driver)).offset
            if cur == last:
                stable += 1
                if stable >= 3 or time.monotonic() >= deadline:
                    return cur
            else:
                stable = 0
                last = cur
            if time.monotonic() >= deadline:
                return cur

    # ---- misc ----
    async def set_cursor_location(self, location: Vector) -> None:
        vp = await viewport_of(self._driver)
        clamped = clamp_to_browser_bounds(location.x, location.y, vp)
        pos = Vector(round(clamped.x), round(clamped.y))
        await self._driver.move(pos.x, pos.y)
        self._previous = pos

    async def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        self._set_random_move(False)
        if self._random_move_task is not None:
            self._random_move_task.cancel()
            self._random_move_task = None
        await self._driver.dispose()


def create_cursor(page_or_driver: Any, **options: Any) -> Cursor:
    """Create a :class:`Cursor`. Pass a Playwright page (driver inferred) or a
    :class:`Driver` instance for full control."""
    driver = page_or_driver if isinstance(page_or_driver, Driver) else driver_from_page(page_or_driver)
    return Cursor(driver, **options)
