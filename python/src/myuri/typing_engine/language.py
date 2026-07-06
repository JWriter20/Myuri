"""Word difficulty classification, common bigram/trigram detection.

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

COMMON_BIGRAMS = {
    'th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd',
    'ti', 'es', 'or', 'te', 'of', 'ed', 'is', 'it', 'al', 'ar',
    'st', 'to', 'nt', 'ng', 'se', 'ha', 'as', 'ou', 'io', 'le',
    've', 'co', 'me', 'de', 'hi', 'ri', 'ro', 'ic', 'ne', 'ea',
    'ra', 'ce', 'li', 'ch', 'll', 'be', 'ma', 'si', 'om', 'ur',
    'us', 'el', 'no', 'di', 'ta', 'la', 'ge', 'wi', 'do', 'pe',
    'wa', 'sh', 'lo', 'oo', 'mo', 'ca', 'tr', 'wh', 'ni', 'so',
    'un', 'ai', 'ee', 'su', 'pr', 'fi', 'ho', 'uc', 'da', 'ac',
    'ag', 'ab', 'ad', 'fo', 'nc', 'sa', 'ec', 'we', 'po', 'em',
    'up', 'mi', 'ld', 'ie', 'op', 'rt', 'na', 'ia', 'lu', 'ow',
    'bl', 'pa', 'pl', 'ot', 'ss', 'ry', 'sc', 'tu', 'ty', 'wo',
    'id', 'am', 'ay', 'ir', 'iv', 'ke', 'ki', 'ly', 'ob', 'pi',
    'pu', 'ut', 'vi', 'ct', 'ep', 'gu', 'il', 'im', 'oi', 'ul',
    'um', 'gh', 'nk', 'ts', 'tt', 'bi', 'bu', 'ci', 'cl', 'cr',
    'cu', 'ef', 'ev', 'ex', 'fl', 'fr', 'fu', 'gi', 'gr', 'ig',
    'kn', 'mp', 'mu', 'oc', 'og', 'ok', 'ol', 'os', 'ov', 'pt',
    'qu', 'rn', 'rs', 'ru', 'sl', 'sm', 'sn', 'sp', 'sw', 'ud',
    'ug', 'va', 'wn', 'wr', 'ye', 'fe', 'ht', 'lt', 'pp', 'rr',
    'sk', 'ub', 'ue', 'aw', 'dr', 'ds', 'du', 'ew', 'ey', 'ft',
    'fy', 'ga', 'gl', 'go', 'gy', 'ip', 'ix', 'iz', 'lf', 'lk',
    'ln', 'ls', 'mb', 'mm', 'mn', 'my', 'nf', 'nm', 'nn', 'ns',
    'nu', 'ny', 'oa', 'od', 'oe', 'oh', 'oy', 'oz', 'ph', 'rb',
    'rc', 'rd', 'rf', 'rg', 'rk', 'rl', 'rm', 'rp', 'rv', 'rw',
    'sf', 'tl', 'tn', 'tw', 'uf', 'ui', 'uk', 'ys', 'ze', 'zo',
    'ws',
}

COMMON_TRIGRAMS = {
    'the', 'and', 'ing', 'her', 'hat', 'his', 'tha', 'ere', 'for', 'ent',
    'ion', 'ter', 'was', 'you', 'ith', 'ver', 'all', 'wit', 'thi', 'tio',
    'has', 'hou', 'hin', 'ght', 'one', 'our', 'out', 'rea', 'res', 'est',
    'ome', 'ave', 'not', 'but', 'can', 'had', 'com', 'pro', 'per', 'int',
    'pre', 'con', 'sta', 'str', 'ove', 'ear', 'ati', 'ess', 'ect', 'ons',
    'men', 'ble', 'ted', 'nce', 'ine', 'age', 'ack', 'ful', 'ous', 'ive',
    'rin', 'nde', 'nte', 'ill', 'ard', 'ist', 'ore', 'ame', 'ant', 'ort',
    'hen', 'hav', 'rom', 'igh', 'ain', 'ong', 'oun', 'ven', 'ene', 'ell',
    'ake', 'ide', 'lin', 'eed', 'ind', 'ose', 'uch', 'end', 'urn', 'ner',
    'ire', 'ral', 'ate', 'ies', 'tin', 'ber', 'ple', 'ish', 'ity', 'ren',
    'ure', 'ers', 'ade', 'ail', 'ald', 'ale', 'ane', 'ape', 'are', 'ark',
    'arm', 'art', 'ase', 'ast', 'eat', 'eel', 'een', 'eer', 'ern', 'ick',
    'ife', 'ild', 'ilt', 'ink', 'iss', 'ite', 'ize', 'ock', 'old', 'ole',
    'oll', 'ook', 'ool', 'oom', 'oon', 'oor', 'oot', 'ope', 'ork', 'orm',
    'orn', 'oss', 'ost', 'ote', 'oth', 'own', 'ual', 'uce', 'ude', 'uge',
    'ule', 'ull', 'ult', 'umb', 'ump', 'und', 'ung', 'unk', 'unt', 'urt',
    'use', 'ust', 'ute', 'act', 'aft', 'alk', 'amp', 'ang', 'ank', 'apt',
    'ash', 'ask', 'asp', 'ath', 'awn', 'ban', 'bed', 'ben', 'bet', 'bid',
    'bin', 'bit', 'bla', 'bor', 'bou', 'bre', 'bri', 'bro', 'cal', 'car',
    'cas', 'cat', 'cer', 'cha', 'che', 'chi', 'cla', 'cle', 'cli', 'clo',
    'col', 'cou', 'cre', 'cri', 'cro', 'dal', 'dan', 'dar', 'den', 'der',
    'din', 'dis', 'dom', 'dou', 'dra', 'dri', 'dro', 'duc', 'dul', 'ead',
    'eal', 'eam', 'ean', 'eas', 'ede', 'edi', 'eet', 'eft', 'eld', 'ele',
    'elf',
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


def is_common_bigram(char1: str, char2: str) -> bool:
    return (char1 + char2).lower() in COMMON_BIGRAMS


def is_common_trigram(char1: str, char2: str, char3: str) -> bool:
    return (char1 + char2 + char3).lower() in COMMON_TRIGRAMS
