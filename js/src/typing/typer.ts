/**
 * Human-like typing.
 *
 * Two stages:
 *  1. `MarkovTyper` (from HumanTyping, https://github.com/Lax3n/HumanTyping)
 *     decides WHAT is pressed: the target text plus neighbor-key typos, swaps
 *     and backspace corrections.
 *  2. `KeystrokeTiming` decides WHEN: a keydown/keyup timeline fitted to
 *     recorded human typing and English bigram frequencies, with explicit
 *     Shift presses and natural key overlap (rollover).
 *
 * The timeline is played on one absolute clock: each action fires at
 * `start + at`, so driver round-trips are absorbed instead of being added to
 * every gap. This module knows nothing about pages, elements or the host OS.
 *
 * Driving a browser that paces keys itself (e.g. Camoufox's humanize keyboard
 * channel) would add a second set of delays: run that channel raw.
 */

import { MarkovTyper } from './markov.js'
import type { TypingEvent } from './markov.js'
import { DEFAULT_WPM, WPM_STD } from './config.js'
import { KeystrokeTiming, charToStroke, type KeyAction, type Pauses, type Stroke } from './timing.js'
import { gaussian, defaultRng } from '../rng.js'
import type { Rng } from '../rng.js'

/**
 * Minimal keyboard-input surface the typer depends on. A browser driver, a
 * test double, or any other keystroke sink can implement this.
 */
export interface TyperInput {
  /** Press a key down without releasing it ('a', 'A', 'Shift', 'Enter', ...). */
  down(key: string): Promise<void>
  /** Release a key pressed with `down`. */
  up(key: string): Promise<void>
  /**
   * Insert text no US-layout key produces (emoji, 'é'). Without it such code
   * points are sent through `down`/`up`.
   */
  insertText?(text: string): Promise<void>
}

/** Time source for playing the timeline. Inject a virtual one in tests. */
export interface TypingClock {
  /** Monotonic milliseconds. */
  now(): number
  sleep(ms: number): Promise<void>
}

export const realClock: TypingClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export interface HumanTyperOptions {
  wpm?: number
  mistakeMultiplier?: number
  /** See `settings.typing.pauses`. */
  pauses?: Pauses
  /** Called at each character's keydown with the gap since the previous keydown. */
  onCharacter?: (char: string, delayMs: number) => void
  onMistake?: (info: { typedChar: string }) => void
  onBackspace?: () => void
  rng?: Rng
  clock?: TypingClock
}

/** What each planned stroke means, for callbacks. */
interface StrokeInfo {
  stroke: Stroke
  char: string // '' for Backspace
  event: TypingEvent
  /** Fire onMistake at this stroke's keydown (last char of an error/swap). */
  mistake: boolean
}

function flatten(history: TypingEvent[]): StrokeInfo[] {
  const out: StrokeInfo[] = []
  for (const event of history) {
    if (event.kind === 'backspace') {
      out.push({ stroke: { key: 'Backspace' }, char: '', event, mistake: false })
      continue
    }
    const chars = Array.from(event.chars)
    chars.forEach((char, i) => {
      out.push({
        stroke: charToStroke(char),
        char,
        event,
        mistake: (event.kind === 'error' || event.kind === 'swap') && i === chars.length - 1,
      })
    })
  }
  return out
}

/** A session's typing speed, drawn around `wpm`. */
export function drawSessionWpm(rng: Rng, wpm: number): number {
  return Math.max(10, gaussian(rng, wpm, WPM_STD))
}

/** What typing `text` presses (typos and corrections included) and when. */
export function planTyping(text: string, mistakeMultiplier: number, rng: Rng, timing: KeystrokeTiming) {
  const { history } = new MarkovTyper(text, mistakeMultiplier, rng).run()
  const strokes = flatten(history)
  return { strokes, ...timing.plan(strokes.map((s) => s.stroke)) }
}

