"""Human-like typing powered by a Markov chain simulation.

Based on HumanTyping (https://github.com/Lax3n/HumanTyping) via the
TypeScript reference implementation (js/src/typing/typer.ts).

Models variable speed, neighbor-key errors, character swaps, probabilistic
correction, fatigue, and natural pauses. This module is fully decoupled from
any browser driver: it drives a minimal keyboard-input surface (``TyperInput``)
and knows nothing about pages, elements, or the host platform.
"""

from __future__ import annotations

import asyncio
import random
from typing import Callable, Optional, Protocol

from ..rng import gaussian
from .config import DEFAULT_WPM, WPM_STD
from .markov import MarkovTyper, TypingEvent

Rng = Callable[[], float]


class TyperInput(Protocol):
    """Minimal keyboard-input surface the typer depends on.

    A browser driver, a test double, or any other keystroke sink can
    implement this.
    """

    async def press(self, key: str, delay: Optional[float] = None) -> None: ...

    async def down(self, key: str) -> None: ...

    async def up(self, key: str) -> None: ...


def char_to_key(char: str) -> str:
    """Map a typed code point to the key name ``TyperInput.press`` expects.

    Control characters have no printable key, so they are translated to
    their named equivalents; every other printable code point passes
    through unchanged.
    """
    if char == "\n":
        return "Enter"
    if char == "\t":
        return "Tab"
    return char


class HumanTyper:
    def __init__(
        self,
        input: TyperInput,
        *,
        wpm: float = DEFAULT_WPM,
        layout: str = "qwerty",
        mistake_multiplier: float = 1.0,
        rng: Optional[Rng] = None,
        on_character: Optional[Callable[[str, float], None]] = None,
        on_mistake: Optional[Callable[[str], None]] = None,
        on_backspace: Optional[Callable[[], None]] = None,
    ) -> None:
        self._input = input
        self._wpm = wpm
        self._layout = layout
        self._mistake_multiplier = mistake_multiplier
        self._on_character = on_character
        self._on_mistake = on_mistake
        self._on_backspace = on_backspace
        self._rng: Rng = rng if rng is not None else random.random
        # Per-session typing speed, sampled ONCE at construction so every
        # field this typer fills shares one natural speed. A real user doesn't
        # re-roll their WPM between form fields; MarkovTyper used to resample
        # per field, which this fixes.
        self._session_wpm = max(10.0, gaussian(self._rng, self._wpm, WPM_STD))

    async def type(self, text: str) -> None:
        """Type text with human-like timing, errors, and corrections.

        Runs the Markov chain simulation upfront to get the event timeline,
        then replays it. The modeled inter-key delay is the single source of
        truth for timing: we sleep it, then press the key WITHOUT an extra
        hold delay (fixes the old double-counting that slowed real WPM).
        """
        if not text:
            return

        typer = MarkovTyper(
            text,
            self._wpm,
            self._layout,
            self._mistake_multiplier,
            self._rng,
            self._session_wpm,
        )
        result = typer.run()

        for event in result.history:
            await self._dispatch(event)

    async def _dispatch(self, event: TypingEvent) -> None:
        delay_ms = event.dt_ms
        if delay_ms > 0:
            await asyncio.sleep(delay_ms / 1000)

        if event.kind == "backspace":
            await self._input.press("Backspace")
            if self._on_backspace is not None:
                self._on_backspace()
            return

        if event.kind == "swap":
            for char in event.chars:
                await self._input.press(char_to_key(char))
                if self._on_character is not None:
                    self._on_character(char, delay_ms)
            if self._on_mistake is not None:
                self._on_mistake(event.chars)
            return

        if event.kind == "error":
            await self._input.press(char_to_key(event.chars))
            if self._on_mistake is not None:
                self._on_mistake(event.chars)
            if self._on_character is not None:
                self._on_character(event.chars, delay_ms)
            return

        if event.kind in ("type", "correct"):
            for char in event.chars:
                await self._input.press(char_to_key(char))
                if self._on_character is not None:
                    self._on_character(char, delay_ms)
            return

    async def delete_all(
        self, count: int, select_all_modifier: Optional[str] = None
    ) -> None:
        """Delete text.

        With a ``select_all_modifier`` (e.g. 'Control' or 'Meta' — the caller
        decides, no platform sniffing here) we hold it, press 'a', release,
        then press Backspace once. Otherwise we press Backspace ``count``
        times.
        """
        if select_all_modifier:
            await self._input.down(select_all_modifier)
            await self._input.press("a")
            await self._input.up(select_all_modifier)
            await self._input.press("Backspace")
            return

        for _ in range(count):
            await self._input.press("Backspace")

    def set_wpm(self, wpm: float) -> None:
        """Update the typing speed (words per minute).

        Re-rolls the per-session speed around the new target.
        """
        self._wpm = wpm
        self._session_wpm = max(10.0, gaussian(self._rng, self._wpm, WPM_STD))

    def get_wpm(self) -> float:
        """Get current WPM setting."""
        return self._wpm

    def set_mistake_multiplier(self, mult: float) -> None:
        """Update the mistake multiplier (0 = no mistakes, 1 = default, >1 = more)."""
        self._mistake_multiplier = mult

    def get_mistake_multiplier(self) -> float:
        """Get current mistake multiplier."""
        return self._mistake_multiplier
