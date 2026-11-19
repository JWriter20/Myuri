"""Keystroke timing: when every keydown and keyup happens.

Python mirror of ``js/src/typing/timing.ts`` — same constants, same RNG draw
order, so a seed yields the same timeline in both languages.

The Markov engine (``markov.py``) decides WHAT gets typed. This module decides
WHEN: it turns that key sequence into an absolute timeline of keydown/keyup
actions, including explicit Shift presses, so keys overlap the way real typing
does. The model was fitted on recorded human typing (one typist, three
machines, 1268 key pairs, Nov 2026) and on John Burkardt's English bigram
counts (``bigrams.py``). See the TypeScript module for the full derivation.
"""

from __future__ import annotations

import base64
import math
import re
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

from ..rng import gaussian
from ..settings import TypingPauses
from .bigrams import BIGRAM_MEAN_LOG10, BIGRAM_TABLE_B64

Rng = Callable[[], float]

# ---- fitted constants (log-space coefficients on the gap in ms) ----

BASE = 4.618
BIGRAM = -0.338
SAME_FINGER = 0.289
REPEAT = 0.178
ROW_JUMP = 0.04
SHIFTED = 0.976

CONTEXT: Dict[str, float] = {
    "inWord": 0.0,
    "wordStart": 0.788,
    "toSpace": 0.071,
    "toEnter": 1.2,
    "toDigit": 1.848,
    "digitRun": 0.301,
    "toPunct": 1.045,
    "fromPunct": 1.316,
    "bsNotice": 1.378,
    "bsRepeat": 0.449,
    "afterBs": 0.657,
}

# Pauses are a little rarer and shorter than the fit (8% at mean 1.2); see timing.ts.
NOISE_SD = 0.48
PAUSE_PROB = 0.06
PAUSE_MEAN = 1.0
PAUSE_SD = 0.5
DRIFT_RHO = 0.97
DRIFT_STEP_SD = 0.03

MIN_GAP_MS = 10.0
MAX_GAP_MS = 5000.0

HOLD: Dict[str, Tuple[float, float]] = {
    "key": (100.0, 0.28),
    "space": (80.0, 0.22),
    "backspace": (85.0, 0.45),
    "enter": (95.0, 0.25),
}
MIN_HOLD_MS = 25.0
MAX_HOLD_MS = 400.0
SESSION_HOLD_SD = 0.12
HOLD_SPEED_EXPONENT = 0.3

SHIFT_LEAD_MEDIAN = 115.0
SHIFT_LEAD_SD = 0.6
SHIFT_LEAD_MIN = 30.0
SHIFT_TRAIL_MEAN = -15.0
SHIFT_TRAIL_SD = 35.0
SHIFT_MIN_AFTER_KEY = 20.0
SHIFT_CLEAR = 8.0
SAME_KEY_CLEAR = 8.0

REFERENCE_TEXT = (
    "The quick check took about 20 minutes, so we moved on. Please send the "
    "report to the team before Friday; they need it for the meeting at 3pm. "
    "I think it looks good, but there are a few things we should fix first. "
    "Thanks again for your help with this! Let me know if anything changes."
)

# ---- keyboard geometry (US QWERTY touch typing) ----

UNSHIFT: Dict[str, str] = dict(zip('~!@#$%^&*()_+{}|:"<>?', "`1234567890-=[]\\;',./"))
FINGER: Dict[str, int] = {}
ROW: Dict[str, int] = {}
for _row in ["`12345", "qwert", "asdfg", "zxcvb"]:
    _fingers = [0, 0, 1, 2, 3, 3] if _row[0] == "`" else [0, 1, 2, 3, 3]
    for _i, _c in enumerate(_row):
        FINGER[_c] = _fingers[_i]
for _row in ["67890-=", "yuiop[]\\", "hjkl;'", "nm,./"]:
    for _i, _c in enumerate(_row):
        FINGER[_c] = [4, 4, 5, 6, 7, 7, 7, 7][_i]
