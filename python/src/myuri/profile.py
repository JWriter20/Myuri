"""Seed -> behavioral profile (mirror of ``js/src/profile.ts``).

A Cursor's ``seed`` makes the motion stream reproducible;
:func:`profile_from_seed` also draws a stable set of traits from it, so two
cursors built from the same seed type, move and scroll like the same person.
Each trait is drawn around the configured value, within ±``variation`` of it.

The draw order below is fixed and identical to the TypeScript package: both
use the same Mulberry32 PRNG and Box-Muller transform, so a seed yields
identical settings in either language.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from .plan import wheel_style_for
from .rng import gaussian, make_rng
from .settings import MyuriSettings, resolve_settings


def profile_from_seed(seed: int, settings: Optional[Dict[str, Any]] = None, os: Optional[str] = None) -> MyuriSettings:
    """The settings one person runs with: ``settings`` (merged onto the
    defaults) with each trait scaled by a factor drawn from ``seed``, normal
    around 1 with sd ``variation / 2``, clamped to 1 ± ``variation``. Same seed
    and settings, same profile. The device, the wheel and ``variation`` itself
    are not drawn; the wheel style is the ``os``'s unless ``settings`` name one."""
    p = resolve_settings(settings)
    p.scroll.wheel.style = wheel_style_for(os, settings)
    rng = make_rng(int(seed) & 0xFFFFFFFF)
    v = p.variation

    def vary(x: float) -> float:
        return x * min(1 + v, max(1 - v, gaussian(rng, 1, v / 2)))

    p.mouse.speed_factor = vary(p.mouse.speed_factor)
    p.overshoot.radius = vary(p.overshoot.radius)
    p.overshoot.threshold = vary(p.overshoot.threshold)
    p.overshoot.correction_speed_factor = vary(p.overshoot.correction_speed_factor)
    p.overshoot.dwell.min_ms = vary(p.overshoot.dwell.min_ms)
    p.overshoot.dwell.max_ms = vary(p.overshoot.dwell.max_ms)
    p.scroll.speed_factor = vary(p.scroll.speed_factor)
    # Past 1 the element would end below the viewport.
    p.scroll.finish_position = min(1.0, vary(p.scroll.finish_position))
    p.scroll.realism.speed_irregularity = vary(p.scroll.realism.speed_irregularity)
    p.typing.wpm = vary(p.typing.wpm)
    p.typing.mistake_multiplier = vary(p.typing.mistake_multiplier)
    p.typing.pauses.rate = vary(p.typing.pauses.rate)
    p.typing.pauses.length = vary(p.typing.pauses.length)
    return p
