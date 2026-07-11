"""Seed -> behavioral profile (mirror of ``js/src/profile.ts``).

A Cursor's ``seed`` already makes the per-action *motion stream* reproducible.
:func:`profile_from_seed` goes one step further: it derives a stable set of
behavioral traits — a *behavioral fingerprint* — from the same seed. Two
cursors built from the same seed therefore share not just identical motion but
the same "personality": typing speed, mistake rate, overshoot aggressiveness,
scroll pacing.

The draw order below is fixed and identical to the TypeScript package; because
both use the same Mulberry32 PRNG and Box-Muller transform, a given seed yields
byte-identical settings in either language.
"""
from __future__ import annotations

import math

from .rng import Rng, gaussian, make_rng
from .settings import MyuriSettings, resolve_settings


def _clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


def _round_half_up(value: float) -> int:
    """Round half-up, matching JS ``Math.round`` (Python's ``round`` banker-rounds)."""
    return math.floor(value + 0.5)


def _draw(rng: Rng, mean: float, std: float, low: float, high: float) -> float:
    """One Gaussian draw, clamped into ``[low, high]``."""
    return _clamp(gaussian(rng, mean, std), low, high)


def profile_from_seed(seed: int) -> MyuriSettings:
    """Derive a full :class:`MyuriSettings` behavioral profile from a seed.

    Same seed -> identical profile. Values are drawn around the defaults so a
    random seed still yields plausible, human-range behavior; ``resolve_settings``
    fills any field not drawn here.
    """
    rng = make_rng(int(seed) & 0xFFFFFFFF)

    # Typing.
    wpm = _round_half_up(_draw(rng, 80, 18, 35, 130))
    mistake_multiplier = _draw(rng, 1.0, 0.35, 0.4, 2.0)
    # Layout knob removed (always qwerty); still burn its old draw so
    # seed→profile streams stay stable.
    rng()

    # Scroll dynamics.
    scroll_speed_factor = _draw(rng, 1.0, 0.16, 0.75, 1.4)
    scroll_delay = _round_half_up(_draw(rng, 50, 12, 25, 90))
    scroll_overshoot = _round_half_up(_draw(rng, 30, 10, 8, 60))
    scroll_finish_position = _draw(rng, 0.5, 0.08, 0.3, 0.7)
    scroll_irregularity = _draw(rng, 0.08, 0.03, 0.02, 0.18)

    # Overshoot / correction geometry.
    overshoot_spread = _draw(rng, 10, 3, 4, 20)
    overshoot_radius = _draw(rng, 120, 30, 60, 200)
    overshoot_threshold = _round_half_up(_draw(rng, 500, 100, 300, 800))
    correction_speed_factor = _draw(rng, 1.0, 0.15, 0.7, 1.4)
    dwell_min = _round_half_up(_draw(rng, 20, 6, 5, 40))
    dwell_max = dwell_min + _round_half_up(_draw(rng, 40, 12, 15, 80))

    return resolve_settings(
        {
            "overshoot": {
                "spread": overshoot_spread,
                "radius": overshoot_radius,
                "threshold": overshoot_threshold,
                "correction_speed_factor": correction_speed_factor,
                "dwell": {"min_ms": dwell_min, "max_ms": dwell_max},
            },
            "scroll": {
                "delay": scroll_delay,
                "speed_factor": scroll_speed_factor,
                "overshoot": scroll_overshoot,
                "finish_position": scroll_finish_position,
                "realism": {"speed_irregularity": scroll_irregularity},
            },
            "typing": {
                "wpm": wpm,
                "mistake_multiplier": mistake_multiplier,
            },
        }
    )
