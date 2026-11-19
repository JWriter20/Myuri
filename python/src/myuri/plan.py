"""Pure planners: the timelines a Cursor plays, without a browser.

Python mirror of ``js/src/plan.ts`` (the same planners and draws: a seed plans
the same in both languages). Each planner takes the random stream as ``rng``,
a zero-argument callable returning a float in ``[0, 1)`` (``make_rng(seed)``
gives the Mulberry32 stream a Cursor uses). Times are milliseconds from the
start of the plan, non-decreasing and unrounded. The Cursor builds its actions
from these same functions, so a planner's output is exactly what a Cursor with
the same stream would do.

Every planner takes ``os``, the OS the browser claims. It changes the shortcut
modifier and the wheel (see ``target_os.py``), not a person's timing: the
other planners only check it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

from .geometry import PlannedPoint, get_random_box_point, should_overshoot, trajectory
from .motion.click_model import click_hold_ms, multi_click_gap_ms, pre_click_dwell_ms
from .motion.scroll_model import scroll_model
from .motion.wheel_model import generate_wheel_path
from .options import PathOptions
from .target_os import check_os, primary_modifier
from .rng import Rng, gaussian
from .settings import OvershootSettings, TypingPauses, WheelSettings, resolve_settings
from .types import BoundingBox, Vector, overshoot as overshoot_point, point_in_box
from .typing_engine.config import DEFAULT_WPM
from .typing_engine.timing import KeyAction, KeystrokeTiming, needs_shift
from .typing_engine.typer import draw_session_wpm, plan_typing

# ---- moves -------------------------------------------------------------------


def move_with(
    start: Vector,
    end: Vector,
    rng: Rng,
    *,
    move_speed: Optional[float],
    overshoot: bool,
    settings: OvershootSettings,
    settle: Callable[[Vector], Vector],
) -> List[PlannedPoint]:
    """A move as the Cursor plays it. ``settle`` maps a point to where the
    pointer actually ends up (the Cursor clamps and rounds), which is where the
    correction after an overshoot starts."""
    if not overshoot:
        return trajectory(start, end, PathOptions(move_speed=move_speed), rng)
    out = trajectory(start, overshoot_point(end, settings.radius, rng), PathOptions(move_speed=move_speed), rng)
    last = out[-1]
    dwell = settings.dwell
    resume = last.t + dwell.min_ms + rng() * max(0, dwell.max_ms - dwell.min_ms)
    correction_speed = (move_speed if move_speed is not None else 1) * settings.correction_speed_factor
    back = trajectory(settle(Vector(last.x, last.y)), end, PathOptions(move_speed=correction_speed), rng)
    return out + [p._replace(t=resume + p.t) for p in back]


def plan_move(
    start: Vector,
    end: Vector,
    rng: Rng,
    *,
    os: Optional[str] = None,
    move_speed: Optional[float] = None,
    overshoot: Optional[bool] = None,
    settings: Optional[Dict[str, Any]] = None,
) -> List[PlannedPoint]:
    """A human-like move from ``start`` to ``end`` as ``(x, y, t)`` points; the
    last is exactly ``end``. A move is planned the same on every ``os``; off
    macOS, a Cursor skips a point on the pixel it already sent. ``overshoot``
    (past ``end`` and back) defaults to whether the move is longer than
    ``settings.overshoot.threshold``."""
    check_os(os)
    s = resolve_settings(settings)
    o = s.overshoot
    if overshoot is None:
        overshoot = should_overshoot(start, end, o.threshold)
    if move_speed is None:
        move_speed = s.mouse.speed_factor
    return move_with(start, end, rng, move_speed=move_speed, overshoot=overshoot, settings=o, settle=lambda p: p)


def plan_point(box: BoundingBox, rng: Rng, *, start: Optional[Vector] = None) -> Vector:
    """Where in ``box`` a person clicks: centre-biased, inside the box's middle
    (half the width of a small target, three quarters of a large one, 30% of
    the height), and with ``start``, nearer to where the pointer comes from.
    Integer pixels. A pointer already on the box presses where it is: ``start``."""
    if start is not None and point_in_box(start, box):
        return start
    return get_random_box_point(box, None, start, None, rng)


# ---- clicks ------------------------------------------------------------------


def clicks_with(rng: Rng, first: int, last: int) -> Tuple[float, List[Tuple[float, float]]]:
    """Clicks ``first``..``last`` of a multi-click as ``(lead_ms, presses)``.
    ``lead_ms`` comes before the first press: the dwell after the last move for
    click 1, the gap since the previous release otherwise."""
    lead_ms: float = pre_click_dwell_ms(rng) if first == 1 else 0
    presses: List[Tuple[float, float]] = []
    at: float = 0
    for count in range(first, last + 1):
        if count > 1:
            gap = multi_click_gap_ms(rng)
            if count == first:
                lead_ms = gap
            else:
                at += gap
        up = at + click_hold_ms(rng, count > 1)
        presses.append((at, up))
        at = up
    return lead_ms, presses


CLICK_RUN_MS = 500
"""The OS counts a press within this long of the last one, in place, into the
same run (Windows' and macOS's double-click time)."""


def plan_click(
    rng: Rng, *, os: Optional[str] = None, click_count: int = 1, since_release_ms: Optional[float] = None
) -> Dict[str, Any]:
    """A click, double click (``click_count`` 2) or triple click (3):
    ``{"dwell_ms": last move -> first press, "presses": [(down, up), ...]}``,
    press times from the first press's down (0).

    ``since_release_ms``: when the pointer has not moved since the last press
    was released, how long ago that was. Within :data:`CLICK_RUN_MS` the click
    continues that run, as rapid clicks in place do: ``dwell_ms`` runs from now
    to a run's gap after the release, and the presses are held as a run's later
    ones. Past it, the hand is already resting on the target and presses at
    once."""
    check_os(os)
    if since_release_ms is not None and since_release_ms < CLICK_RUN_MS:
        lead_ms, presses = clicks_with(rng, 2, click_count + 1)
        return {"dwell_ms": max(0, lead_ms - since_release_ms), "presses": presses}
    lead_ms, presses = clicks_with(rng, 1, click_count)
    return {"dwell_ms": lead_ms if since_release_ms is None else 0, "presses": presses}


# ---- keys --------------------------------------------------------------------

KeyStep = Tuple[float, str, str]
"""A key event ``(t, type, key)``: press ('down'), release ('up'), or insert
text no US key types ('insert')."""


def _steps(actions: List[KeyAction]) -> List[KeyStep]:
    return [(a.at, a.type, a.key) for a in actions]


def _session(rng: Rng, os: Optional[str], wpm: Optional[float], pauses: Optional[TypingPauses]) -> KeystrokeTiming:
    check_os(os)
    return KeystrokeTiming(draw_session_wpm(rng, DEFAULT_WPM if wpm is None else wpm), rng, pauses)


def plan_type(
    text: str,
    rng: Rng,
    *,
    os: Optional[str] = None,
    wpm: Optional[float] = None,
    mistake_multiplier: Optional[float] = None,
    pauses: Optional[TypingPauses] = None,
) -> List[KeyStep]:
    """Typing ``text``, with the typos and corrections a person makes, around
    ``wpm`` words per minute (``pauses``: see ``settings.typing.pauses``). Keys
    are Playwright key names; Shift is pressed and released as its own key."""
    timing = _session(rng, os, wpm, pauses)
    _, actions, _ = plan_typing(text, 1 if mistake_multiplier is None else mistake_multiplier, rng, timing)
    return _steps(actions)


def plan_press(
    key: str, rng: Rng, *, os: Optional[str] = None, wpm: Optional[float] = None, pauses: Optional[TypingPauses] = None
) -> List[KeyStep]:
    """One key or chord in Playwright's notation ('Enter', 'Control+a',
    'Meta+Shift+z', 'A'). A key that needs Shift gets it."""
    parts = key.split("+")
    # A trailing '+' is the '+' key ('Control++').
    main = "+" if key.endswith("+") else parts.pop()
    modifiers = parts[:-2] if key.endswith("+") else parts
    if needs_shift(main) and "Shift" not in modifiers:
        modifiers.append("Shift")
    return _steps(_session(rng, os, wpm, pauses).plan_chord(modifiers, main))


def plan_select_all(rng: Rng, *, os: str, wpm: Optional[float] = None) -> List[KeyStep]:
    """Select-all on ``os``: Cmd+A on macOS, Ctrl+A elsewhere."""
    return plan_press(f"{primary_modifier(os)}+a", rng, os=os, wpm=wpm)


# ---- wheel -------------------------------------------------------------------


@dataclass
class WheelSpec:
    """How a wheel gesture is drawn, resolved."""

    device: str
    wheel: WheelSettings
    speed_irregularity: float
    # Divides every time in the scroll (see ``settings.scroll.speed_factor``).
    speed_factor: float


# Chromium ignores very small wheel deltas, so a trackpad's are sent in batches of at least this many px.
_MIN_TRACKPAD_DELTA = 8


def wheel_with(distance: float, rng: Rng, spec: WheelSpec) -> Tuple[List[Tuple[float, float]], float, float]:
    """One wheel gesture of ``distance`` px as ``(events, end, total)``: events
    are ``(at ms, delta px)``, notches for a mouse, a stream of small deltas for
    a trackpad. ``total`` is the distance the model planned."""
    mouse = spec.device == "mouse"
    if mouse:
        model = generate_wheel_path(distance, rng, spec.wheel.style, spec.wheel.px_per_notch, spec.wheel.px_per_line)
    else:
        model = scroll_model.generate_scroll_path(distance, rng, None, spec.speed_irregularity)
    raw: List[Tuple[float, float]] = []
    end = 0.0
    total = 0.0
    for ev in model:
        total += ev.delta_y
        raw.append((end, ev.delta_y))
        end += ev.delta_time / spec.speed_factor
    if mouse:
        return raw, end, total
    events: List[Tuple[float, float]] = []
    accumulator = 0.0
    for at, delta in raw:
        accumulator += delta
        if abs(accumulator) >= _MIN_TRACKPAD_DELTA:
            send = int(accumulator)
            accumulator -= send
            events.append((at, send))
    if abs(round(accumulator)) >= 1:
        events.append((end, round(accumulator)))
    return events, end, total


WheelStep = Tuple[Any, ...]
"""``('wheel', dx, dy, t)`` or ``('key', 'Shift', 'down' | 'up', t)``."""

# Shift held for a horizontal scroll: Shift down -> first wheel event (lead)
# and last wheel event -> Shift up (trail), lognormal (mu, sd) in ms; see
# ``plan.ts`` for the fit.
_SHIFT_WHEEL_LEAD = (7.023, 0.411)
_SHIFT_WHEEL_TRAIL = (7.501, 0.559)


def wheel_style_for(os: Optional[str], settings: Optional[Dict[str, Any]]) -> str:
    """A mouse wheel's style: an explicit setting, else the OS's. macOS turns
    notches into accelerated line scrolls in 20 ms frames ('macos'); Windows
    and Linux send one 100 px event a notch ('notched', the default)."""
    check_os(os)
    wheel = ((settings or {}).get("scroll") or {}).get("wheel") or {}
    return wheel.get("style") or ("macos" if os == "macos" else "notched")


def plan_wheel(
    delta_x: float,
    delta_y: float,
    rng: Rng,
    *,
    os: Optional[str] = None,
    device: Optional[str] = None,
    settings: Optional[Dict[str, Any]] = None,
) -> List[WheelStep]:
    """Scrolling ``delta_y`` px down (negative: up), then ``delta_x`` px right
    (negative: left). The horizontal part is Shift held around wheel events, as
    people scroll sideways with a mouse. On macOS the OS turns them
    horizontal, so the events carry ``dx``; elsewhere Firefox does, so they
    carry the delta in ``dy``. ``device`` defaults to
    ``settings.scroll.device`` ('trackpad')."""
    s = resolve_settings(settings)
    s.scroll.wheel.style = wheel_style_for(os, settings)
    spec = WheelSpec(device or s.scroll.device, s.scroll.wheel, s.scroll.realism.speed_irregularity, s.scroll.speed_factor)
    return wheel_steps(delta_x, delta_y, rng, os=os, spec=spec)


def wheel_steps(delta_x: float, delta_y: float, rng: Rng, *, os: Optional[str], spec: WheelSpec) -> List[WheelStep]:
    """:func:`plan_wheel` with the wheel resolved."""
    out: List[WheelStep] = []
    t = 0.0
    if delta_y != 0:
        events, end, _ = wheel_with(delta_y, rng, spec)
        out += [("wheel", 0, d, at) for at, d in events]
        t = end
    if delta_x != 0:
        out.append(("key", "Shift", "down", t))
        t += math.exp(gaussian(rng, *_SHIFT_WHEEL_LEAD)) / spec.speed_factor
        events, _, _ = wheel_with(delta_x, rng, spec)
        out += [("wheel", d, 0, t + at) if os == "macos" else ("wheel", 0, d, t + at) for at, d in events]
        t = out[-1][3] + math.exp(gaussian(rng, *_SHIFT_WHEEL_TRAIL)) / spec.speed_factor
        out.append(("key", "Shift", "up", t))
    return out


__all__ = [
    "PlannedPoint",
    "KeyStep",
    "WheelStep",
    "plan_move",
    "plan_point",
    "plan_click",
    "plan_type",
    "plan_press",
    "plan_select_all",
    "plan_wheel",
]
