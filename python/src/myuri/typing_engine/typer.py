"""Human-like typing.

Python mirror of ``js/src/typing/typer.ts``. Two stages:

1. ``MarkovTyper`` (from HumanTyping, https://github.com/Lax3n/HumanTyping)
   decides WHAT is pressed: the target text plus neighbor-key typos, swaps
   and backspace corrections.
2. ``KeystrokeTiming`` decides WHEN: a keydown/keyup timeline fitted to
   recorded human typing and English bigram frequencies, with explicit Shift
   presses and natural key overlap (rollover).

The timeline is played on one absolute clock: each action fires at
``start + at``, so driver round-trips are absorbed instead of being added to
every gap. This module knows nothing about pages, elements or the host OS.

Driving a browser that paces keys itself (e.g. Camoufox's humanize keyboard
channel) would add a second set of delays: run that channel raw.
"""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass
from typing import Callable, List, Optional, Protocol

from ..rng import gaussian
from .config import DEFAULT_WPM, WPM_STD
from .markov import MarkovTyper, TypingEvent
from .timing import KeyAction, KeystrokeTiming, Stroke, char_to_stroke

Rng = Callable[[], float]


class TyperInput(Protocol):
    """Minimal keyboard-input surface the typer depends on.

    ``down``/``up`` take a key name ('a', 'A', 'Shift', 'Enter', ...). An
    optional ``insert_text(text)`` inserts code points no US-layout key
    produces (emoji, 'é'); without it they are sent through ``down``/``up``.
    """

    async def down(self, key: str) -> None: ...

    async def up(self, key: str) -> None: ...


class TypingClock(Protocol):
    """Time source for playing the timeline. Inject a virtual one in tests."""

    def now(self) -> float:
        """Monotonic milliseconds."""
        ...

    async def sleep(self, ms: float) -> None: ...


class _RealClock:
    def now(self) -> float:
        return time.monotonic() * 1000.0

    async def sleep(self, ms: float) -> None:
        await asyncio.sleep(ms / 1000.0)


real_clock: TypingClock = _RealClock()


def char_to_key(char: str) -> str:
    """Map a typed code point to its key name ('\\n' -> 'Enter', '\\t' -> 'Tab')."""
    return char_to_stroke(char).key


@dataclass
class _StrokeInfo:
    stroke: Stroke
    char: str  # '' for Backspace
    event: TypingEvent
    mistake: bool  # fire on_mistake at this keydown (last char of an error/swap)


def _flatten(history: List[TypingEvent]) -> List[_StrokeInfo]:
    out: List[_StrokeInfo] = []
    for event in history:
        if event.kind == "backspace":
            out.append(_StrokeInfo(Stroke("Backspace"), "", event, False))
            continue
        chars = list(event.chars)
        for i, char in enumerate(chars):
            out.append(
                _StrokeInfo(
                    char_to_stroke(char),
                    char,
                    event,
                    event.kind in ("error", "swap") and i == len(chars) - 1,
                )
            )
    return out


class HumanTyper:
    def __init__(
        self,
        input: TyperInput,
        *,
        wpm: float = DEFAULT_WPM,
        mistake_multiplier: float = 1.0,
        rng: Optional[Rng] = None,
        on_character: Optional[Callable[[str, float], None]] = None,
        on_mistake: Optional[Callable[[str], None]] = None,
        on_backspace: Optional[Callable[[], None]] = None,
        clock: Optional[TypingClock] = None,
    ) -> None:
        self._input = input
        self._wpm = wpm
        self._mistake_multiplier = mistake_multiplier
        self._on_character = on_character
        self._on_mistake = on_mistake
        self._on_backspace = on_backspace
        self._rng: Rng = rng if rng is not None else random.random
        self._clock: TypingClock = clock if clock is not None else real_clock
        # Per-session typing speed, sampled ONCE so every field this typer
        # fills shares one natural speed.
        self._session_wpm = max(10.0, gaussian(self._rng, self._wpm, WPM_STD))
        self._timing = KeystrokeTiming(self._session_wpm, self._rng)

    async def type(self, text: str) -> None:
        """Type text with human-like timing, errors, and corrections."""
        if not text:
            return
        history = MarkovTyper(text, self._mistake_multiplier, self._rng).run().history
        strokes = _flatten(history)
        actions, down_at = self._timing.plan([s.stroke for s in strokes])

        def on_action(a: KeyAction) -> None:
            if a.stroke is None or a.type == "up":
                return
            info = strokes[a.stroke]
            delay_ms = down_at[a.stroke] - down_at[a.stroke - 1] if a.stroke > 0 else 0.0
            if info.char == "":
                if self._on_backspace is not None:
                    self._on_backspace()
                return
            if self._on_character is not None:
                self._on_character(info.char, delay_ms)
            if info.mistake and self._on_mistake is not None:
                self._on_mistake(info.event.chars)

        await self._play(actions, on_action)

    async def _play(
        self, actions: List[KeyAction], on_action: Optional[Callable[[KeyAction], None]] = None
    ) -> None:
        """Play a timeline on the absolute clock; release held keys on error."""
        start = self._clock.now()
        held: List[str] = []
        insert_text = getattr(self._input, "insert_text", None)
        try:
            for a in actions:
                wait = start + a.at - self._clock.now()
                if wait > 0:
                    await self._clock.sleep(wait)
                if a.type == "down":
                    await self._input.down(a.key)
                    held.append(a.key)
                elif a.type == "up":
                    await self._input.up(a.key)
                    if a.key in held:
                        held.remove(a.key)
                elif insert_text is not None:
                    await insert_text(a.key)
                else:
                    await self._input.down(a.key)
                    await self._input.up(a.key)
                if on_action is not None:
                    on_action(a)
        finally:
            for key in held:
                try:
                    await self._input.up(key)
                except Exception:
                    pass

    async def delete_all(self, count: int, select_all_modifier: Optional[str] = None) -> None:
        """Delete text.

        With a ``select_all_modifier`` (e.g. 'Control' or 'Meta' — the caller
        decides, no platform sniffing here) we hold it, press 'a', release,
        then press Backspace once. Otherwise we press Backspace ``count`` times.
        """
        if select_all_modifier:
            await self._play(self._timing.plan_select_all_delete(select_all_modifier))
            return
        if count <= 0:
            return
        actions, _ = self._timing.plan([Stroke("Backspace") for _ in range(count)])
        await self._play(actions)

    def set_wpm(self, wpm: float) -> None:
        """Update the typing speed; re-rolls the per-session speed around it."""
        self._wpm = wpm
        self._session_wpm = max(10.0, gaussian(self._rng, self._wpm, WPM_STD))
        self._timing.set_wpm(self._session_wpm)

    def get_wpm(self) -> float:
        return self._wpm

    def set_mistake_multiplier(self, mult: float) -> None:
        """Update the mistake multiplier (0 = no mistakes, 1 = default, >1 = more)."""
        self._mistake_multiplier = mult

    def get_mistake_multiplier(self) -> float:
        return self._mistake_multiplier
