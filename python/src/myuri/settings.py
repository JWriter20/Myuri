"""Behavioral tuning for myuri (mirror of ``js/src/settings.ts``).

These are plain per-instance defaults, not a global singleton: every call to
:func:`default_settings` / :func:`resolve_settings` returns a fresh, fully
owned object graph, so two cursors with different seeds never share or race
on mutable config.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field, is_dataclass
from typing import Any, Dict, Optional


@dataclass
class OvershootDwell:
    """Pause range (ms) at the overshoot point before correcting."""

    min_ms: float = 20
    max_ms: float = 60


@dataclass
class OvershootSettings:
    """How far moves overshoot the target and how the correction behaves."""

    spread: float = 10
    radius: float = 120
    threshold: float = 500
    correction_speed_factor: float = 1
    dwell: OvershootDwell = field(default_factory=OvershootDwell)


@dataclass
class CorrectionSettings:
    """Retry and dynamic-adjustment behavior when the cursor misses a target."""

    retry_spread: float = 5
    retry_move_speed_factor: float = 1
    dynamic_adjustment_shift_threshold: float = 5
    dynamic_adjustment_speed_factor: float = 1
    dynamic_adjustment_noise_scale: float = 0.5


@dataclass
class ScrollRealism:
    """Human-like irregularities applied to scrolling."""

    speed_irregularity: float = 0.08


@dataclass
class ScrollSettings:
    """Scroll pacing, overshoot, and finish position."""

    delay: float = 50
    speed_factor: float = 1.0
    overshoot: float = 30
    finish_position: float = 0.5
    realism: ScrollRealism = field(default_factory=ScrollRealism)


@dataclass
class TypingSettings:
    """Typing speed and mistake frequency."""

    wpm: float = 80
    mistake_multiplier: float = 1.0


@dataclass
class MyuriSettings:
    """Top-level behavioral settings for a Cursor instance."""

    overshoot: OvershootSettings = field(default_factory=OvershootSettings)
    correction: CorrectionSettings = field(default_factory=CorrectionSettings)
    scroll: ScrollSettings = field(default_factory=ScrollSettings)
    typing: TypingSettings = field(default_factory=TypingSettings)


def default_settings() -> MyuriSettings:
    """Return a fresh, fully-owned default settings instance.

    Every call builds a new object graph (no shared nested references), so
    mutating one cursor's settings can never leak into another's.
    """
    return MyuriSettings()


def _merge_into(target: Any, overrides: Dict[str, Any]) -> Any:
    """Recursively apply ``overrides`` onto dataclass ``target`` (mutates it)."""
    valid = {f.name for f in dataclasses.fields(target)}
    for key, value in overrides.items():
        if key not in valid:
            raise KeyError(
                "myuri: unknown settings key {!r} for {}".format(key, type(target).__name__)
            )
        if value is None:
            # Mirror the TS deep-merge, which skips `undefined` override values.
            continue
        current = getattr(target, key)
        if is_dataclass(current) and isinstance(value, dict):
            _merge_into(current, value)
        else:
            setattr(target, key, value)
    return target


def resolve_settings(overrides: Optional[Dict[str, Any]] = None) -> MyuriSettings:
    """Produce a fresh, fully-owned settings object from a partial override.

    ``overrides`` is a (possibly nested) dict keyed by field names, e.g.
    ``{"scroll": {"speed_factor": 2.0}, "typing": {"wpm": 60}}``. Values of
    ``None`` are skipped (like ``undefined`` in the TS deep merge); unknown
    keys raise ``KeyError``.
    """
    settings = default_settings()
    if overrides:
        _merge_into(settings, overrides)
    return settings
