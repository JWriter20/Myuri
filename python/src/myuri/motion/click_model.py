"""Mouse-button timing: press hold, rest before the press, multi-click gaps.

Python mirror of ``js/src/motion/click-model.ts`` (the source of truth; the
draw order is identical, so a seed gives the same clicks in both languages).
Fitted from a recording of a person clicking in Firefox with a notched USB
mouse, all lognormal in milliseconds: hold mu 4.533 sd 0.21 (median 93); last
move -> press mu 3.717 sd 1.341 (median 41); double/triple click up -> next
down mu 4.353 sd 0.113 (median 78). A later press of a run (a double or triple
click, or rapid clicks in place) is held shorter: mu 4.419 sd 0.227 (median
83). See the TypeScript module for the fit and
the drag figures.
"""
from __future__ import annotations

import math
from typing import Callable

from ..rng import gaussian

Rng = Callable[[], float]

_HOLD = (4.533, 0.21, 35, 400)
_LATER_HOLD = (4.419, 0.227, 35, 400)
_DWELL = (3.717, 1.341, 4, 600)
_MULTI_GAP = (4.353, 0.113, 30, 250)
_DRAG_START = (3.58, 1.004, 4, 500)
_DRAG_END = (3.182, 2.104, 0, 600)


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


def _lognormal(rng: Rng, params) -> int:
    mu, sd, lo, hi = params
    return _js_round(max(lo, min(hi, math.exp(gaussian(rng, mu, sd)))))


def click_hold_ms(rng: Rng, later: bool = False) -> int:
    """Milliseconds a mouse button is held down; ``later`` for a press after the first of a run."""
    return _lognormal(rng, _LATER_HOLD if later else _HOLD)


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
