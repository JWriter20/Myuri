"""Word difficulty classification (common / normal / complex words).

Ported from HumanTyping (https://github.com/Lax3n/HumanTyping) via the
TypeScript reference implementation (js/src/typing/language.ts).
Extended with comprehensive frequency data.

The sets below are deduplicated frequency lists (order is informational
only; membership is what matters).
"""

from __future__ import annotations

COMMON_WORDS = {
    'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'it',
    'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this',
    'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or',
    'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so',
    'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when',
    'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take', 'people',
    'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other', 'than',
    'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back',
    'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way', 'even',
    'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us', 'great',
    'been', 'has', 'had', 'was', 'were', 'are', 'did', 'find', 'here', 'thing',
    'many', 'much', 'long', 'too', 'same', 'right', 'old', 'big', 'little', 'world',
    'school', 'still', 'try', 'last', 'ask', 'need', 'hand', 'high', 'keep', 'place',
    'start', 'far', 'turn', 'away', 'off', 'left', 'while', 'might', 'again', 'does',
    'man', 'call', 'house', 'point', 'being', 'end', 'help', 'show', 'why', 'home',
    'kind', 'read', 'life', 'run', 'move', 'live', 'play', 'open', 'let', 'put',
    'set', 'late', 'three', 'four', 'five', 'small', 'large', 'part', 'made', 'men',
    'few', 'next', 'found', 'name', 'word', 'close', 'city', 'side', 'along', 'under',
    'went', 'got', 'near', 'real', 'money', 'both', 'head', 'white', 'line', 'state',
    'night', 'sure', 'began', 'once', 'change', 'water', 'face', 'door', 'since', 'used',
    'best', 'until', 'more', 'where', 'going', 'really', 'done', 'enough', 'yet', 'another',
    'upon', 'saw', 'around', 'always', 'together', 'often', 'those', 'own', 'very', 'down',
    'such', 'each', 'every', 'before', 'must', 'through', 'between', 'should', 'may', 'tell',
    'never', 'stop', 'mean', 'hard', 'hold', 'full', 'seem', 'light', 'hear', 'second',
    'room', 'body', 'young', 'group', 'without', 'leave', 'table', 'number', 'story', 'above',
    'below', 'care', 'class', 'early', 'feel', 'girl', 'boy', 'love', 'food', 'book',
    'form', 'able', 'idea', 'free', 'less', 'case', 'eye', 'game', 'air', 'ago',
    'half', 'power', 'plan', 'week', 'today', 'true',
}

_PUNCTUATION_CHARS = set(".,!?;:'\"-()[]{}/")

_COMPLEX_CHARS = set("zxqj")


def _strip_punctuation(word: str) -> str:
    start = 0
    end = len(word) - 1
    while start <= end and word[start] in _PUNCTUATION_CHARS:
        start += 1
    while end >= start and word[end] in _PUNCTUATION_CHARS:
        end -= 1
    return word[start:end + 1]


def get_word_difficulty(word: str) -> str:
    """Classify a word as 'common', 'complex', or 'normal'."""
    word_lower = _strip_punctuation(word.lower())

    if word_lower in COMMON_WORDS:
        return 'common'

    is_long = len(word_lower) > 8
    has_complex_chars = any(ch in _COMPLEX_CHARS for ch in word_lower)

    if is_long or has_complex_chars:
        return 'complex'
    return 'normal'

