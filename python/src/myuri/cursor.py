"""The Cursor: a human-like cursor bound to a :class:`Driver` (mirror of
``js/src/cursor.ts``)."""
from __future__ import annotations

import asyncio
import dataclasses
import time
from dataclasses import replace
from typing import Any, List, Optional, Union

from .drivers.base import Driver, _accepts_positional, define_driver  # noqa: F401 (re-exported convenience)
from .drivers.playwright import driver_from_page
from .geometry import (
    PlannedPoint,
    clamp_to_browser_bounds,
    get_better_starting_position,
    get_random_box_point,
    should_overshoot,
)
from .motion.click_model import drag_carry_speed, drag_end_ms, drag_start_ms, pre_click_dwell_ms
from .options import ClickOptions, DragOptions, MoveOptions, MoveToOptions, ScrollOptions, TypeOptions
from .target_os import primary_modifier
from .page import (
    bounding_box_of,
    point_hits_target,
    scroll_metrics_of,
    viewport_of,
    wait_for_element,
)
from .plan import WheelSpec, clicks_with, move_with, wheel_style_for, wheel_with
from .profile import profile_from_seed
from .rng import generate_random_seed, make_rng
from .scroll_plan import SCROLL_EDGE, SCROLL_PAD, SCROLL_PLAN_FOR_SELECTOR
from .settings import resolve_settings
from .types import BoundingBox, Vector
from .typing_engine.typer import HumanTyper


async def _delay(ms: float) -> None:
    if ms < 1:
        return
    await asyncio.sleep(ms / 1000.0)


def _point_in_box(p: Vector, b: BoundingBox) -> bool:
    return b.x <= p.x <= b.x + b.width and b.y <= p.y <= b.y + b.height


