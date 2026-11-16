"""Typing model configuration: what gets mistyped and corrected.

Ported from HumanTyping (https://github.com/Lax3n/HumanTyping) via the
TypeScript reference implementation (js/src/typing/config.ts).
Timing lives in ``timing.py``.
"""

from __future__ import annotations

# Default average typing speed (words per minute)
DEFAULT_WPM = 80
# Session-to-session spread of a typist's speed around their WPM.
WPM_STD = 10

# Probabilities
PROB_ERROR = 0.04
PROB_SWAP_ERROR = 0.015
PROB_NOTICE_ERROR = 0.85

# Correction probabilities
DRIFT_CORRECTION_PROB = 0.8

# Error multipliers by context
COMPLEX_WORD_ERROR_MULT = 1.5
COMMON_WORD_ERROR_MULT = 0.5
COMPOSED_ACCENT_ERROR_MULT = 2.0
