/**
 * Markov chain-based typing simulation engine.
 * Ported from HumanTyping (https://github.com/Lax3n/HumanTyping)
 *
 * Models realistic human typing with:
 * - Variable speed based on word complexity and key distance
 * - Neighbor-key errors and character swap errors
 * - Probabilistic error detection and backspace correction
 * - Fatigue over longer texts
 * - Natural pauses at word boundaries
 *
 * The engine is driver-agnostic: it produces a stream of structured
 * `TypingEvent`s that a consumer (see `HumanTyper`) replays against some
 * input surface. It never touches a browser or the DOM.
 */

import {
  DEFAULT_WPM, WPM_STD, AVG_WORD_LENGTH,
  PROB_ERROR, PROB_SWAP_ERROR, PROB_NOTICE_ERROR,
  SPEED_BOOST_COMMON_WORD, SPEED_PENALTY_COMPLEX_WORD,
  SPEED_BOOST_CLOSE_KEYS, SPEED_BOOST_BIGRAM, SPEED_BOOST_TRIGRAM,
  SPEED_BOOST_SPACE,
  TIME_KEYSTROKE_STD, TIME_BACKSPACE_MEAN, TIME_BACKSPACE_STD,
  TIME_REACTION_MEAN, TIME_REACTION_STD,
  TIME_DIRECT_ACCENT_PENALTY, TIME_COMPOSED_ACCENT_PENALTY,
  TIME_UPPERCASE_PENALTY,
  FATIGUE_FACTOR, FATIGUE_CAP,
  DRIFT_CORRECTION_PROB, COMPLEX_WORD_ERROR_MULT,
  COMMON_WORD_ERROR_MULT, COMPOSED_ACCENT_ERROR_MULT,
  FAR_KEY_PENALTY, FAR_KEY_THRESHOLD, CLOSE_KEY_THRESHOLD,
  MIN_KEYSTROKE_TIME, MIN_REACTION_TIME, MIN_BACKSPACE_TIME,
  MIN_SPEED_MULTIPLIER
} from './config.js'
import { KeyboardLayout } from './keyboard.js'
import { getWordDifficulty, isCommonBigram, isCommonTrigram } from './language.js'
import { gaussian } from '../rng.js'
import type { Rng } from '../rng.js'

/**
 * A single modeled typing action. `chars` holds the literal code point(s)
 * produced (empty for a backspace); `dtMs` is the time to wait for this
 * action, in milliseconds (already inclusive of any reaction pause). Consumers
 * dispatch on `kind` — no string parsing required.
 */
export type TypingEvent = {
  kind: 'type' | 'error' | 'swap' | 'backspace' | 'correct'
  chars: string
  dtMs: number
}

// Word-boundary code points that trigger a strict correction check.
const WORD_BOUNDARY_CHARS = ' \n\t.,;!?:()[]{}<>"\''

interface TypingState {
  currentText: string[] // typed code points so far
  totalTime: number // seconds
  history: TypingEvent[]
  lastCharTyped: string | null
  lastKind: TypingEvent['kind'] | null
  fatigueMultiplier: number
  mentalCursorPos: number // index into targetChars (code points)
}

export class MarkovTyper {
  private targetText: string
  private targetChars: string[] // target as an array of code points
  private keyboard: KeyboardLayout
  private state: TypingState
  private baseKeystrokeTime: number
  private mistakeMultiplier: number
  private rng: Rng

  constructor(
    targetText: string,
    targetWpm: number = DEFAULT_WPM,
    layout: string = 'qwerty',
    mistakeMultiplier: number = 1.0,
    rng: Rng,
    // Pre-resolved per-session WPM. When provided (e.g. sampled once by the
    // HumanTyper so every field shares one speed), it is used directly instead
    // of drawing a fresh N(targetWpm, WPM_STD) sample per instance.
    sessionWpm?: number
  ) {
    if (!targetText || targetText.length === 0) {
      throw new Error('targetText must be a non-empty string')
    }
    if (targetWpm <= 0) {
      throw new Error('targetWpm must be a positive number')
    }

    this.targetText = targetText
    // Iterate by code point so astral chars (emoji, CJK extension) count as one
    // unit and are never split into lone surrogates.
    this.targetChars = Array.from(targetText)
    this.keyboard = new KeyboardLayout(layout)
    this.mistakeMultiplier = mistakeMultiplier
    this.rng = rng

    const resolvedWpm = sessionWpm !== undefined
      ? Math.max(10, sessionWpm)
      : Math.max(10, gaussian(this.rng, targetWpm, WPM_STD))
    this.baseKeystrokeTime = 60 / (resolvedWpm * AVG_WORD_LENGTH)

    this.state = this.freshState()
  }

