"""The Cursor: a human-like cursor bound to a :class:`Driver` (mirror of
``js/src/cursor.ts``)."""
from __future__ import annotations

import asyncio
import time
from dataclasses import replace
from typing import Any, Optional

from .drivers.base import Driver, _accepts_positional, define_driver  # noqa: F401 (re-exported convenience)
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
    _RESOLVER,
    bounding_box_of,
    point_hits_target,
    scroll_metrics_of,
    viewport_of,
    wait_for_element,
)
from .profile import profile_from_seed
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
      break;
    }
  }
  return {
    box: { x: r.x + ox, y: r.y + oy, width: r.width, height: r.height },
    empty: text.trim() === '',
    selection: selection,
    lines: text === '' ? 1 : text.split('\n').length,
    visualLines: Math.ceil(el.scrollHeight / lineHeight),
    scrollTop: el.scrollTop,
    firstLine: { x: firstLine.x + ox, y: firstLine.y + oy }
  };
}"""


# Container-aware scroll plan (mirror of ``computeScrollPlan`` in js/src/cursor.ts;
# see that function for the full design commentary). One pass computes:
#   - the CLEAR BAND: viewport minus pinned (fixed/sticky) bars, probed at the
#     target's column;
#   - the CHOSEN SCROLLER: innermost scrollable ancestor that can actually move
#     the target toward finishPosition inside its visible band, escalating
#     outward past exhausted scrollers; a position:fixed ancestor drops the page
#     step entirely (window scroll cannot move anything inside it);
#   - the CLICK REGION: the target's on-screen clip, with occlusion judged
#     across the region rather than the center point;
#   - the HOVER point: nearest point from which a wheel reaches the chosen
#     scroller, modeling Chromium's routing (a wrapper at its scroll limit in
#     the wheel's direction bubbles the wheel up, so it is not a trap), with
#     equal-distance probes breaking toward the roomier gutter.
_SCROLL_PLAN_JS = (
    "(arg) => {" + _RESOLVER + """
  var el = resolve(arg.selector);
  if (!el) return null;
  function stepUp(node){
    if (node.parentElement) return node.parentElement;
    var r = node.getRootNode ? node.getRootNode() : null;
    return r && r.host ? r.host : null;
  }
  var vh = window.innerHeight || document.documentElement.clientHeight;
  var vw = window.innerWidth || document.documentElement.clientWidth;
  var elRect = el.getBoundingClientRect();

  var chain = [];
  var pageCanMoveTarget = true;
  var cur = stepUp(el);
  var depth = 0;
  while (cur && depth < 60 && cur !== document.documentElement) {
    var st = getComputedStyle(cur);
    var scrollable = cur.scrollHeight > cur.clientHeight + 1 &&
      (st.overflowY === 'scroll' || st.overflowY === 'auto');
    if (cur === document.body) {
      if (scrollable && !(document.documentElement.scrollHeight > vh + 10)) chain.push(cur);
      break;
    }
    if (scrollable) chain.push(cur);
    if (st.position === 'fixed') { pageCanMoveTarget = false; break; }
    cur = stepUp(cur);
    depth++;
  }

  function pinnedRectAt(x, y) {
    var hit = document.elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
    var n = hit;
    while (n && n !== document.body && n !== document.documentElement) {
      var pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return n.contains(el) ? null : n.getBoundingClientRect();
      n = stepUp(n);
    }
    return null;
  }

  var clearTop = arg.pad;
  var clearBottom = vh - arg.pad;
  var probeX = Math.min(Math.max(elRect.left + elRect.width / 2, 5), vw - 5);
  var i, r;
  for (i = 0; i < 4; i++) {
    r = pinnedRectAt(probeX, clearTop + 1);
    if (r && r.bottom > clearTop) clearTop = Math.min(r.bottom + 2, vh); else break;
  }
  for (i = 0; i < 4; i++) {
    r = pinnedRectAt(probeX, clearBottom - 1);
    if (r && r.top < clearBottom) clearBottom = Math.max(r.top - 2, 0); else break;
  }
  if (clearBottom - clearTop < 40) { clearTop = arg.pad; clearBottom = vh - arg.pad; }

  var clipTop = clearTop, clipBottom = clearBottom, clipLeft = arg.edge, clipRight = vw - arg.edge;
  var cr;
  for (i = 0; i < chain.length; i++) {
    cr = chain[i].getBoundingClientRect();
    clipTop = Math.max(clipTop, cr.top); clipBottom = Math.min(clipBottom, cr.bottom);
    clipLeft = Math.max(clipLeft, cr.left); clipRight = Math.min(clipRight, cr.right);
  }
  var regionLeft = Math.max(elRect.left, clipLeft);
  var regionTop = Math.max(elRect.top, clipTop);
  var regionRight = Math.min(elRect.right, clipRight);
  var regionBottom = Math.min(elRect.bottom, clipBottom);
  var region = (regionRight - regionLeft >= 6 && regionBottom - regionTop >= 6)
    ? { x: regionLeft, y: regionTop, width: regionRight - regionLeft, height: regionBottom - regionTop }
    : null;

  var occluded = false;
  if (region) {
    var ccx = region.x + region.width / 2, ccy = region.y + region.height / 2;
    var samples = [
      [ccx, ccy],
      [ccx - region.width * 0.3, ccy], [ccx + region.width * 0.3, ccy],
      [ccx, ccy - region.height * 0.3], [ccx, ccy + region.height * 0.3]
    ];
    for (i = 0; i < samples.length; i++) {
      if (pinnedRectAt(Math.round(samples[i][0]), Math.round(samples[i][1])) != null) { occluded = true; break; }
    }
  }

  var bandHeight = clipBottom - clipTop;
  var fullyVisible = elRect.top >= clipTop && elRect.bottom <= clipBottom;
  var tallTarget = elRect.height > bandHeight - 4;
  var inView = region != null && !occluded &&
    (fullyVisible || (tallTarget && region.height >= bandHeight * 0.6));

  var chosen = null, chosenDelta = 0, chosenIsPage = false;
  var hoverTop = clearTop, hoverBottom = clearBottom, hoverLeft = 5, hoverRight = vw - 5;
  var steps = chain.length + (pageCanMoveTarget ? 1 : 0);
  for (i = 0; i < steps; i++) {
    var isPageStep = i === chain.length;
    var node = isPageStep ? document.documentElement : chain[i];
    var bTop = clearTop, bBottom = clearBottom, bLeft = 5, bRight = vw - 5;
    if (!isPageStep) {
      var nr = node.getBoundingClientRect();
      bTop = Math.max(bTop, nr.top); bBottom = Math.min(bBottom, nr.bottom);
      bLeft = Math.max(bLeft, nr.left); bRight = Math.min(bRight, nr.right);
      for (var j = i + 1; j < chain.length; j++) {
        var outer = chain[j].getBoundingClientRect();
        bTop = Math.max(bTop, outer.top); bBottom = Math.min(bBottom, outer.bottom);
        bLeft = Math.max(bLeft, outer.left); bRight = Math.min(bRight, outer.right);
      }
    }
    var bH = bBottom - bTop;
    if (bH < Math.min(elRect.height, 24) + 6) continue;
    var desiredTop = bTop + Math.max(0, bH - elRect.height) * arg.finishPosition;
    var current = isPageStep ? window.scrollY : node.scrollTop;
    var maxScroll = isPageStep
      ? Math.max(0, document.documentElement.scrollHeight - vh)
      : Math.max(0, node.scrollHeight - node.clientHeight);
    var target = Math.max(0, Math.min(current + (elRect.top - desiredTop), maxScroll));
    var delta = target - current;
    if (Math.abs(delta) >= 1) {
      chosen = node; chosenDelta = delta; chosenIsPage = isPageStep;
      hoverTop = bTop; hoverBottom = bBottom; hoverLeft = bLeft; hoverRight = bRight;
      break;
    }
  }

  function clampHX(x){ return Math.min(Math.max(x, Math.max(hoverLeft + 5, 5)), Math.min(hoverRight - 5, vw - 5)); }
  function clampHY(y){ return Math.min(Math.max(y, Math.max(hoverTop + 5, 5)), Math.min(hoverBottom - 5, vh - 5)); }
  function consumesWheel(n){
    var st = getComputedStyle(n);
    if (st.overflowY !== 'auto' && st.overflowY !== 'scroll') return false;
    if (n.scrollHeight <= n.clientHeight + 1) return false;
    return chosenDelta > 0
      ? n.scrollTop + n.clientHeight < n.scrollHeight - 1
      : n.scrollTop > 1;
  }
  function wheelReaches(x, y){
    var hit = document.elementFromPoint(x, y);
    if (!hit) return chosenIsPage;
    var n = hit;
    while (n && n !== document.documentElement && n !== document.body) {
      if (!chosenIsPage && n === chosen) return true;
      if (consumesWheel(n)) return false;
      n = stepUp(n);
    }
    return chosenIsPage;
  }
  var hoverX = clampHX(arg.fromX);
  var hoverY = clampHY(arg.fromY);
  if (chosen) {
    var roomLeft = arg.fromX - Math.max(hoverLeft + 5, 5);
    var roomRight = Math.min(hoverRight - 5, vw - 5) - arg.fromX;
    var lateral = roomRight > roomLeft
      ? [0, 60, -60, 120, -120, 200, -200]
      : [0, -60, 60, -120, 120, -200, 200];
    var dys = [0, -40, 40, -90, 90];
    var baseY = hoverY;
    var found = false;
    for (var a = 0; a < dys.length && !found; a++) {
      var y = clampHY(baseY + dys[a]);
      for (var b = 0; b < lateral.length; b++) {
        var x = clampHX(arg.fromX + lateral[b]);
        if (wheelReaches(x, y)) { hoverX = x; hoverY = y; found = true; break; }
      }
    }
  }
  return { inView: inView, deltaY: chosenDelta, hoverX: hoverX, hoverY: hoverY, isPage: chosenIsPage, region: region };
}"""
)


def _pick(opt: Any, name: str, default: Any) -> Any:
    value = getattr(opt, name, None) if opt is not None else None
    return default if value is None else value


class _DriverTyperInput:
    """Adapts a Driver's key methods to the typer's input protocol."""

    def __init__(self, driver: Driver) -> None:
        self._d = driver

    async def press(self, key: str, delay: Optional[float] = None) -> None:
        # Playwright press() only knows named keys + US-layout printables; other
        # single code points (an AZERTY 'é' typo slip, emoji) throw "Unknown key"
        # and abort typing mid-field — insert those as text instead.
        if len(key) == 1 and not (0x20 <= ord(key) <= 0x7E):
            await self._d.insert_text(key)
        else:
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
        select_all_modifier: Optional[str] = None,
    ) -> None:
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
        self._defaults = defaults or {}
        # Opt-in keyboard select-all for clear_existing. Off by default: the
        # modifier reveals the real OS (pages read ctrlKey/metaKey, and browsers
        # only honor the host OS's one), so fields are cleared by triple-click.
        self._select_all_modifier = select_all_modifier
        self._previous = start or get_better_starting_position(dimensions, self._rng)
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
            if field["lines"] > 1:
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
            # Drivers written before click_count get plain clicks; the check
            # below then reports the field as not cleared.
            multi_click = _accepts_positional(self._driver.click, 2)
            for click_count in range(first_click, 4):
                if click_count > 1:
                    await _delay(70 + self._rng() * 90)
                await (self._driver.click("left", click_count) if multi_click else self._driver.click("left"))
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
        """One planning pass; see ``_SCROLL_PLAN_JS`` for what it computes."""
        pad = max(20, VIEWPORT_PADDING + 5)
        return await self._driver.evaluate(
            _SCROLL_PLAN_JS,
            {
                "selector": selector,
                "finishPosition": finish_position,
                "pad": pad,
                "edge": VIEWPORT_PADDING,
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

        if pre is not None:
            post = await self._settle_scroll(pre)
            actual = post - pre
            if self._scroll_multiplier is None and abs(wanted) > 10 and abs(actual) > 10:
                # Clamp: a first scroll truncated by maxScroll (or partially
                # consumed by an inner scroller) would otherwise poison every
                # subsequent scroll with a wildly inflated multiplier.
                self._scroll_multiplier = min(3.0, max(0.3, round((wanted / actual) * 100) / 100))
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
