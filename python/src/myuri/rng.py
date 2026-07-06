"""Seeded random number generator for reproducible cursor behavior.

Mulberry32 — a small, fast 32-bit PRNG, bit-for-bit compatible with the
TypeScript implementation (``js/src/rng.ts``). The same seed produces the
exact same stream in both languages, so passing the same seed yields
identical mouse movements, scrolls, typing rhythm, and starting position.
"""
from __future__ import annotations

import math
import random
from typing import Callable

Rng = Callable[[], float]
"""A zero-argument callable returning a float in ``[0, 1)``."""

_MASK32 = 0xFFFFFFFF

# The smallest positive JS number (Number.MIN_VALUE, a subnormal double).
_JS_NUMBER_MIN_VALUE = 5e-324


class SeededRng:
    """Mulberry32 PRNG. Same seed -> same sequence (matching JS exactly).

    All arithmetic is performed modulo 2**32, replicating JavaScript's
    ``Math.imul``, ``>>>``, and 32-bit coercion semantics; results agree
    with the TS reference to the last bit.
    """

    def __init__(self, seed: int) -> None:
        # Use the seed verbatim (mod 2^32), mirroring JS `seed >>> 0`.
        # Mulberry32 is non-degenerate at state 0 because the first step
        # adds the odd increment 0x6D2B79F5.
        self._state = int(seed) & _MASK32

    def next(self) -> float:
        """Return the next float in ``[0, 1)``."""
        self._state = (self._state + 0x6D2B79F5) & _MASK32
        t = self._state
        # JS: t = Math.imul(t ^ (t >>> 15), t | 1)
        t = ((t ^ (t >> 15)) * (t | 1)) & _MASK32
        # JS: t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & _MASK32)) & _MASK32
        t &= _MASK32
        # JS: ((t ^ (t >>> 14)) >>> 0) / 4294967296
        return ((t ^ (t >> 14)) & _MASK32) / 4294967296.0


def generate_random_seed() -> int:
    """Generate a fresh random 32-bit seed.

    This is the only place the ambient ``random`` module is used to *create*
    randomness inside the library (besides :data:`default_rng`).
    """
    return int(random.random() * 0x100000000) & _MASK32


def make_rng(seed: int) -> Rng:
    """Create an :data:`Rng` function from a seed. Same seed -> same sequence."""
    r = SeededRng(seed)
    return r.next


def gaussian(rng: Rng, mean: float = 0.0, std: float = 1.0) -> float:
    """A Gaussian sample via the Box-Muller transform.

    ``u1`` is nudged off exactly 0 so ``log(0)`` can never raise/return -inf.
    """
    u1 = rng() or _JS_NUMBER_MIN_VALUE
    u2 = rng()
    z = math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)
    return mean + z * std


def _default_rng() -> float:
    return random.random()


default_rng: Rng = _default_rng
"""Fallback Rng used only when a caller constructs a helper without threading a
seeded Rng. The Cursor always injects its own seeded Rng, so reproducible runs
never touch this."""
