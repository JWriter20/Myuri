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
class MouseSettings:
    """``speed_factor``: move speed (2 = moves take half as long). A call's ``move_speed`` replaces it."""

    speed_factor: float = 1.0


@dataclass
class OvershootSettings:
    """Moves longer than ``threshold`` px overshoot by up to ``radius`` px, pause
    ``dwell``, and correct back at ``correction_speed_factor`` times the move's speed."""

    radius: float = 120
    threshold: float = 500
    correction_speed_factor: float = 1
    dwell: OvershootDwell = field(default_factory=OvershootDwell)


@dataclass
class ScrollRealism:
    """Human-like irregularities applied to scrolling."""

    speed_irregularity: float = 0.08


@dataclass
class WheelSettings:
    """How a mouse wheel turns (used when ``ScrollSettings.device`` is ``"mouse"``).

    ``style`` is ``"notched"`` (Windows, Linux: one event per notch) or
    ``"macos"`` (accelerated lines in 20 ms frames).
    """

    style: str = "notched"
    px_per_notch: int = 100
    px_per_line: int = 16


@dataclass
class ScrollSettings:
    """Scroll pacing and where a scroll leaves the element.

    ``speed_factor`` 2 makes each scroll and the pause between strokes take
    half as long. ``finish_position`` is where the element ends up in the
    viewport: 0 top, 0.5 middle, 1 bottom. ``device`` is what the identity scrolls with: ``"trackpad"`` (default)
    sends a stream of small pixel deltas, ``"mouse"`` turns a wheel in notches
    (see ``wheel``). Camoufox turns every wheel call into notches, so use
    ``"mouse"`` there.
    """

    speed_factor: float = 1.0
    finish_position: float = 0.5
    realism: ScrollRealism = field(default_factory=ScrollRealism)
    device: str = "trackpad"
    wheel: WheelSettings = field(default_factory=WheelSettings)


@dataclass
class TypingPauses:
    """Hesitations between keys: ``rate`` scales how often one happens, ``length`` how much time it adds."""

    rate: float = 1.0
    length: float = 1.0


@dataclass
class TypingSettings:
    """Words per minute (with the default pauses), how often typos happen
    (``mistake_multiplier``: 0 never, 2 twice as often), and the pauses. ``wpm``
    counts the default pauses, so fewer or shorter pauses type a little faster."""

    wpm: float = 80
    mistake_multiplier: float = 1.0
    pauses: TypingPauses = field(default_factory=TypingPauses)


@dataclass
class MyuriSettings:
    """Top-level behavioral settings for a Cursor instance.

    ``variation`` is how far each trait of a seed's profile may stray from these
    settings: a trait is drawn within ±``variation`` of its value (0.2 = ±20%);
    0 runs the settings exactly. See :func:`myuri.profile_from_seed`.
    """

    variation: float = 0.2
    mouse: MouseSettings = field(default_factory=MouseSettings)
    overshoot: OvershootSettings = field(default_factory=OvershootSettings)
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
