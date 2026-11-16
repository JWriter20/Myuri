"""Markov chain-based typing simulation engine.

Ported from HumanTyping (https://github.com/Lax3n/HumanTyping) via the
TypeScript reference implementation (js/src/typing/markov.ts).

Decides WHAT a person types on the way to the target text:
- Neighbor-key errors and character swap errors
- Probabilistic error detection and backspace correction

It has no notion of time: ``timing.py`` schedules the resulting keys. The
engine is driver-agnostic and never touches a browser or the DOM.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Optional

from .config import (
    COMMON_WORD_ERROR_MULT,
    COMPLEX_WORD_ERROR_MULT,
    COMPOSED_ACCENT_ERROR_MULT,
    DRIFT_CORRECTION_PROB,
    PROB_ERROR,
    PROB_NOTICE_ERROR,
    PROB_SWAP_ERROR,
)
from .keyboard import KeyboardLayout
from .language import get_word_difficulty

Rng = Callable[[], float]


@dataclass
class TypingEvent:
    """A single modeled typing action.

    ``chars`` holds the literal code point(s) produced (empty for a
    backspace; two for a swap). Consumers dispatch on ``kind`` ('type' | 'error' | 'swap' | 'backspace' |
    'correct') — no string parsing required.
    """

    kind: str
    chars: str


# Word-boundary code points that trigger a strict correction check.
WORD_BOUNDARY_CHARS = " \n\t.,;!?:()[]{}<>\"'"


@dataclass
class _TypingState:
    current_text: List[str] = field(default_factory=list)  # typed code points so far
    history: List[TypingEvent] = field(default_factory=list)
    last_kind: Optional[str] = None
    mental_cursor_pos: int = 0  # index into target_chars (code points)


@dataclass
class MarkovRunResult:
    history: List[TypingEvent]


class MarkovTyper:
    def __init__(
        self,
        target_text: str,
        mistake_multiplier: float = 1.0,
        rng: Optional[Rng] = None,
    ) -> None:
        if not target_text:
            raise ValueError("target_text must be a non-empty string")
        if rng is None:
            raise ValueError("rng is required")

        self._target_text = target_text
        # A Python str is already a sequence of code points, so iterating it
        # directly keeps astral chars (emoji, CJK extension) as single units —
        # never split into surrogates (unlike UTF-16 indexing).
        self._target_chars: List[str] = list(target_text)
        self._keyboard = KeyboardLayout()
        self._mistake_multiplier = mistake_multiplier
        self._rng: Rng = rng

        self._state = self._fresh_state()

    def _fresh_state(self) -> _TypingState:
        return _TypingState()

    def _current_string(self) -> str:
        return "".join(self._state.current_text)

    def _is_complete(self) -> bool:
        return self._current_string() == self._target_text

    def _get_current_word_context(self) -> Optional[str]:
        idx = self._state.mental_cursor_pos
        if idx >= len(self._target_chars):
            return None

        start = idx
        while start > 0 and self._target_chars[start - 1] != " ":
            start -= 1
        end = idx
        while end < len(self._target_chars) and self._target_chars[end] != " ":
            end += 1

        return "".join(self._target_chars[start:end])

    def _advance_char(self, char: str) -> None:
        """Append a typed code point and move the mental cursor."""
        self._state.current_text.append(char)
        self._state.mental_cursor_pos += 1

    def _emit_keystroke(self, char: str, kind: str) -> TypingEvent:
        """Emit a single-keystroke event (type / error / correct)."""
        self._advance_char(char)
        event = TypingEvent(kind=kind, chars=char)
        self._state.history.append(event)
        self._state.last_kind = kind
        return event

    def step(self) -> Optional[TypingEvent]:
        # Check for completion
        if self._is_complete():
            return None

        current_len = len(self._state.current_text)

        # --- MONITORING & CORRECTION PHASE ---

        # Calculate divergence point
        first_error_pos = len(self._target_chars)
        min_len = min(current_len, len(self._target_chars))
        for i in range(min_len):
            if self._state.current_text[i] != self._target_chars[i]:
                first_error_pos = i
                break

        # Over-typing past the target counts as an error to be corrected.
        if (
            current_len > len(self._target_chars)
            and first_error_pos == len(self._target_chars)
        ):
            first_error_pos = len(self._target_chars)

        # Do we have an error?
        if first_error_pos < current_len:
            should_correct = False
            was_backspacing = self._state.last_kind == "backspace"

            # Case 0: CONTINUED BACKSPACING (Critical)
            if was_backspacing:
                should_correct = True
            # Case A: End of text (Always correct)
            elif self._state.mental_cursor_pos >= len(self._target_chars):
                should_correct = True
            # Case B: End of Word / Context Check
            elif current_len > 0:
                last_char = self._state.current_text[current_len - 1]
                distance = current_len - first_error_pos

                # Check at word boundaries (Strict)
                if last_char in WORD_BOUNDARY_CHARS:
                    should_correct = True
                # Drift Check (Don't let errors linger)
                elif distance >= 2:
                    if self._rng() < DRIFT_CORRECTION_PROB:
                        should_correct = True
                # Immediate reaction (1 char past error)
                elif distance == 1:
                    if self._rng() < PROB_NOTICE_ERROR:
                        should_correct = True

            if should_correct:
                self._state.current_text.pop()

                event = TypingEvent(kind="backspace", chars="")
                self._state.history.append(event)
                self._state.last_kind = "backspace"

                # Sync mental cursor immediately
                self._state.mental_cursor_pos = len(self._state.current_text)
                return event

        # --- TYPING PHASE ---

        # Sync mental cursor if we backspaced (redundant safety)
        if self._state.mental_cursor_pos > len(self._state.current_text):
            self._state.mental_cursor_pos = len(self._state.current_text)

        if self._state.mental_cursor_pos >= len(self._target_chars):
            return None

        char_intended = self._target_chars[self._state.mental_cursor_pos]

        # If the character is not on our keyboard, type it literally (no error modeling)
        if not self._keyboard.has_key(char_intended) and char_intended != " ":
            return self._emit_keystroke(char_intended, "type")

        # Swap Error (Anticipation): e.g. "the" -> "hte"
        if len(self._target_chars) > self._state.mental_cursor_pos + 1:
            char_after = self._target_chars[self._state.mental_cursor_pos + 1]
            if char_after != " " and char_after != char_intended:
                if self._rng() < min(
                    1.0, PROB_SWAP_ERROR * self._mistake_multiplier
                ):
                    self._advance_char(char_after)
                    self._advance_char(char_intended)
                    event = TypingEvent(kind="swap", chars=char_after + char_intended)
                    self._state.history.append(event)
                    self._state.last_kind = "swap"
                    return event

        # Normal Typing (Success or Error)
        current_prob_error = PROB_ERROR * self._mistake_multiplier
        word_diff = get_word_difficulty(self._get_current_word_context() or "")
        if word_diff == "complex":
            current_prob_error *= COMPLEX_WORD_ERROR_MULT
        elif word_diff == "common":
            current_prob_error *= COMMON_WORD_ERROR_MULT
        if self._keyboard.is_composed_accent(char_intended):
            current_prob_error *= COMPOSED_ACCENT_ERROR_MULT
        # Clamp: PROB_ERROR * mult * COMPLEX_WORD_ERROR_MULT can exceed 1.
        current_prob_error = min(1.0, current_prob_error)

        if self._rng() < current_prob_error:
            # Generate Error (neighbor-key slip)
            wrong_char = self._keyboard.get_random_neighbor(char_intended, self._rng)
            return self._emit_keystroke(wrong_char, "error")

        # Success
        return self._emit_keystroke(char_intended, "type")

    def _run_steps(self, budget: int) -> None:
        """Step until completion or until ``budget`` steps elapse."""
        steps = 0
        while self.step() is not None:
            steps += 1
            if steps > budget:
                break

    def _emit_correct_typing(self) -> None:
        """Deterministic safety net (BUG FIX).

        Discard the diverged simulation and type the exact target, one
        correctly-typed code point at a time. Guarantees the emitted history
        reconstructs to the target so the consumer never replays text that
        doesn't match.
        """
        self._state = self._fresh_state()
        for char in self._target_chars:
            self._emit_keystroke(char, "correct")

    def run(self) -> MarkovRunResult:
        budget = len(self._target_chars) * 10
        self._run_steps(budget)

        # The step cap can leave current_text != target. Never emit a history
        # that reconstructs to the wrong text: extend the budget once, then
        # fall back to a deterministic correct-typing pass.
        if not self._is_complete():
            self._run_steps(budget)
        if not self._is_complete():
            self._emit_correct_typing()

        return MarkovRunResult(history=self._state.history)
