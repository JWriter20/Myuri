"""Mouse-button timing: press hold, rest before the press, multi-click gaps.

Python mirror of ``js/src/motion/click-model.ts`` (the source of truth; the
draw order is identical, so a seed gives the same clicks in both languages).
Fitted from four recordings of people clicking in Firefox, all lognormal in
milliseconds: hold mu 4.58 sd 0.258 (median 97); last move -> press mu 3.364
sd 0.935 (median 29); double/triple click up -> next down mu 4.473 sd 0.264
(median 88). See the TypeScript module for the per-machine numbers.
"""
from __future__ import annotations

import math
from typing import Callable

from ..rng import gaussian

Rng = Callable[[], float]

_HOLD = (4.58, 0.258, 35, 400)
_DWELL = (3.364, 0.935, 4, 600)
_MULTI_GAP = (4.473, 0.264, 30, 250)
_DRAG_START = (4.548, 0.566, 20, 500)
_DRAG_END = (3.555, 1.2, 0, 600)


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


def _lognormal(rng: Rng, params) -> int:
    mu, sd, lo, hi = params
    return _js_round(max(lo, min(hi, math.exp(gaussian(rng, mu, sd)))))


def click_hold_ms(rng: Rng) -> int:
    """Milliseconds a mouse button is held down."""
    return _lognormal(rng, _HOLD)


def pre_click_dwell_ms(rng: Rng) -> int:
    """Milliseconds from the last mouse move to the press."""
    return _lognormal(rng, _DWELL)


def multi_click_gap_ms(rng: Rng) -> int:
    """Milliseconds from releasing one click of a double/triple click to pressing the next."""
    return _lognormal(rng, _MULTI_GAP)


def drag_start_ms(rng: Rng) -> int:
    """Milliseconds from pressing to the first move of a drag."""
    return _lognormal(rng, _DRAG_START)


def drag_end_ms(rng: Rng) -> int:
    """Milliseconds from the last move of a drag to releasing."""
    return _lognormal(rng, _DRAG_END)


def drag_carry_speed(rng: Rng) -> float:
    """Speed factor for the carrying move of a drag (people move slower with a
    button held). Mirrors ``dragCarrySpeed`` in click-model.ts."""
    return min(1.2, max(0.4, math.exp(gaussian(rng, -0.288, 0.25))))
