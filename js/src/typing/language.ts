/**
 * Word difficulty classification (drives how often a word is mistyped).
 * Ported from HumanTyping (https://github.com/Lax3n/HumanTyping).
 * Key timing uses measured bigram frequencies instead (`timing.ts`).
 */

const COMMON_WORDS = new Set([
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
  'half', 'power', 'plan', 'week', 'today', 'true'
])

const PUNCTUATION_CHARS = new Set('.,!?;:\'"-()[]{}/')

function stripPunctuation(word: string): string {
  let start = 0
  let end = word.length - 1
  while (start <= end && PUNCTUATION_CHARS.has(word[start])) start++
  while (end >= start && PUNCTUATION_CHARS.has(word[end])) end--
  return word.slice(start, end + 1)
}

export function getWordDifficulty(word: string): 'common' | 'complex' | 'normal' {
  const wordLower = stripPunctuation(word.toLowerCase())

  if (COMMON_WORDS.has(wordLower)) return 'common'

  const isLong = wordLower.length > 8
  const hasComplexChars = /[zxqj]/.test(wordLower)

  if (isLong || hasComplexChars) return 'complex'
  return 'normal'
}
