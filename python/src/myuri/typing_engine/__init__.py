"""Human-like typing simulation engine.

Python mirror of the TypeScript "myuri" typing subsystem
(js/src/typing/). Named ``typing_engine`` (not ``typing``) to avoid
shadowing Python's stdlib ``typing`` module.
"""

from __future__ import annotations

from .config import DEFAULT_WPM, WPM_STD
from .keyboard import KeyboardLayout
from .language import get_word_difficulty
from .markov import MarkovRunResult, MarkovTyper, TypingEvent
from .timing import KeyAction, KeystrokeTiming, Stroke, needs_shift, strokes_for_text
from .typer import HumanTyper, TyperInput, TypingClock, char_to_key, real_clock

__all__ = [
    "DEFAULT_WPM",
    "WPM_STD",
    "KeyboardLayout",
    "get_word_difficulty",
    "MarkovRunResult",
    "MarkovTyper",
    "TypingEvent",
    "HumanTyper",
    "TyperInput",
    "TypingClock",
    "char_to_key",
    "real_clock",
    "KeyAction",
    "KeystrokeTiming",
    "Stroke",
    "needs_shift",
    "strokes_for_text",
]
