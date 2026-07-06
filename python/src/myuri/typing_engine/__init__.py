"""Human-like typing simulation engine.

Python mirror of the TypeScript "myuri" typing subsystem
(js/src/typing/). Named ``typing_engine`` (not ``typing``) to avoid
shadowing Python's stdlib ``typing`` module.
"""

from __future__ import annotations

from .config import DEFAULT_WPM, WPM_STD
from .keyboard import KeyboardLayout
from .language import get_word_difficulty, is_common_bigram, is_common_trigram
from .markov import MarkovRunResult, MarkovTyper, TypingEvent
from .typer import HumanTyper, TyperInput, char_to_key

__all__ = [
    "DEFAULT_WPM",
    "WPM_STD",
    "KeyboardLayout",
    "get_word_difficulty",
    "is_common_bigram",
    "is_common_trigram",
    "MarkovRunResult",
    "MarkovTyper",
    "TypingEvent",
    "HumanTyper",
    "TyperInput",
    "char_to_key",
]
