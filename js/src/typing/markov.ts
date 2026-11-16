/**
 * Markov chain-based typing simulation engine.
 * Ported from HumanTyping (https://github.com/Lax3n/HumanTyping)
 *
 * Decides WHAT a person types on the way to the target text:
 * - Neighbor-key errors and character swap errors
 * - Probabilistic error detection and backspace correction
 *
 * It has no notion of time: `timing.ts` schedules the resulting keys. The
 * engine is driver-agnostic and never touches a browser or the DOM.
 */

import {
  PROB_ERROR, PROB_SWAP_ERROR, PROB_NOTICE_ERROR,
  DRIFT_CORRECTION_PROB, COMPLEX_WORD_ERROR_MULT,
  COMMON_WORD_ERROR_MULT, COMPOSED_ACCENT_ERROR_MULT,
} from './config.js'
import { KeyboardLayout } from './keyboard.js'
import { getWordDifficulty } from './language.js'
import type { Rng } from '../rng.js'

/**
 * A single modeled typing action. `chars` holds the literal code point(s)
 * produced (empty for a backspace; two for a swap). Consumers dispatch on
 * `kind` — no string parsing required.
 */
export type TypingEvent = {
  kind: 'type' | 'error' | 'swap' | 'backspace' | 'correct'
  chars: string
}

// Word-boundary code points that trigger a strict correction check.
const WORD_BOUNDARY_CHARS = ' \n\t.,;!?:()[]{}<>"\''

interface TypingState {
  currentText: string[] // typed code points so far
  history: TypingEvent[]
  lastKind: TypingEvent['kind'] | null
  mentalCursorPos: number // index into targetChars (code points)
}

export class MarkovTyper {
  private targetText: string
  private targetChars: string[] // target as an array of code points
  private keyboard: KeyboardLayout
  private state: TypingState
  private mistakeMultiplier: number
  private rng: Rng

  constructor(targetText: string, mistakeMultiplier: number = 1.0, rng: Rng) {
    if (!targetText || targetText.length === 0) {
      throw new Error('targetText must be a non-empty string')
    }

    this.targetText = targetText
    // Iterate by code point so astral chars (emoji, CJK extension) count as one
    // unit and are never split into lone surrogates.
    this.targetChars = Array.from(targetText)
    this.keyboard = new KeyboardLayout()
    this.mistakeMultiplier = mistakeMultiplier
    this.rng = rng
    this.state = this.freshState()
  }

  private freshState(): TypingState {
    return {
      currentText: [],
      history: [],
      lastKind: null,
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

  /** Append a typed code point and move the mental cursor. */
  private advanceChar(char: string): void {
    this.state.currentText.push(char)
    this.state.mentalCursorPos += 1
  }

  /** Emit a single-keystroke event (type / error / correct). */
  private emitKeystroke(char: string, kind: 'type' | 'error' | 'correct'): TypingEvent {
    this.advanceChar(char)
    const event: TypingEvent = { kind, chars: char }
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
        this.state.currentText.pop()

        const event: TypingEvent = { kind: 'backspace', chars: '' }
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
      return this.emitKeystroke(charIntended, 'type')
    }

    // Swap Error (Anticipation): e.g. "the" -> "hte"
    if (this.targetChars.length > this.state.mentalCursorPos + 1) {
      const charAfter = this.targetChars[this.state.mentalCursorPos + 1]
      if (charAfter !== ' ' && charAfter !== charIntended) {
        if (this.rng() < Math.min(1, PROB_SWAP_ERROR * this.mistakeMultiplier)) {
          this.advanceChar(charAfter)
          this.advanceChar(charIntended)
          const event: TypingEvent = { kind: 'swap', chars: charAfter + charIntended }
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
    for (const char of this.targetChars) this.emitKeystroke(char, 'correct')
  }

  run(): { history: TypingEvent[] } {
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

    return { history: this.state.history }
  }
}
