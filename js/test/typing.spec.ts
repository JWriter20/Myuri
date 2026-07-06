import { describe, it, expect } from 'vitest'
import { HumanTyper, type TyperInput } from '../src/typing/typer.js'
import { makeRng } from '../src/rng.js'

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
