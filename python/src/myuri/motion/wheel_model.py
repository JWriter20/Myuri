"""Mouse-wheel scrolling: the counterpart of the trackpad model in ``scroll_model``.

Python mirror of ``js/src/motion/wheel-model.ts`` (the source of truth; the
draw order is identical, so a seed gives the same wheel in both languages).

A trackpad reports a stream of small pixel deltas. A mouse wheel turns in
notches: the finger flicks the wheel through some notches (a stroke), lifts,
re-grips and flicks again. Two styles:

- ``notched`` (Windows, Linux): one event a notch, each ``px_per_notch``
  (default 100, which Camoufox turns into exactly one 3-line notch). The page
  takes a fast flick's notches one display frame at a time, so the notches that
  land in one 60 Hz frame arrive as one event of 2-4 notches.
- ``macos``: macOS reports the wheel in 20 ms frames and accelerates a fast
  roll. A stroke starts at one line a frame and climbs to ~10, ``px_per_line``
  (default 16) each.

``notched`` is fitted from a notched USB mouse on Windows and ``macos`` from
one on macOS, both in Firefox; see the TypeScript module for the fits.
"""

from __future__ import annotations

import math
from typing import Callable, List

from ..rng import gaussian
from .scroll_model import ScrollEvent

Rng = Callable[[], float]

STROKE_MU = 5.215
STROKE_SD = 0.552
STROKE_MIN_MS = 60
STROKE_MAX_MS = 450
REGRIP_MU = 4.952
REGRIP_SD = 0.563
REGRIP_MIN_MS = 50
REGRIP_MAX_MS = 600
LONE_NOTCH_PROBABILITY = 0.33

NOTCHES_MU = 2.833
NOTCHES_SD = 0.27
FLICK_MU = 5.064
FLICK_SD = 0.18
FLICK_REGRIP_MU = 4.258
FLICK_REGRIP_SD = 0.446
FRAME_MS = 1000 / 60
NOTCH_MAX_MS = 2 * FRAME_MS
NUDGE_MAX_NOTCHES = 7
NUDGE_MU = math.log(2)
NUDGE_SD = 0.54

MAC_FRAME_MS = 20
MAC_DROPPED_FRAME_PROBABILITY = 0.1
MAC_PEAK_MEAN = 10
MAC_PEAK_SD = 1.6
MAC_PEAK_MIN = 6
MAC_PEAK_MAX = 13
MAC_CARRY_MS = 150
MAC_CARRY_DROP_PROBABILITY = 0.45


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


def _sign(x: float) -> int:
    return (x > 0) - (x < 0)


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _lognormal(rng: Rng, mu: float, sd: float) -> float:
    return math.exp(gaussian(rng, mu, sd))


def _notched_path(target: float, rng: Rng, px_per_notch: int) -> List[ScrollEvent]:
    sign = _sign(target)
    left = max(1, _js_round(abs(target) / px_per_notch))
    # Each event's [frame, notch count]; the notches of one frame are one event.
    frames: List[List[int]] = []
    start = 0.0
    nudged = left <= NUDGE_MAX_NOTCHES
    while left > 0:
        if nudged:
            size = _lognormal(rng, NUDGE_MU, NUDGE_SD) if frames else 1
        else:
            size = _lognormal(rng, NOTCHES_MU, NOTCHES_SD)
        n = min(left, max(1, _js_round(size)))
        duration = min(n * NOTCH_MAX_MS, _clamp(_lognormal(rng, FLICK_MU, FLICK_SD), STROKE_MIN_MS, STROKE_MAX_MS))
        regrip = _clamp(_lognormal(rng, FLICK_REGRIP_MU, FLICK_REGRIP_SD), REGRIP_MIN_MS, REGRIP_MAX_MS)
        last = start
        for i in range(n):
            last = start + duration * (1 - math.sqrt(1 - (i + 0.5) / n))
            frame = _js_round(last / FRAME_MS)
            if frames and frames[-1][0] == frame:
                frames[-1][1] += 1
            else:
                frames.append([frame, 1])
        left -= n
        start = last + regrip

    # The last event waits out the final re-grip.
    def at(i: int) -> int:
        return _js_round(frames[i][0] * FRAME_MS if i < len(frames) else start)

    return [ScrollEvent(delta_time=at(i + 1) - at(i), delta_y=sign * notches * px_per_notch) for i, (_, notches) in enumerate(frames)]


def _mac_path(target: float, rng: Rng, px_per_line: int) -> List[ScrollEvent]:
    sign = _sign(target)
    left = max(1, _js_round(abs(target) / px_per_line))
    events: List[ScrollEvent] = []
    lines = 0
    while left > 0:
        if rng() < LONE_NOTCH_PROBABILITY:
            frames = 1
        else:
            duration = _clamp(_lognormal(rng, STROKE_MU, STROKE_SD), STROKE_MIN_MS, STROKE_MAX_MS)
            frames = max(2, _js_round(duration / MAC_FRAME_MS))
        # A stroke after a short re-grip goes on at the speed macOS kept.
        lines = max(1, lines - (1 if rng() < MAC_CARRY_DROP_PROBABILITY else 0)) if lines > 0 else 1
        peak = max(lines, _js_round(_clamp(gaussian(rng, MAC_PEAK_MEAN, MAC_PEAK_SD), MAC_PEAK_MIN, MAC_PEAK_MAX)))
        f = 0
        while f < frames and left > 0:
            if f > 0:
                step = 5 if rng() < 0.2 else 1 + math.floor(rng() * 3)
                lines = min(peak, lines + step)
            sent = min(lines, left)
            left -= sent
            last = f + 1 == frames or left == 0
            if last:
                gap = _clamp(_lognormal(rng, REGRIP_MU, REGRIP_SD), REGRIP_MIN_MS, REGRIP_MAX_MS)
            else:
                gap = 2 * MAC_FRAME_MS if rng() < MAC_DROPPED_FRAME_PROBABILITY else MAC_FRAME_MS
            gap = _js_round(gap)
            events.append(ScrollEvent(delta_time=gap, delta_y=sign * sent * px_per_line))
            if last and gap > MAC_CARRY_MS:
                lines = 0
            f += 1
    return events


def generate_wheel_path(
    desired_d: float,
    rng: Rng,
    style: str = "notched",
    px_per_notch: int = 100,
    px_per_line: int = 16,
) -> List[ScrollEvent]:
    """Plan a mouse-wheel scroll of about ``desired_d`` px.

    A wheel moves in whole notches (or lines), so the sum is the nearest whole
    number of them, at least one; read it back from the events. Each event's
    ``delta_time`` is the wait after it. A request that rounds to 0 px
    returns [].
    """
    if _js_round(desired_d) == 0:
        return []
    if style == "macos":
        return _mac_path(desired_d, rng, px_per_line)
    return _notched_path(desired_d, rng, px_per_notch)


__all__ = ["generate_wheel_path"]