  private freshState(): TypingState {
    return {
      currentText: [],
      totalTime: 0,
      history: [],
      lastCharTyped: null,
      lastKind: null,
      fatigueMultiplier: 1.0,
      mentalCursorPos: 0
    }
  }

  private currentString(): string {
    return this.state.currentText.join('')
  }

  private isComplete(): boolean {
    return this.currentString() === this.targetText
  }

  private getCurrentWordContext(): string | null {
    const idx = this.state.mentalCursorPos
    if (idx >= this.targetChars.length) return null

    let start = idx
    while (start > 0 && this.targetChars[start - 1] !== ' ') start--
    let end = idx
    while (end < this.targetChars.length && this.targetChars[end] !== ' ') end++

    return this.targetChars.slice(start, end).join('')
  }

  private calculateKeystrokeTime(charToType: string): number {
    let keystrokeTime = this.baseKeystrokeTime * this.state.fatigueMultiplier

    const currentWord = this.getCurrentWordContext()
    if (currentWord) {
      const difficulty = getWordDifficulty(currentWord)
      if (difficulty === 'common') {
        keystrokeTime *= SPEED_BOOST_COMMON_WORD
      } else if (difficulty === 'complex') {
        keystrokeTime *= SPEED_PENALTY_COMPLEX_WORD
      }
    }

    if (this.state.lastCharTyped) {
      let sequenceBoost = false
      const len = this.state.currentText.length

      // Trigram boost (strongest — we're mid-flow in a common sequence)
      if (len >= 2) {
        const c1 = this.state.currentText[len - 2]
        const c2 = this.state.currentText[len - 1]
        if (isCommonTrigram(c1, c2, charToType)) {
          keystrokeTime *= SPEED_BOOST_TRIGRAM
          sequenceBoost = true
        }
      }

      // Bigram boost
      if (!sequenceBoost && isCommonBigram(this.state.lastCharTyped, charToType)) {
        keystrokeTime *= SPEED_BOOST_BIGRAM
        sequenceBoost = true
      }

      // Fall back to distance-based adjustments
      if (!sequenceBoost) {
        const dist = this.keyboard.getDistance(this.state.lastCharTyped, charToType)
        if (dist > 0 && dist < CLOSE_KEY_THRESHOLD) {
          keystrokeTime *= SPEED_BOOST_CLOSE_KEYS
        } else if (dist > FAR_KEY_THRESHOLD) {
          keystrokeTime *= FAR_KEY_PENALTY
        }
      }
    }

    if (charToType === ' ') {
      keystrokeTime *= SPEED_BOOST_SPACE // Space is fast — thumb key, always hovering
    } else if (this.keyboard.isComposedAccent(charToType)) {
      keystrokeTime += TIME_COMPOSED_ACCENT_PENALTY
    } else if (this.keyboard.isDirectAccent(charToType)) {
      keystrokeTime += TIME_DIRECT_ACCENT_PENALTY
    } else if (charToType !== charToType.toLowerCase()) {
      keystrokeTime += TIME_UPPERCASE_PENALTY
    }

    // Apply floor to prevent unrealistic stacking of boosts
    keystrokeTime = Math.max(MIN_SPEED_MULTIPLIER * this.baseKeystrokeTime, keystrokeTime)

    const dt = gaussian(this.rng, keystrokeTime, TIME_KEYSTROKE_STD)
    return Math.max(MIN_KEYSTROKE_TIME, dt)
  }

