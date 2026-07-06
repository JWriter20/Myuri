"""Markov chain-based typing simulation engine.

Ported from HumanTyping (https://github.com/Lax3n/HumanTyping) via the
TypeScript reference implementation (js/src/typing/markov.ts).

Models realistic human typing with:
- Variable speed based on word complexity and key distance
- Neighbor-key errors and character swap errors
- Probabilistic error detection and backspace correction
- Fatigue over longer texts
- Natural pauses at word boundaries

The engine is driver-agnostic: it produces a stream of structured
``TypingEvent``s that a consumer (see ``HumanTyper``) replays against some
input surface. It never touches a browser or the DOM.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Optional

from ..rng import gaussian
from .config import (
    AVG_WORD_LENGTH,
    CLOSE_KEY_THRESHOLD,
    COMMON_WORD_ERROR_MULT,
    COMPLEX_WORD_ERROR_MULT,
    COMPOSED_ACCENT_ERROR_MULT,
    DEFAULT_WPM,
    DRIFT_CORRECTION_PROB,
    FAR_KEY_PENALTY,
    FAR_KEY_THRESHOLD,
    FATIGUE_CAP,
    FATIGUE_FACTOR,
    MIN_BACKSPACE_TIME,
    MIN_KEYSTROKE_TIME,
    MIN_REACTION_TIME,
    MIN_SPEED_MULTIPLIER,
    PROB_ERROR,
    PROB_NOTICE_ERROR,
    PROB_SWAP_ERROR,
    SPEED_BOOST_BIGRAM,
    SPEED_BOOST_CLOSE_KEYS,
    SPEED_BOOST_COMMON_WORD,
    SPEED_BOOST_SPACE,
    SPEED_BOOST_TRIGRAM,
    SPEED_PENALTY_COMPLEX_WORD,
    TIME_BACKSPACE_MEAN,
    TIME_BACKSPACE_STD,
    TIME_COMPOSED_ACCENT_PENALTY,
    TIME_DIRECT_ACCENT_PENALTY,
    TIME_KEYSTROKE_STD,
    TIME_REACTION_MEAN,
    TIME_REACTION_STD,
    TIME_UPPERCASE_PENALTY,
    WPM_STD,
)
from .keyboard import KeyboardLayout
from .language import get_word_difficulty, is_common_bigram, is_common_trigram

Rng = Callable[[], float]


@dataclass
class TypingEvent:
    """A single modeled typing action.

    ``chars`` holds the literal code point(s) produced (empty for a
    backspace); ``dt_ms`` is the time to wait for this action, in
    milliseconds (already inclusive of any reaction pause). Consumers
    dispatch on ``kind`` ('type' | 'error' | 'swap' | 'backspace' |
    'correct') — no string parsing required.
    """

    kind: str
    chars: str
    dt_ms: float


# Word-boundary code points that trigger a strict correction check.
WORD_BOUNDARY_CHARS = " \n\t.,;!?:()[]{}<>\"'"


@dataclass
class _TypingState:
    current_text: List[str] = field(default_factory=list)  # typed code points so far
    total_time: float = 0.0  # seconds
    history: List[TypingEvent] = field(default_factory=list)
    last_char_typed: Optional[str] = None
    last_kind: Optional[str] = None
    fatigue_multiplier: float = 1.0
    mental_cursor_pos: int = 0  # index into target_chars (code points)


@dataclass
class MarkovRunResult:
    total_time: float
    history: List[TypingEvent]


class MarkovTyper:
    def __init__(
        self,
        target_text: str,
        target_wpm: float = DEFAULT_WPM,
        layout: str = "qwerty",
        mistake_multiplier: float = 1.0,
        rng: Optional[Rng] = None,
        # Pre-resolved per-session WPM. When provided (e.g. sampled once by the
        # HumanTyper so every field shares one speed), it is used directly
        # instead of drawing a fresh N(target_wpm, WPM_STD) sample per instance.
        session_wpm: Optional[float] = None,
    ) -> None:
        if not target_text:
            raise ValueError("target_text must be a non-empty string")
        if target_wpm <= 0:
            raise ValueError("target_wpm must be a positive number")
        if rng is None:
            raise ValueError("rng is required")

        self._target_text = target_text
        # A Python str is already a sequence of code points, so iterating it
        # directly keeps astral chars (emoji, CJK extension) as single units —
        # never split into surrogates (unlike UTF-16 indexing).
        self._target_chars: List[str] = list(target_text)
        self._keyboard = KeyboardLayout(layout)
        self._mistake_multiplier = mistake_multiplier
        self._rng: Rng = rng

        resolved_wpm = (
            max(10.0, session_wpm)
            if session_wpm is not None
            else max(10.0, gaussian(self._rng, target_wpm, WPM_STD))
        )
        self._base_keystroke_time = 60.0 / (resolved_wpm * AVG_WORD_LENGTH)

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

    def _calculate_keystroke_time(self, char_to_type: str) -> float:
        keystroke_time = self._base_keystroke_time * self._state.fatigue_multiplier

        current_word = self._get_current_word_context()
        if current_word:
            difficulty = get_word_difficulty(current_word)
            if difficulty == "common":
                keystroke_time *= SPEED_BOOST_COMMON_WORD
            elif difficulty == "complex":
                keystroke_time *= SPEED_PENALTY_COMPLEX_WORD

        if self._state.last_char_typed:
            sequence_boost = False
            length = len(self._state.current_text)

            # Trigram boost (strongest — we're mid-flow in a common sequence)
            if length >= 2:
                c1 = self._state.current_text[length - 2]
                c2 = self._state.current_text[length - 1]
                if is_common_trigram(c1, c2, char_to_type):
                    keystroke_time *= SPEED_BOOST_TRIGRAM
                    sequence_boost = True

            # Bigram boost
            if not sequence_boost and is_common_bigram(
                self._state.last_char_typed, char_to_type
            ):
                keystroke_time *= SPEED_BOOST_BIGRAM
                sequence_boost = True

            # Fall back to distance-based adjustments
            if not sequence_boost:
                dist = self._keyboard.get_distance(
                    self._state.last_char_typed, char_to_type
                )
                if 0 < dist < CLOSE_KEY_THRESHOLD:
                    keystroke_time *= SPEED_BOOST_CLOSE_KEYS
                elif dist > FAR_KEY_THRESHOLD:
                    keystroke_time *= FAR_KEY_PENALTY

        if char_to_type == " ":
            keystroke_time *= SPEED_BOOST_SPACE  # Space is fast — thumb key, always hovering
        elif self._keyboard.is_composed_accent(char_to_type):
            keystroke_time += TIME_COMPOSED_ACCENT_PENALTY
        elif self._keyboard.is_direct_accent(char_to_type):
            keystroke_time += TIME_DIRECT_ACCENT_PENALTY
        elif char_to_type != char_to_type.lower():
            keystroke_time += TIME_UPPERCASE_PENALTY

        # Apply floor to prevent unrealistic stacking of boosts
        keystroke_time = max(
            MIN_SPEED_MULTIPLIER * self._base_keystroke_time, keystroke_time
        )

        dt = gaussian(self._rng, keystroke_time, TIME_KEYSTROKE_STD)
        return max(MIN_KEYSTROKE_TIME, dt)

    def _bump_fatigue(self) -> None:
        self._state.fatigue_multiplier = min(
            FATIGUE_CAP, self._state.fatigue_multiplier * FATIGUE_FACTOR
        )

    def _keystroke_dt(self, char: str, literal: bool) -> float:
        """Time (seconds) for a single keystroke.

        ``literal`` keys (code points not on the layout) use the plain base
        timing — no bigram/distance/accent modeling.
        """
        if literal:
            base = self._base_keystroke_time * self._state.fatigue_multiplier
            return max(
                MIN_KEYSTROKE_TIME, gaussian(self._rng, base, TIME_KEYSTROKE_STD)
            )
        return self._calculate_keystroke_time(char)

    def _advance_char(self, char: str, literal: bool) -> float:
        """Advance the simulation by one typed code point.

        Bumps fatigue, samples the keystroke time, appends the char, and
        moves the mental cursor. Returns the sampled dt in seconds. Shared by
        every keystroke path so fatigue is applied exactly once per emitted
        character (including inside swaps).
        """
        self._bump_fatigue()
        dt = self._keystroke_dt(char, literal)
        self._state.total_time += dt
        self._state.current_text.append(char)
        self._state.last_char_typed = char
        self._state.mental_cursor_pos += 1
        return dt

    def _emit_keystroke(
        self, char: str, kind: str, literal: bool = False
    ) -> TypingEvent:
        """Emit a single-keystroke event (type / error / correct)."""
        dt = self._advance_char(char, literal)
        event = TypingEvent(kind=kind, chars=char, dt_ms=dt * 1000)
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
                dt_total = 0.0
                # Reaction time (only if we weren't already backspacing)
                if not was_backspacing:
                    dt_total += max(
                        MIN_REACTION_TIME,
                        gaussian(self._rng, TIME_REACTION_MEAN, TIME_REACTION_STD),
                    )

                # Perform Backspace
                dt_total += max(
                    MIN_BACKSPACE_TIME,
                    gaussian(self._rng, TIME_BACKSPACE_MEAN, TIME_BACKSPACE_STD),
                )
                self._state.total_time += dt_total
                self._state.current_text.pop()

                event = TypingEvent(kind="backspace", chars="", dt_ms=dt_total * 1000)
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
            return self._emit_keystroke(char_intended, "type", literal=True)

        # Swap Error (Anticipation): e.g. "the" -> "hte"
        if len(self._target_chars) > self._state.mental_cursor_pos + 1:
            char_after = self._target_chars[self._state.mental_cursor_pos + 1]
            if char_after != " " and char_after != char_intended:
                if self._rng() < min(
                    1.0, PROB_SWAP_ERROR * self._mistake_multiplier
                ):
                    dt1 = self._advance_char(char_after, False)
                    dt2 = self._advance_char(char_intended, False)
                    event = TypingEvent(
                        kind="swap",
                        chars=char_after + char_intended,
                        dt_ms=(dt1 + dt2) * 1000,
                    )
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
            literal = not self._keyboard.has_key(char) and char != " "
            self._emit_keystroke(char, "correct", literal)

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

        return MarkovRunResult(
            total_time=self._state.total_time, history=self._state.history
        )