# Page function for clear_existing (mirror of ``focusedField`` in js/src/cursor.ts):
# the focused field, found by following focus through open shadow roots and
# same-origin iframes, with its box in top-page coordinates. Null when no field
# has focus (or it sits in a cross-origin frame). Tag names, not instanceof,
# since elements in an iframe belong to that frame's realm.
_FOCUSED_FIELD_JS = r"""() => {
  var el = document.activeElement, ox = 0, oy = 0;
  for (;;) {
    if (!el) return null;
    if (el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    } else if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      var fdoc = null;
      try { fdoc = el.contentDocument; } catch (e) { fdoc = null; }
      if (!fdoc) return null;
      var fr = el.getBoundingClientRect();
      ox += fr.x + el.clientLeft;
      oy += fr.y + el.clientTop;
      el = fdoc.activeElement;
    } else {
      break;
    }
  }
  var doc = el.ownerDocument;
  // A frame's body only counts when it is itself the editor (designMode or
  // contenteditable), as rich-text editors built on iframes do.
  if (el === doc.body && !el.isContentEditable) return null;
  var r = el.getBoundingClientRect();
  var cs = (doc.defaultView || window).getComputedStyle(el);
  var isTextControl = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  var text = isTextControl ? el.value : el.innerText.replace(/\n+$/, '');
  var lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
  var firstLine = {
    x: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + 6,
    y: r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - el.scrollTop + lineHeight / 2
  };
  var contentLeft = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  var lineTop = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - el.scrollTop;
  var span = { left: contentLeft, right: contentLeft, top: lineTop, bottom: lineTop + lineHeight };
  if (el.tagName === 'TEXTAREA') {
    var ctx = doc.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.font = cs.font;
      span.right = contentLeft + ctx.measureText(text.split('\n')[0]).width;
    }
  }
  var selection;
  if (isTextControl) {
    // email/number inputs expose no selection range; they are single-line,
    // which triple-click always selects whole.
    selection = el.selectionStart == null || (el.selectionStart === 0 && el.selectionEnd === text.length)
      ? 'all' : 'partial';
  } else {
    selection = String(doc.getSelection()).trim() === el.innerText.trim() ? 'all' : 'partial';
    // Rich content: aim at the first visible character instead.
    var walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var i = (n.textContent || '').search(/\S/);
      if (i < 0) continue;
      var range = doc.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      var c = range.getBoundingClientRect();
      firstLine = { x: c.left + c.width / 2 + 4, y: c.top + c.height / 2 };
      range.setEnd(n, (n.textContent || '').length);
      var line = range.getClientRects()[0] || c;
      span = { left: c.left, right: line.right, top: line.top, bottom: line.bottom };
      break;
    }
  }
  return {
    box: { x: r.x + ox, y: r.y + oy, width: r.width, height: r.height },
    empty: text.trim() === '',
    selection: selection,
    lines: text === '' ? 1 : text.split('\n').length,
    singleLine: el.tagName === 'INPUT',
    firstLineSpan: { left: span.left + ox, right: span.right + ox, top: span.top + oy, bottom: span.bottom + oy },
    visualLines: Math.ceil(el.scrollHeight / lineHeight),
    scrollTop: el.scrollTop,
    firstLine: { x: firstLine.x + ox, y: firstLine.y + oy }
  };
}"""


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
        self._os = os
        if os is not None:
            driver.os = os
        self._driver = driver
        self._seed = (seed if seed is not None else generate_random_seed()) & 0xFFFFFFFF
        self._rng = make_rng(self._seed)
        # An explicit ``settings`` override always wins (back-compat). Otherwise,
        # if the caller supplied a seed, derive a stable behavioral profile from
        # it so the same seed yields the same "personality"; with neither, use
        # defaults.
        if settings is not None:
            self._settings = resolve_settings(settings)
        elif seed is not None:
            self._settings = profile_from_seed(self._seed)
        else:
            self._settings = resolve_settings(None)
        self._settings.scroll.wheel.style = wheel_style_for(os, settings)
        self._defaults = defaults or {}
        # Opt-in keyboard select-all for clear_existing. Off by default: the
        # modifier reveals the real OS (pages read ctrlKey/metaKey, and browsers
        # only honor the host OS's one), so fields are cleared by triple-click.
        self._select_all_modifier = select_all_modifier
        self._previous = start or get_better_starting_position(dimensions, self._rng)
        # The browser's pointer is at _previous (until the first move it is only a guess).
        self._placed = False
        # time.monotonic() of the last mouse move, for the pause before a press.
        self._last_move_at = 0.0
        self._is_moving = False
        self._performing_random_moves = False
        self._random_move_task: Optional[asyncio.Task] = None
        self._disposed = False
        self._scroll_multiplier: Optional[float] = None

        self._typer = HumanTyper(
            _DriverTyperInput(driver),
            wpm=self._settings.typing.wpm,
            mistake_multiplier=self._settings.typing.mistake_multiplier,
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
    async def _clicks(self, button: str, first: int, last: int, hold_ms: Optional[float] = None) -> None:
        """Clicks ``first``..``last`` of a multi-click where the cursor is,
        timed like a person (see ``motion/click_model.py``): click 1 waits a
        drawn beat after the last move, and each button is held a drawn time.
        Drivers written before ``click_count``/``hold_ms`` get what they take;
        one without ``click_count`` makes plain clicks, so clearing a field
        then reports it as not cleared.
        """
        lead_ms, presses = clicks_with(self._rng, first, last)
        await _delay(self._last_move_at * 1000.0 + lead_ms - time.monotonic() * 1000.0 if first == 1 else lead_ms)
        click = self._driver.click
        for i, (down, up) in enumerate(presses):
            if i > 0:
                await _delay(down - presses[i - 1][1])
            hold = up - down if hold_ms is None else hold_ms
            if _accepts_positional(click, 3):
                await click(button, first + i, hold)
            elif _accepts_positional(click, 2):
                await click(button, first + i)
            else:
                await click(button)

    async def _move_along(self, destination: Vector, options, allow_overshoot: bool) -> None:
        vp = await viewport_of(self._driver)

        def settle(p: Vector) -> Vector:
            clamped = clamp_to_browser_bounds(p.x, p.y, vp)
            return Vector(round(clamped.x), round(clamped.y))

        points = move_with(
            self._previous,
            destination,
            self._rng,
            move_speed=_pick(options, "move_speed", None),
            overshoot=allow_overshoot,
            settings=self._settings.overshoot,
            settle=settle,
        )
        await self._trace_path(points, settle)

    async def _trace_path(self, points: List[PlannedPoint], settle) -> None:
        # An absolute schedule, so timer overshoot doesn't accumulate.
        start = time.monotonic() * 1000.0
        for p in points:
            if self._driver.is_closed():
                return
            await _delay(start + p.t - time.monotonic() * 1000.0)
            pos = settle(p)
            # Only macOS reports a mouse that has not left its pixel; elsewhere it sends nothing.
            if self._placed and self._os != "macos" and pos == self._previous:
                continue
            await self._driver.move(pos.x, pos.y)
            self._previous = pos
            self._placed = True
            self._last_move_at = time.monotonic()

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

        for attempt in range(max_tries):
            if self._driver.is_closed():
                return
            remaining_ms = wait_ms if deadline is None else (deadline - time.monotonic()) * 1000.0
            if remaining_ms <= 0:
                break
            found = await wait_for_element(self._driver, selector, "visible", min(wait_ms, remaining_ms))
            if not found:
                last_error = RuntimeError(f"myuri: element not found or not visible: {selector}")
                continue

            # The mouse can only travel within the visible viewport, so a target
            # outside it must be scrolled in first — via the stealthy wheel
            # model, never an instant scrollIntoView. Loop over fresh plans: the
            # wheel multiplier calibrates on the first pass, and each pass may
            # escalate to an outer scroller once an inner one is exhausted.
            scroll_opts = ScrollOptions(
                finish_position=self._settings.scroll.finish_position,
                speed_factor=self._settings.scroll.speed_factor,
            )
            finish_position = scroll_opts.finish_position or 0.5
            plan = await self._compute_scroll_plan(selector, finish_position)
            for _ in range(3):
                if not plan or plan["inView"] or abs(plan["deltaY"]) < 1:
                    break
                await self._perform_scroll(plan, scroll_opts)
                plan = await self._compute_scroll_plan(selector, finish_position)
            if not plan:
                last_error = RuntimeError(f"myuri: element has no box: {selector}")
                continue
            # No usable on-screen region even after scrolling: fail the attempt
            # WITHOUT moving. Walking toward a clamped point at the viewport
            # edge reads as robotic and can never land anyway.
            if not plan.get("region"):
                last_error = RuntimeError(
                    f"myuri: could not bring {selector} into view (off-screen or covered by a pinned overlay)"
                )
                continue
            region = plan["region"]
            # Sample from the on-screen clip of the target, so a partially
            # covered or partially scrolled-in element is clicked on its
            # visible part.
            box = BoundingBox(
                x=region["x"], y=region["y"], width=region["width"], height=region["height"]
            )
            exclude_boxes = await self._resolve_exclude_boxes(_pick(options, "exclude_selectors", None))
            # Widen the retry sample slightly each attempt to escape a repeated miss.
            attempt_opts = options
            if attempt > 0:
                narrowed = max(
                    0.0,
                    _pick(options, "width_padding_percentage", 25)
                    - self._settings.correction.retry_spread * attempt,
                )
                attempt_opts = (
                    replace(options, width_padding_percentage=narrowed)
                    if options is not None
                    else MoveOptions(width_padding_percentage=narrowed)
                )
            destination = get_random_box_point(box, attempt_opts, self._previous, exclude_boxes, self._rng)
            await self._move_along(destination, options, should_overshoot(self._previous, destination, overshoot_threshold))
            final_box = await bounding_box_of(self._driver, selector)
            if final_box and _point_in_box(self._previous, final_box) and await point_hits_target(self._driver, self._previous, selector):
                return
            last_error = RuntimeError(f"myuri: cursor did not land on {selector}")
        if last_error:
            raise last_error

    async def drag(self, from_: Union[str, Vector], to: Union[str, Vector], options: Optional[DragOptions] = None) -> None:
        """Press on ``from_``, move to ``to`` with the button held, and release.

        Timed like recorded people (see ``motion/click_model.py``). Each end is a
        selector (a point inside the element is chosen, as for :meth:`click`)
        or a viewport :class:`Vector`. ``to`` is measured after the press, so a
        drop zone that appears once a drag starts works. Needs a driver with
        ``mouse_down``/``mouse_up`` (the built-in drivers have them).
        """
        opts = options if options is not None else DragOptions()
        button = _pick(options, "button", "left")
        was_random = self._start_action()
        try:
            if isinstance(from_, str):
                await self._move_to_element(from_, opts)
            else:
                await self._move_along(from_, opts, False)
            await _delay(self._last_move_at * 1000.0 + pre_click_dwell_ms(self._rng) - time.monotonic() * 1000.0)
            await self._driver.mouse_down(button)
            released = False
            try:
                await _delay(drag_start_ms(self._rng))
                if isinstance(to, str):
                    box = await bounding_box_of(self._driver, to)
                    if not box:
                        raise RuntimeError(f"myuri: drag target not found or not visible: {to}")
                    target = get_random_box_point(box, opts, self._previous, [], self._rng)
                else:
                    target = to
                # Carrying something, people move slower and steer straight to the drop: no overshoot.
                carry = dataclasses.replace(opts, move_speed=(_pick(opts, "move_speed", 1) or 1) * drag_carry_speed(self._rng))
                await self._move_along(target, carry, False)
                await _delay(self._last_move_at * 1000.0 + drag_end_ms(self._rng) - time.monotonic() * 1000.0)
                released = True
                await self._driver.mouse_up(button)
            finally:
                if not released:
                    try:
                        await self._driver.mouse_up(button)
                    except Exception:
                        pass
            await _delay(_pick(options, "wait_for_release", 50))
        finally:
            await self._end_action(was_random, 0, False)

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
            count = max(1, min(3, round(_pick(options, "click_count", 1) or 1)))
            await self._clicks(button, 1, count, _pick(options, "hold_ms", None))
            await _delay(max(_pick(options, "wait_for_click", 50), 15))
        finally:
            await self._end_action(was_random, _pick(options, "move_delay", 0), _pick(options, "randomize_move_delay", True))

    # ---- typing ----
    async def _clear_focused_field(self, focus_clicked: bool) -> None:
        """Empty the focused field, by default without sending a modifier key.

        Triple-click selects a single-line field outright; multi-line content is
        triple-clicked on its first paragraph and extended with Shift+ArrowDown
        (the same keys on every OS). ``focus_clicked`` means the click that
        focused the field just happened at the cursor, so it counts as click 1.
        """
        field = await self._driver.evaluate(_FOCUSED_FIELD_JS, None)
        if not field:
            raise RuntimeError("myuri: clear_existing needs a focused field (pass a selector)")
        if field["empty"]:
            return
        if self._select_all_modifier:
            await self._typer.delete_all(0, self._select_all_modifier)
        else:
            box = BoundingBox(**field["box"])
            if not _point_in_box(self._previous, box):
                await self._move_along(get_random_box_point(box, None, self._previous, [], self._rng), None, False)
                focus_clicked = False
            first_click = 2 if focus_clicked else 1
            # One line in a textarea or editor needs this too unless the cursor
            # is already on the text: Firefox selects nothing when the clicks
            # land in the blank space after it.
            span = field.get("firstLineSpan")
            on_first_line = span is None or (
                span["left"] <= self._previous.x <= span["right"] - 2 and span["top"] <= self._previous.y <= span["bottom"]
            )
            if field["lines"] > 1 or (field.get("singleLine") is False and not on_first_line):
                # Triple-click selects one paragraph, so start on the first one:
                # wheel the field back to its top if needed, then click there.
                for _ in range(30):
                    if field["scrollTop"] <= 0:
                        break
                    await self._driver.wheel(0, -min(field["scrollTop"], 80 + self._rng() * 80))
                    await _delay(30 + self._rng() * 40)
                    field = await self._driver.evaluate(_FOCUSED_FIELD_JS, None) or field
                first = field["firstLine"]
                await self._move_along(Vector(first["x"] + self._rng() * 12, first["y"] + (self._rng() - 0.5) * 3), None, False)
                first_click = 1
            await self._clicks("left", first_click, 3)
            if field["lines"] > 1:
                await _delay(120 + self._rng() * 120)
                await self._driver.down("Shift")
                for _ in range(max(field["lines"], field["visualLines"]) + 2):
                    current = await self._driver.evaluate(_FOCUSED_FIELD_JS, None)
                    if not current or current["selection"] != "partial":
                        break
                    await self._driver.press("ArrowDown")
                    await _delay(40 + self._rng() * 60)
                await self._driver.up("Shift")
            await _delay(60 + self._rng() * 90)
            await self._typer.delete_all(1)
        after = await self._driver.evaluate(_FOCUSED_FIELD_JS, None)
        if not (after and after["empty"]):
            raise RuntimeError("myuri: clear_existing could not empty the focused field")

    async def type(self, text: str, selector: Optional[str] = None, options: Optional[TypeOptions] = None) -> None:
        was_random = self._start_action()
        try:
            if selector is not None:
                await self.click(selector, ClickOptions(wait_for_click=30, wait_for_selector=_pick(options, "wait_for_selector", 10000), max_tries=_pick(options, "max_tries", 3)))
            if _pick(options, "clear_existing", False):
                await self._clear_focused_field(selector is not None)
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
            finish_position = _pick(options, "finish_position", self._settings.scroll.finish_position)
            plan = await self._compute_scroll_plan(selector, finish_position)
            for _ in range(_pick(options, "max_tries", 3)):
                if not plan or plan["inView"] or abs(plan["deltaY"]) < 1:
                    break
                await self._perform_scroll(plan, options)
                plan = await self._compute_scroll_plan(selector, finish_position)
        finally:
            await self._end_action(was_random, 0, False)

    async def _compute_scroll_plan(self, selector: str, finish_position: float) -> Optional[dict]:
        """One planning pass; see ``scroll_plan.py`` for what it computes."""
        return await self._driver.evaluate(
            SCROLL_PLAN_FOR_SELECTOR,
            {
                "selector": selector,
                "finishPosition": finish_position,
                "pad": SCROLL_PAD,
                "edge": SCROLL_EDGE,
                "fromX": self._previous.x,
                "fromY": self._previous.y,
            },
        )

    async def _perform_scroll(self, plan: dict, options) -> None:
        """Execute one planned pass: hover over the chosen scroller, wheel the delta."""
        wanted = plan["deltaY"] * (self._scroll_multiplier or 1)
        if abs(wanted) < 1:
            return
        # Hover over the chosen scroller so the wheel scrolls IT, not the page.
        await self._move_along(
            Vector(plan["hoverX"], plan["hoverY"]),
            MoveToOptions(move_delay=0, randomize_move_delay=False),
            False,
        )
        # Calibration reads window scroll, so only calibrate off page scrolls
        # (the wheel→px DPR ratio is identical for containers).
        pre = (await scroll_metrics_of(self._driver)).offset if plan["isPage"] else None
        realism = _pick(options, "realism", None)
        speed_irregularity = getattr(realism, "speed_irregularity", None) if realism else None
        if speed_irregularity is None:
            speed_irregularity = self._settings.scroll.realism.speed_irregularity
        spec = WheelSpec(self._settings.scroll.device, self._settings.scroll.wheel, speed_irregularity)
        # A wheel moves in whole notches, so calibrate against the planned total.
        events, end, dispatched = wheel_with(wanted, self._rng, spec)
        sf = _pick(options, "speed_factor", self._settings.scroll.speed_factor)

        # Emit the gesture on the model's clock, like an input device: never wait
        # for the page to acknowledge an event before sending the next. A browser
        # acknowledges a wheel event only on its next frame (~16.7 ms at 60 Hz),
        # so awaiting each one stretched gestures planned at ~8 ms cadence to
        # 1.25-1.6x their intended duration. Events queued in the browser
        # meanwhile are handled natively (Chromium coalesces them; Firefox
        # delivers each), as they would be from real hardware. Tasks start in
        # creation order and every driver sends over a single connection, so
        # they arrive in order.
        sent: List[asyncio.Future] = []

        def failed() -> bool:  # e.g. the page closed mid-gesture
            return any(s.done() and not s.cancelled() and s.exception() for s in sent)

        start = time.monotonic() * 1000.0
        for at, delta in events:
            # An absolute schedule, so timer overshoot doesn't accumulate.
            await _delay(start + at / sf - time.monotonic() * 1000.0)
            if failed():
                break
            sent.append(asyncio.ensure_future(self._driver.wheel(0, delta)))
        await _delay(start + end / sf - time.monotonic() * 1000.0)
        # Everything must have landed (or failed) before measuring where the
        # scroll ended; re-raise the first failure, having retrieved them all.
        results = await asyncio.gather(*sent, return_exceptions=True)
        errors = [r for r in results if isinstance(r, BaseException)]
        if errors:
            raise errors[0]

        if pre is not None:
            post = await self._settle_scroll(pre)
            actual = post - pre
            if self._scroll_multiplier is None and abs(dispatched) > 10 and abs(actual) > 10:
                # Clamp: a first scroll truncated by maxScroll (or partially
                # consumed by an inner scroller) would otherwise poison every
                # subsequent scroll with a wildly inflated multiplier.
                self._scroll_multiplier = min(3.0, max(0.3, round((dispatched / actual) * 100) / 100))
        else:
            await _delay(120)  # let the container settle (window-scroll settle doesn't apply)

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
        self._placed = True

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
    """Create a :class:`Cursor`. Pass a driver (e.g. ``from_playwright(page)``), a
    raw Playwright page (driver inferred), or a :class:`Driver` instance."""
    driver = page_or_driver if isinstance(page_or_driver, Driver) else driver_from_page(page_or_driver)
    return Cursor(driver, **options)