  private bumpFatigue(): void {
    this.state.fatigueMultiplier = Math.min(
      FATIGUE_CAP,
      this.state.fatigueMultiplier * FATIGUE_FACTOR
    )
  }

  /**
   * Time (seconds) for a single keystroke. `literal` keys (code points not on
   * the layout) use the plain base timing — no bigram/distance/accent modeling.
   */
  private keystrokeDt(char: string, literal: boolean): number {
    if (literal) {
      const base = this.baseKeystrokeTime * this.state.fatigueMultiplier
      return Math.max(MIN_KEYSTROKE_TIME, gaussian(this.rng, base, TIME_KEYSTROKE_STD))
    }
    return this.calculateKeystrokeTime(char)
  }

  /**
   * Advance the simulation by one typed code point: bump fatigue, sample the
   * keystroke time, append the char, and move the mental cursor. Returns the
   * sampled dt in seconds. Shared by every keystroke path so fatigue is applied
   * exactly once per emitted character (including inside swaps).
   */
  private advanceChar(char: string, literal: boolean): number {
    this.bumpFatigue()
    const dt = this.keystrokeDt(char, literal)
    this.state.totalTime += dt
    this.state.currentText.push(char)
    this.state.lastCharTyped = char
    this.state.mentalCursorPos += 1
    return dt
  }

  /** Emit a single-keystroke event (type / error / correct). */
  private emitKeystroke(
    char: string,
    kind: 'type' | 'error' | 'correct',
    literal = false
  ): TypingEvent {
    const dt = this.advanceChar(char, literal)
    const event: TypingEvent = { kind, chars: char, dtMs: dt * 1000 }
    this.state.history.push(event)
    this.state.lastKind = kind
    return event
  }

