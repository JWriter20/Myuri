"""Keyboard layout model for neighbor-key typo lookups.

Ported from HumanTyping (https://github.com/Lax3n/HumanTyping) via the
TypeScript reference implementation (js/src/typing/keyboard.ts).
"""

from __future__ import annotations

import unicodedata
from typing import Callable, Dict, List, Set, Tuple

Rng = Callable[[], float]


def _strip_combining_marks(text: str) -> str:
    """NFD-normalize and drop combining marks in U+0300..U+036F.

    Mirrors the TS ``normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')``.
    """
    return "".join(
        ch
        for ch in unicodedata.normalize("NFD", text)
        if not ("\u0300" <= ch <= "\u036f")
    )


class KeyboardLayout:
    def __init__(self) -> None:
        self._grid = [
            list("`1234567890-="),
            list("qwertyuiop[]\\"),
            list("asdfghjkl;'"),
            list("zxcvbnm,./"),
        ]
        self._pos_map = self._build_pos_map()
        self._direct_accents: Set[str] = set()
        self._composed_accents: Set[str] = set("âêîôûäëïöüéèàùç")

    def _build_pos_map(self) -> Dict[str, Tuple[int, int]]:
        mapping: Dict[str, Tuple[int, int]] = {}
        for r, row in enumerate(self._grid):
            for c, char in enumerate(row):
                mapping[char] = (r, c)
        return mapping

    def _normalize_char(self, char: str) -> str:
        char = char.lower()
        if char in self._composed_accents:
            return _strip_combining_marks(char)
        return char

    def has_key(self, char: str) -> bool:
        return self._normalize_char(char) in self._pos_map

    def get_neighbor_keys(self, char: str) -> List[str]:
        normalized = self._normalize_char(char)
        pos = self._pos_map.get(normalized)
        if pos is None:
            return []

        r, c = pos
        neighbors: List[str] = []
        deltas = [
            (-1, -1), (-1, 0), (-1, 1),
            (0, -1),           (0, 1),
            (1, -1),  (1, 0),  (1, 1),
        ]

        for dr, dc in deltas:
            nr = r + dr
            nc = c + dc
            if 0 <= nr < len(self._grid) and 0 <= nc < len(self._grid[nr]):
                neighbors.append(self._grid[nr][nc])

        return neighbors

    def get_random_neighbor(self, char: str, rng: Rng) -> str:
        was_upper = char == char.upper() and char != char.lower()
        neighbors = self.get_neighbor_keys(char)

        if not neighbors:
            flat = [key for row in self._grid for key in row]
            result = flat[int(rng() * len(flat))]
        else:
            result = neighbors[int(rng() * len(neighbors))]

        return result.upper() if was_upper else result

    def is_direct_accent(self, char: str) -> bool:
        return char.lower() in self._direct_accents

    def is_composed_accent(self, char: str) -> bool:
        return char.lower() in self._composed_accents