for _r, _row in enumerate(["`1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./"]):
    for _c in _row:
        ROW[_c] = _r

BIGRAM_LOG10: List[float] = [-b / 20 for b in base64.b64decode(BIGRAM_TABLE_B64)]

_PRINTABLE = re.compile(r"^[\x20-\x7e]$")


@dataclass(frozen=True)
class Stroke:
    """One key press: a printable char, 'Enter', 'Tab' or 'Backspace'.

    ``insert`` marks a code point no US key produces (emoji, 'é'): inserted as
    text at its keydown time, with no keyup and no Shift.
    """

    key: str
    insert: bool = False


@dataclass
class KeyAction:
    """One scheduled input action, ``at`` ms after the plan starts."""

    at: float
    type: str  # 'down' | 'up' | 'insert'
    key: str
    stroke: Optional[int] = None


def _physical(key: str) -> str:
    if len(key) != 1:
        return key
    lower = key.lower()
    return UNSHIFT.get(lower, lower)


def needs_shift(key: str) -> bool:
    """Whether typing ``key`` on US QWERTY needs Shift held."""
    if len(key) != 1:
        return False
    return "A" <= key <= "Z" or key in UNSHIFT


def _is_letter(c: str) -> bool:
    return len(c) == 1 and "a" <= c <= "z"


def _is_digit(c: str) -> bool:
    return len(c) == 1 and "0" <= c <= "9"


def _is_alnum(c: str) -> bool:
    return len(c) == 1 and (_is_digit(c) or "a" <= c.lower() <= "z")


def context_of(prev: Stroke, cur: Stroke) -> str:
    p, c = prev.key, cur.key
    if c == "Backspace":
        return "bsRepeat" if p == "Backspace" else "bsNotice"
    if p == "Backspace":
        return "afterBs"
    if c == " ":
        return "toSpace"
    if c in ("Enter", "Tab"):
        return "toEnter"
    if p in (" ", "Enter", "Tab"):
        return "wordStart"
    if cur.insert:
        return "toPunct"
    if _is_digit(c):
        return "digitRun" if _is_digit(p) else "toDigit"
    if len(c) == 1 and not _is_alnum(c):
        return "toPunct"
    if prev.insert or (len(p) == 1 and not _is_alnum(p)) or _is_digit(p):
        return "fromPunct"
    return "inWord"


def log_gap_mean(prev: Stroke, cur: Stroke) -> float:
    """Deterministic part of log(gap) for the pair (prev -> cur)."""
    mu = BASE + CONTEXT[context_of(prev, cur)]
    if cur.insert or prev.insert:
        return mu
    a, b = _physical(prev.key), _physical(cur.key)
    if _is_letter(a) and _is_letter(b):
        share = BIGRAM_LOG10[(ord(a) - 97) * 26 + (ord(b) - 97)]
        mu += BIGRAM * (share - BIGRAM_MEAN_LOG10)
    fa, fb = FINGER.get(a), FINGER.get(b)
    if fa is not None and fa == fb and a != b:
        mu += SAME_FINGER
    if a == b and len(a) == 1:
        mu += REPEAT
    if a in ROW and b in ROW:
        mu += ROW_JUMP * abs(ROW[a] - ROW[b])
    if needs_shift(cur.key) and not needs_shift(prev.key):
        mu += SHIFTED
    return mu


def _hold_class(key: str) -> str:
    if key == " ":
        return "space"
    if key == "Backspace":
        return "backspace"
    if key in ("Enter", "Tab"):
        return "enter"
    return "key"


def char_to_stroke(char: str) -> Stroke:
    if char == "\n":
        return Stroke("Enter")
    if char == "\t":
        return Stroke("Tab")
    if _PRINTABLE.match(char):
        return Stroke(char)
    return Stroke(char, insert=True)