  step(): TypingEvent | null {
    // Check for completion
    if (this.isComplete()) return null

    const currentLen = this.state.currentText.length

    // --- MONITORING & CORRECTION PHASE ---

    // Calculate divergence point
    let firstErrorPos = this.targetChars.length
    const minLen = Math.min(currentLen, this.targetChars.length)
    for (let i = 0; i < minLen; i++) {
      if (this.state.currentText[i] !== this.targetChars[i]) {
        firstErrorPos = i
        break
      }
    }

    // Over-typing past the target counts as an error to be corrected.
    if (currentLen > this.targetChars.length && firstErrorPos === this.targetChars.length) {
      firstErrorPos = this.targetChars.length
    }

    // Do we have an error?
    if (firstErrorPos < currentLen) {
      let shouldCorrect = false
      const wasBackspacing = this.state.lastKind === 'backspace'

      // Case 0: CONTINUED BACKSPACING (Critical)
      if (wasBackspacing) {
        shouldCorrect = true
      }
      // Case A: End of text (Always correct)
      else if (this.state.mentalCursorPos >= this.targetChars.length) {
        shouldCorrect = true
      }
      // Case B: End of Word / Context Check
      else if (currentLen > 0) {
        const lastChar = this.state.currentText[currentLen - 1]
        const distance = currentLen - firstErrorPos

        // Check at word boundaries (Strict)
        if (WORD_BOUNDARY_CHARS.includes(lastChar)) {
          shouldCorrect = true
        }
        // Drift Check (Don't let errors linger)
        else if (distance >= 2) {
          if (this.rng() < DRIFT_CORRECTION_PROB) {
            shouldCorrect = true
          }
        }
        // Immediate reaction (1 char past error)
        else if (distance === 1) {
          if (this.rng() < PROB_NOTICE_ERROR) {
            shouldCorrect = true
          }
        }
      }

      if (shouldCorrect) {
        let dtTotal = 0
        // Reaction time (only if we weren't already backspacing)
        if (!wasBackspacing) {
          dtTotal += Math.max(
            MIN_REACTION_TIME,
            gaussian(this.rng, TIME_REACTION_MEAN, TIME_REACTION_STD)
          )
        }

        // Perform Backspace
        dtTotal += Math.max(
          MIN_BACKSPACE_TIME,
          gaussian(this.rng, TIME_BACKSPACE_MEAN, TIME_BACKSPACE_STD)
        )
        this.state.totalTime += dtTotal
        this.state.currentText.pop()

        const event: TypingEvent = { kind: 'backspace', chars: '', dtMs: dtTotal * 1000 }
        this.state.history.push(event)
        this.state.lastKind = 'backspace'

        // Sync mental cursor immediately
        this.state.mentalCursorPos = this.state.currentText.length
        return event
      }
    }

    // --- TYPING PHASE ---

    // Sync mental cursor if we backspaced (redundant safety)
    if (this.state.mentalCursorPos > this.state.currentText.length) {
      this.state.mentalCursorPos = this.state.currentText.length
    }

    if (this.state.mentalCursorPos >= this.targetChars.length) return null

    const charIntended = this.targetChars[this.state.mentalCursorPos]

    // If the character is not on our keyboard, type it literally (no error modeling)
    if (!this.keyboard.hasKey(charIntended) && charIntended !== ' ') {
      return this.emitKeystroke(charIntended, 'type', /* literal */ true)
    }

    // Swap Error (Anticipation): e.g. "the" -> "hte"
    if (this.targetChars.length > this.state.mentalCursorPos + 1) {
      const charAfter = this.targetChars[this.state.mentalCursorPos + 1]
      if (charAfter !== ' ' && charAfter !== charIntended) {
        if (this.rng() < Math.min(1, PROB_SWAP_ERROR * this.mistakeMultiplier)) {
          const dt1 = this.advanceChar(charAfter, false)
          const dt2 = this.advanceChar(charIntended, false)
          const event: TypingEvent = {
            kind: 'swap',
            chars: charAfter + charIntended,
            dtMs: (dt1 + dt2) * 1000
          }
          this.state.history.push(event)
          this.state.lastKind = 'swap'
          return event
        }
      }
    }

    // Normal Typing (Success or Error)
    let currentProbError = PROB_ERROR * this.mistakeMultiplier
    const wordDiff = getWordDifficulty(this.getCurrentWordContext() || '')
    if (wordDiff === 'complex') {
      currentProbError *= COMPLEX_WORD_ERROR_MULT
    } else if (wordDiff === 'common') {
      currentProbError *= COMMON_WORD_ERROR_MULT
    }
    if (this.keyboard.isComposedAccent(charIntended)) {
      currentProbError *= COMPOSED_ACCENT_ERROR_MULT
    }
    // Clamp: PROB_ERROR * mult * COMPLEX_WORD_ERROR_MULT can exceed 1.
    currentProbError = Math.min(1, currentProbError)

    if (this.rng() < currentProbError) {
      // Generate Error (neighbor-key slip)
      const wrongChar = this.keyboard.getRandomNeighbor(charIntended, this.rng)
      return this.emitKeystroke(wrongChar, 'error')
    }

    // Success
    return this.emitKeystroke(charIntended, 'type')
  }

  /** Step until completion or until `budget` steps elapse. */
  private runSteps(budget: number): void {
    let steps = 0
    while (this.step() !== null) {
      steps++
      if (steps > budget) break
    }
  }

  /**
   * Deterministic safety net (BUG FIX): discard the diverged simulation and
   * type the exact target, one correctly-typed code point at a time. Guarantees
   * the emitted history reconstructs to the target so the consumer never
   * replays text that doesn't match.
   */
  private emitCorrectTyping(): void {
    this.state = this.freshState()
    for (const char of this.targetChars) {
      const literal = !this.keyboard.hasKey(char) && char !== ' '
      this.emitKeystroke(char, 'correct', literal)
    }
  }

  run(): { totalTime: number; history: TypingEvent[] } {
    const budget = this.targetChars.length * 10
    this.runSteps(budget)

    // The step cap can leave currentText != target. Never emit a history that
    // reconstructs to the wrong text: extend the budget once, then fall back to
    // a deterministic correct-typing pass.
    if (!this.isComplete()) {
      this.runSteps(budget)
    }
    if (!this.isComplete()) {
      this.emitCorrectTyping()
    }

    return { totalTime: this.state.totalTime, history: this.state.history }
  }
}
