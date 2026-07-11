import { describe, it, expect } from 'vitest'
import { HumanTyper, type TyperInput } from '../src/typing/typer.js'
import { makeRng } from '../src/rng.js'
import { Cursor } from '../src/cursor.js'
import { defineDriver, type Driver, type PageFunction } from '../src/drivers/types.js'

function recordingInput(): { input: TyperInput; keys: string[] } {
  const keys: string[] = []
  const input: TyperInput = {
    async press(key) {
      keys.push(key)
    },
    async down(key) {
      keys.push(`down:${key}`)
    },
    async up(key) {
      keys.push(`up:${key}`)
    },
  }
  return { input, keys }
}

// Reconstruct typed text from the recorded key presses (no-mistake mode).
function reconstruct(keys: string[]): string {
  let out = ''
  for (const k of keys) {
    if (k === 'Enter') out += '\n'
    else if (k === 'Tab') out += '\t'
    else if (k === 'Backspace') out = out.slice(0, -1)
    else if (k.startsWith('down:') || k.startsWith('up:')) continue
    else out += k
  }
  return out
}

describe('HumanTyper', () => {
  it('types plain text exactly with mistakes disabled', async () => {
    const { input, keys } = recordingInput()
    const typer = new HumanTyper(input, { mistakeMultiplier: 0, rng: makeRng(1) })
    await typer.type('hello world')
    expect(reconstruct(keys)).toBe('hello world')
  })

  it('keeps emoji/astral characters as a single press (regression: surrogate split)', async () => {
    const { input, keys } = recordingInput()
    const typer = new HumanTyper(input, { mistakeMultiplier: 0, rng: makeRng(2) })
    await typer.type('a👍b')
    // No key should be a lone surrogate.
    for (const k of keys) {
      if (k.length === 1) {
        const code = k.charCodeAt(0)
        expect(code >= 0xd800 && code <= 0xdfff).toBe(false)
      }
    }
    expect(reconstruct(keys)).toBe('a👍b')
  })

  it('maps newline/tab to Enter/Tab keys (regression: raw control chars)', async () => {
    const { input, keys } = recordingInput()
    const typer = new HumanTyper(input, { mistakeMultiplier: 0, rng: makeRng(3) })
    await typer.type('a\nb\tc')
    expect(keys).toContain('Enter')
    expect(keys).toContain('Tab')
    expect(keys).not.toContain('\n')
    expect(keys).not.toContain('\t')
    expect(reconstruct(keys)).toBe('a\nb\tc')
  })

  it('never types text that does not reconstruct to the target (regression: maxSteps)', async () => {
    const { input, keys } = recordingInput()
    // High mistake multiplier stresses the correction/fallback path.
    const typer = new HumanTyper(input, { mistakeMultiplier: 5, rng: makeRng(4) })
    await typer.type('correctness')
    expect(reconstruct(keys)).toBe('correctness')
  })

  it('deleteAll with a modifier selects-all then deletes', async () => {
    const { input, keys } = recordingInput()
    const typer = new HumanTyper(input, { rng: makeRng(5) })
    await typer.deleteAll({ count: 0, selectAllModifier: 'Control' })
    expect(keys).toContain('down:Control')
    expect(keys).toContain('a')
    expect(keys).toContain('up:Control')
    expect(keys).toContain('Backspace')
  })
})

// Regression: an AZERTY typo slip generated 'é', Playwright's press() threw
// "Unknown key" and typing aborted mid-field ("jane@" instead of the full email).
describe('driver key routing (un-pressable code points)', () => {
  it('defineDriver routes non-US-layout single code points through insertText', async () => {
    const calls: string[] = []
    const resolved = defineDriver({
      async move() {},
      async click() {},
      async down() {},
      async up() {},
      async wheel() {},
      async press(k) { calls.push(`press:${k}`) },
      async insertText(t) { calls.push(`insert:${t}`) },
      async evaluate<A, R>(_fn: PageFunction<A, R>, _arg: A): Promise<R> { return undefined as R },
    })
    for (const key of ['é', 'a', '@', 'Enter', '👍']) await resolved.press(key)
    expect(calls).toEqual(['insert:é', 'press:a', 'press:@', 'press:Enter', 'insert:👍'])
  })

  it('cursor.type completes accented text against a US-layout-strict keyboard', async () => {
    let text = ''
    const NAMED = new Set(['Enter', 'Tab', 'Backspace'])
    const strictDriver: Driver = {
      async move() {},
      async click() {},
      async down() {},
      async up() {},
      async wheel() {},
      async press(key) {
        if (NAMED.has(key)) {
          if (key === 'Backspace') text = text.slice(0, -1)
          return
        }
        // Mimic Playwright: only printable US-layout ASCII is pressable.
        if (!/^[\x20-\x7e]$/.test(key)) throw new Error(`keyboard.press: Unknown key: "${key}"`)
        text += key
      },
      async insertText(t) { text += t },
      async evaluate<A, R>(_fn: PageFunction<A, R>, _arg: A): Promise<R> { return undefined as R },
    }
    const cursor = new Cursor(strictDriver, {
      seed: 42,
      settings: { typing: { mistakeMultiplier: 4, wpm: 2000, keyDelay: { min: 0, max: 0 } } },
    })
    await cursor.type('josé@example.com')
    expect(text).toBe('josé@example.com')
  })
})