def strokes_for_text(text: str) -> List[Stroke]:
    """Split text into strokes the way the typer presses them."""
    return [char_to_stroke(c) for c in text]


NOISE_MEAN_FACTOR = (
    math.exp(NOISE_SD * NOISE_SD / 2)
    * (1 - PAUSE_PROB + PAUSE_PROB * math.exp(PAUSE_MEAN + PAUSE_SD * PAUSE_SD / 2))
    * math.exp(DRIFT_STEP_SD * DRIFT_STEP_SD / (1 - DRIFT_RHO * DRIFT_RHO) / 2)
)


def _reference_mean_gap() -> float:
    s = strokes_for_text(REFERENCE_TEXT)
    total = 0.0
    for i in range(1, len(s)):
        total += math.exp(log_gap_mean(s[i - 1], s[i]))
    return total / (len(s) - 1) * NOISE_MEAN_FACTOR


REFERENCE_MEAN_GAP_MS = _reference_mean_gap()


def mean_gap_for_wpm(wpm: float) -> float:
    """Mean keydown-to-keydown gap for a WPM (5 characters per word)."""
    return 12000.0 / wpm


class KeystrokeTiming:
    """Stateful keystroke timing for one typing session (keep one per typist)."""

    def __init__(self, wpm: float, rng: Rng, pauses: Optional[TypingPauses] = None) -> None:
        self._rng = rng
        self._pauses = pauses or TypingPauses()
        self._scale = mean_gap_for_wpm(wpm) / REFERENCE_MEAN_GAP_MS
        self._hold_factor = math.exp(gaussian(rng, 0, SESSION_HOLD_SD))
        self._drift = 0.0

    def set_wpm(self, wpm: float) -> None:
        self._scale = mean_gap_for_wpm(wpm) / REFERENCE_MEAN_GAP_MS

    def gap(self, prev: Stroke, cur: Stroke) -> float:
        """One sampled keydown-to-keydown gap, ms."""
        self._drift = DRIFT_RHO * self._drift + gaussian(self._rng, 0, DRIFT_STEP_SD)
        noise = gaussian(self._rng, 0, NOISE_SD)
        ms = self._scale * math.exp(log_gap_mean(prev, cur) + noise + self._drift)
        if self._rng() < PAUSE_PROB * self._pauses.rate:
            ms *= 1 + self._pauses.length * (math.exp(max(0.0, gaussian(self._rng, PAUSE_MEAN, PAUSE_SD))) - 1)
        return min(MAX_GAP_MS, max(MIN_GAP_MS, ms))

    def hold(self, key: str) -> float:
        """One sampled hold (keydown to keyup), ms."""
        median, sd = HOLD[_hold_class(key)]
        ms = (
            median
            * self._hold_factor
            * self._scale ** HOLD_SPEED_EXPONENT
            * math.exp(gaussian(self._rng, 0, sd))
        )
        return min(MAX_HOLD_MS, max(MIN_HOLD_MS, ms))

    def _shift_lead(self) -> float:
        return max(SHIFT_LEAD_MIN, SHIFT_LEAD_MEDIAN * math.exp(gaussian(self._rng, 0, SHIFT_LEAD_SD)))

    def plan(
        self, strokes: List[Stroke], after: Optional[Stroke] = None
    ) -> Tuple[List[KeyAction], List[float]]:
        """Plan ``strokes`` as an absolute timeline starting at 0.

        Returns the actions sorted by time and, per stroke, its keydown time.
        """
        actions: List[Tuple[KeyAction, int]] = []

        def push(at: float, typ: str, key: str, stroke: Optional[int] = None) -> None:
            actions.append((KeyAction(at, typ, key, stroke), len(actions)))

        down_at: List[float] = []
        last_press: Dict[str, Tuple[float, int]] = {}
        shift = {"held": False, "down": 0.0, "up": 0.0}

        def release_shift(not_after: float) -> None:
            at = shift["up"] + gaussian(self._rng, SHIFT_TRAIL_MEAN, SHIFT_TRAIL_SD)
            at = max(at, shift["down"] + SHIFT_MIN_AFTER_KEY)
            at = min(at, not_after)
            push(at, "up", "Shift")
            shift["held"] = False

        for i, s in enumerate(strokes):
            prev = strokes[i - 1] if i > 0 else after
            cold = i == 0 and prev is None
            t = ((down_at[i - 1] if i > 0 else 0.0) + self.gap(prev, s)) if prev is not None else 0.0
            shifted = not s.insert and needs_shift(s.key)

            if not shifted and shift["held"]:
                t = max(t, shift["down"] + SHIFT_MIN_AFTER_KEY + SHIFT_CLEAR)
                release_shift(t - SHIFT_CLEAR)
            if shifted and not shift["held"]:
                lead = self._shift_lead()
                floor = down_at[i - 1] + 10 if i > 0 else 0.0
                if cold:
                    t = lead
                shift_at = max(floor, t - lead)
                t = max(t, shift_at + SHIFT_LEAD_MIN)
                push(shift_at, "down", "Shift")
                shift["held"] = True

            last = None if s.insert else last_press.get(_physical(s.key))
            if last is not None:
                last_down, up_idx = last
                prev_up = actions[up_idx][0]
                latest_up = t - SAME_KEY_CLEAR
                if prev_up.at > latest_up:
                    earliest_up = last_down + MIN_HOLD_MS
                    if latest_up >= earliest_up:
                        prev_up.at = latest_up
                    else:
                        prev_up.at = earliest_up
                        t = earliest_up + SAME_KEY_CLEAR

            down_at.append(t)
            if s.insert:
                push(t, "insert", s.key, i)
                continue
            push(t, "down", s.key, i)
            up = t + self.hold(s.key)
            last_press[_physical(s.key)] = (t, len(actions))
            push(up, "up", s.key, i)
            if shifted:
                shift["down"] = t
                shift["up"] = up
        if shift["held"]:
            release_shift(math.inf)

        actions.sort(key=lambda a: (a[0].at, a[1]))
        return [a for a, _ in actions], down_at

    def plan_chord(self, modifiers: List[str], key: str) -> List[KeyAction]:
        """A chord such as Control+a or Meta+Shift+z: each modifier goes down a
        Shift-like lead after the one before, the key after the last, and each
        modifier comes up just after the key does (innermost first)."""
        out: List[KeyAction] = []
        at = 0.0
        for i, m in enumerate(modifiers):
            if i > 0:
                at += self._shift_lead()
            out.append(KeyAction(at, "down", m))
        key_down = at + self._shift_lead() if modifiers else 0.0
        key_up = key_down + self.hold(key)
        out += [KeyAction(key_down, "down", key), KeyAction(key_up, "up", key)]
        for m in reversed(modifiers):
            up = max(
                key_down + SHIFT_MIN_AFTER_KEY,
                key_up + gaussian(self._rng, SHIFT_TRAIL_MEAN, SHIFT_TRAIL_SD),
            )
            out.append(KeyAction(up, "up", m))
        out.sort(key=lambda a: a.at)
        return out

    def plan_select_all_delete(self, modifier: str) -> List[KeyAction]:
        """Select-all with ``modifier``, then one Backspace once the modifier is up."""
        out = self.plan_chord([modifier], "a")
        a_down = next(a.at for a in out if a.type == "down" and a.key == "a")
        mod_up = next(a.at for a in out if a.type == "up" and a.key == modifier)
        bs_down = max(a_down + self.gap(Stroke("a"), Stroke("Backspace")), mod_up + SHIFT_CLEAR)
        out.append(KeyAction(bs_down, "down", "Backspace"))
        out.append(KeyAction(bs_down + self.hold("Backspace"), "up", "Backspace"))
        out.sort(key=lambda a: a.at)
        return out
