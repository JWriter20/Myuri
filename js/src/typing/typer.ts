/**
 * Human-like typing powered by a Markov chain simulation.
 * Based on HumanTyping (https://github.com/Lax3n/HumanTyping)
 *
 * Models variable speed, neighbor-key errors, character swaps, probabilistic
 * correction, fatigue, and natural pauses. This module is fully decoupled from
 * any browser driver: it drives a minimal keyboard-input surface (`TyperInput`)
 * and knows nothing about pages, elements, or `process.platform`.
 */

import { MarkovTyper } from './markov.js'
import type { TypingEvent } from './markov.js'
import { DEFAULT_WPM, WPM_STD } from './config.js'
import { gaussian, defaultRng } from '../rng.js'
import type { Rng } from '../rng.js'

/**
 * Minimal keyboard-input surface the typer depends on. A browser driver, a
 * test double, or any other keystroke sink can implement this.
 */
export interface TyperInput {
  press(key: string, options?: { delay?: number }): Promise<void>
  down(key: string): Promise<void>
  up(key: string): Promise<void>
}

export interface HumanTyperOptions {
  wpm?: number
  layout?: 'qwerty' | 'azerty'
  mistakeMultiplier?: number
  onCharacter?: (char: string, delayMs: number) => void
  onMistake?: (info: { typedChar: string }) => void
  onBackspace?: () => void
  rng?: Rng
}

/**
 * Map a typed code point to the key name `TyperInput.press` expects. Control
 * characters have no printable key, so they are translated to their named
 * equivalents; every other printable code point passes through unchanged.
 */
function charToKey(char: string): string {
  switch (char) {
    case '\n':
      return 'Enter'
    case '\t':
      return 'Tab'
    default:
      return char
  }
}

export class HumanTyper {
  private input: TyperInput
  private wpm: number
  private layout: 'qwerty' | 'azerty'
  private mistakeMultiplier: number
  private onCharacterCallback?: (char: string, delayMs: number) => void
  private onMistakeCallback?: (info: { typedChar: string }) => void
  private onBackspaceCallback?: () => void
  private rng: Rng
  // Per-session typing speed, sampled ONCE at construction so every field this
  // typer fills shares one natural speed. A real user doesn't re-roll their WPM
  // between form fields; MarkovTyper used to resample per field, which this fixes.
  private sessionWpm: number

  constructor(input: TyperInput, options?: HumanTyperOptions) {
    this.input = input
    this.wpm = options?.wpm ?? DEFAULT_WPM
    this.layout = options?.layout ?? 'qwerty'
    this.mistakeMultiplier = options?.mistakeMultiplier ?? 1.0
    this.onCharacterCallback = options?.onCharacter
    this.onMistakeCallback = options?.onMistake
    this.onBackspaceCallback = options?.onBackspace
    this.rng = options?.rng ?? defaultRng
    this.sessionWpm = Math.max(10, gaussian(this.rng, this.wpm, WPM_STD))
  }

  /**
   * Type text with human-like timing, errors, and corrections using the Markov
   * chain simulation engine. The modeled inter-key delay is the single source
   * of truth for timing: we sleep it, then press the key WITHOUT an extra hold
   * delay (fixes the old double-counting that slowed real WPM).
   */
  public async type(text: string): Promise<void> {
    if (!text) return

    // Run the full simulation upfront to get the event timeline.
    const typer = new MarkovTyper(
      text,
      this.wpm,
      this.layout,
      this.mistakeMultiplier,
      this.rng,
      this.sessionWpm
    )
    const { history } = typer.run()

    for (const event of history) {
      await this.dispatch(event)
    }
  }

  private async dispatch(event: TypingEvent): Promise<void> {
    const delayMs = event.dtMs
    if (delayMs > 0) {
      await this.sleep(delayMs)
    }

    switch (event.kind) {
      case 'backspace':
        await this.input.press('Backspace')
        this.onBackspaceCallback?.()
        return

      case 'swap':
        for (const char of event.chars) {
          await this.input.press(charToKey(char))
          this.onCharacterCallback?.(char, delayMs)
        }
        this.onMistakeCallback?.({ typedChar: event.chars })
        return

      case 'error':
        await this.input.press(charToKey(event.chars))
        this.onMistakeCallback?.({ typedChar: event.chars })
        this.onCharacterCallback?.(event.chars, delayMs)
        return

      case 'type':
      case 'correct':
        for (const char of event.chars) {
          await this.input.press(charToKey(char))
          this.onCharacterCallback?.(char, delayMs)
        }
        return
    }
  }

  /**
   * Delete text. With a `selectAllModifier` (e.g. 'Control' or 'Meta' — the
   * caller decides, no platform sniffing here) we hold it, press 'a', release,
   * then press Backspace once. Otherwise we press Backspace `count` times.
   */
  public async deleteAll(options: {
    count: number
    selectAllModifier?: string
  }): Promise<void> {
    const { count, selectAllModifier } = options

    if (selectAllModifier) {
      await this.input.down(selectAllModifier)
      await this.input.press('a')
      await this.input.up(selectAllModifier)
      await this.input.press('Backspace')
      return
    }

    for (let i = 0; i < count; i++) {
      await this.input.press('Backspace')
    }
  }

  /**
   * Update the typing speed (words per minute). Re-rolls the per-session speed
   * around the new target.
   */
  public setWpm(wpm: number): void {
    this.wpm = wpm
    this.sessionWpm = Math.max(10, gaussian(this.rng, this.wpm, WPM_STD))
  }

  /** Get current WPM setting. */
  public getWpm(): number {
    return this.wpm
  }

  /**
   * Update the mistake multiplier (0 = no mistakes, 1 = default, >1 = more).
   */
  public setMistakeMultiplier(mult: number): void {
    this.mistakeMultiplier = mult
  }

  /** Get current mistake multiplier. */
  public getMistakeMultiplier(): number {
    return this.mistakeMultiplier
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