export class HumanTyper {
  private input: TyperInput
  private wpm: number
  private mistakeMultiplier: number
  private onCharacterCallback?: (char: string, delayMs: number) => void
  private onMistakeCallback?: (info: { typedChar: string }) => void
  private onBackspaceCallback?: () => void
  private rng: Rng
  private clock: TypingClock
  // Per-session typing speed, sampled ONCE at construction so every field this
  // typer fills shares one natural speed.
  private sessionWpm: number
  private timing: KeystrokeTiming

  constructor(input: TyperInput, options?: HumanTyperOptions) {
    this.input = input
    this.wpm = options?.wpm ?? DEFAULT_WPM
    this.mistakeMultiplier = options?.mistakeMultiplier ?? 1.0
    this.onCharacterCallback = options?.onCharacter
    this.onMistakeCallback = options?.onMistake
    this.onBackspaceCallback = options?.onBackspace
    this.rng = options?.rng ?? defaultRng
    this.clock = options?.clock ?? realClock
    this.sessionWpm = drawSessionWpm(this.rng, this.wpm)
    this.timing = new KeystrokeTiming(this.sessionWpm, this.rng, options?.pauses)
  }

  /** Type text with human-like timing, errors, and corrections. */
  public async type(text: string): Promise<void> {
    if (!text) return
    const { strokes, actions, downAt } = planTyping(text, this.mistakeMultiplier, this.rng, this.timing)
    await this.play(actions, (a) => {
      if (a.stroke === undefined || a.type === 'up') return
      const info = strokes[a.stroke]
      const delayMs = a.stroke > 0 ? downAt[a.stroke] - downAt[a.stroke - 1] : 0
      if (info.char === '') {
        this.onBackspaceCallback?.()
        return
      }
      this.onCharacterCallback?.(info.char, delayMs)
      if (info.mistake) this.onMistakeCallback?.({ typedChar: info.event.chars })
    })
  }

  /**
   * Play a timeline on the absolute clock. If the input throws, every key
   * still held is released before the error propagates.
   */
  private async play(actions: KeyAction[], onAction?: (a: KeyAction) => void): Promise<void> {
    const start = this.clock.now()
    const held = new Set<string>()
    try {
      for (const a of actions) {
        const wait = start + a.at - this.clock.now()
        if (wait > 0) await this.clock.sleep(wait)
        if (a.type === 'down') {
          await this.input.down(a.key)
          held.add(a.key)
        } else if (a.type === 'up') {
          await this.input.up(a.key)
          held.delete(a.key)
        } else if (this.input.insertText) {
          await this.input.insertText(a.key)
        } else {
          await this.input.down(a.key)
          await this.input.up(a.key)
        }
        onAction?.(a)
      }
    } finally {
      for (const key of held) await this.input.up(key).catch(() => {})
    }
  }

  /**
   * Delete text. With a `selectAllModifier` (e.g. 'Control' or 'Meta' — the
   * caller decides, no platform sniffing here) we hold it, press 'a', release,
   * then press Backspace once. Otherwise we press Backspace `count` times.
   */
  public async deleteAll(options: { count: number; selectAllModifier?: string }): Promise<void> {
    const { count, selectAllModifier } = options
    if (selectAllModifier) {
      await this.play(this.timing.planSelectAllDelete(selectAllModifier))
      return
    }
    if (count <= 0) return
    const strokes: Stroke[] = Array.from({ length: count }, () => ({ key: 'Backspace' }))
    await this.play(this.timing.plan(strokes).actions)
  }

  /**
   * Update the typing speed (words per minute). Re-rolls the per-session speed
   * around the new target.
   */
  public setWpm(wpm: number): void {
    this.wpm = wpm
    this.sessionWpm = drawSessionWpm(this.rng, this.wpm)
    this.timing.setWpm(this.sessionWpm)
  }

  /** Get current WPM setting. */
  public getWpm(): number {
    return this.wpm
  }

  /** Update the mistake multiplier (0 = no mistakes, 1 = default, >1 = more). */
  public setMistakeMultiplier(mult: number): void {
    this.mistakeMultiplier = mult
  }

  /** Get current mistake multiplier. */
  public getMistakeMultiplier(): number {
    return this.mistakeMultiplier
  }
}
