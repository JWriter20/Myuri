import { describe, it, expect } from 'vitest'
import { HumanTyper, type TyperInput, type TypingClock } from '../src/typing/typer.js'
import { KeystrokeTiming, strokesForText, needsShift, _internals } from '../src/typing/timing.js'
import { makeRng } from '../src/rng.js'
import { Cursor } from '../src/cursor.js'
import { defineDriver, type Driver, type PageFunction } from '../src/drivers/types.js'

interface Rec {
  t: number
  op: 'down' | 'up' | 'insert'
  key: string
}

/** A virtual clock; each input call can cost `latency` ms like a real driver round-trip. */
function virtualClock(): TypingClock & { t: number } {
  const clock = {
    t: 0,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms
    },
  }
  return clock
}

function recordingInput(clock: { t: number }, latency = 0): { input: TyperInput; log: Rec[] } {
  const log: Rec[] = []
  const at = (op: Rec['op'], key: string) => {
    log.push({ t: clock.t, op, key })
    clock.t += latency
  }
  const input: TyperInput = {
    async down(key) {
      at('down', key)
    },
    async up(key) {
      at('up', key)
    },
    async insertText(text) {
      at('insert', text)
    },
  }
  return { input, log }
}

function typer(seed: number, opts: { mistakeMultiplier?: number; wpm?: number; latency?: number } = {}) {
  const clock = virtualClock()
  const { input, log } = recordingInput(clock, opts.latency)
  const t = new HumanTyper(input, {
    mistakeMultiplier: opts.mistakeMultiplier ?? 0,
    wpm: opts.wpm,
    rng: makeRng(seed),
    clock,
  })
  return { typer: t, log, clock }
}

/** Text produced by the recorded keydowns (Shift itself produces nothing). */
function reconstruct(log: Rec[]): string {
  let out: string[] = []
  for (const r of log) {
    if (r.op === 'insert') out.push(r.key)
    if (r.op !== 'down') continue
    if (r.key === 'Shift') continue
    if (r.key === 'Enter') out.push('\n')
    else if (r.key === 'Tab') out.push('\t')
    else if (r.key === 'Backspace') out = out.slice(0, -1)
    else out.push(r.key)
  }
  return out.join('')
}

/** Every key goes down and up alternately, and nothing is left held. */
function expectBalanced(log: Rec[]) {
  const held = new Set<string>()
  for (const r of log) {
    if (r.op === 'down') {
      expect(held.has(r.key), `${r.key} pressed twice at ${r.t}`).toBe(false)
      held.add(r.key)
    } else if (r.op === 'up') {
      expect(held.has(r.key), `${r.key} released while up at ${r.t}`).toBe(true)
      held.delete(r.key)
    }
  }
  expect([...held]).toEqual([])
}

const PARAGRAPH =
  'Hello Sarah, thanks for getting back to me so quickly. I have attached the ' +
  'updated draft (version 4) and would love your thoughts before Monday. The ' +
  'main change is in section two, where we now explain how the numbers were ' +
  'collected. Let me know if anything is unclear!'

describe('HumanTyper', () => {
  it('types plain text exactly with mistakes disabled', async () => {
    const { typer: t, log } = typer(1)
    await t.type('hello world')
    expect(reconstruct(log)).toBe('hello world')
    expectBalanced(log)
  })

  it('keeps emoji/astral characters as a single insert (regression: surrogate split)', async () => {
    const { typer: t, log } = typer(2)
    await t.type('a👍b')
    expect(log.filter((r) => r.op === 'insert').map((r) => r.key)).toEqual(['👍'])
    expect(reconstruct(log)).toBe('a👍b')
  })

  it('maps newline/tab to Enter/Tab keys (regression: raw control chars)', async () => {
    const { typer: t, log } = typer(3)
    await t.type('a\nb\tc')
    const keys = log.map((r) => r.key)
    expect(keys).toContain('Enter')
    expect(keys).toContain('Tab')
    expect(keys).not.toContain('\n')
    expect(keys).not.toContain('\t')
    expect(reconstruct(log)).toBe('a\nb\tc')
  })

  it('never types text that does not reconstruct to the target (regression: maxSteps)', async () => {
    for (let seed = 0; seed < 30; seed++) {
      const { typer: t, log } = typer(seed, { mistakeMultiplier: 5 })
      await t.type('Correctness, mostly!')
      expect(reconstruct(log)).toBe('Correctness, mostly!')
      expectBalanced(log)
    }
  })

  it('holds Shift for exactly the characters that need it', async () => {
    for (let seed = 0; seed < 20; seed++) {
      const { typer: t, log } = typer(seed, { mistakeMultiplier: 2 })
      await t.type('Hi NASA team: "Q4" results (50% up) are IN! ok?')
      let shift = false
      for (const r of log) {
        if (r.key === 'Shift') shift = r.op === 'down'
        else if (r.op === 'down') expect(shift, `Shift state at ${JSON.stringify(r.key)}`).toBe(needsShift(r.key))
      }
      expectBalanced(log)
    }
  })

  it('presses keys with real overlap (rollover) and plausible holds', async () => {
    const { typer: t, log } = typer(7, { wpm: 80 })
    await t.type(PARAGRAPH)
    const downs = log.filter((r) => r.op === 'down' && r.key !== 'Shift')
    const holds: number[] = []
    let overlaps = 0
    for (let i = 0; i < downs.length; i++) {
      const up = log.find((r) => r.op === 'up' && r.key === downs[i].key && r.t >= downs[i].t)!
      holds.push(up.t - downs[i].t)
      if (i + 1 < downs.length && up.t > downs[i + 1].t) overlaps++
    }
    holds.sort((a, b) => a - b)
    const median = holds[holds.length >> 1]
    // Recorded: letters ~100 ms, space ~80; rollover 35% of pairs.
    expect(median).toBeGreaterThan(65)
    expect(median).toBeLessThan(140)
    const rollover = overlaps / (downs.length - 1)
    expect(rollover).toBeGreaterThan(0.15)
    expect(rollover).toBeLessThan(0.6)
  })

  it('plays on an absolute clock: driver latency is not added to every gap', async () => {
    const plain = typer(11)
    await plain.typer.type(PARAGRAPH)
    const slow = typer(11, { latency: 4 })
    await slow.typer.type(PARAGRAPH)
    const span = (log: Rec[]) => log[log.length - 1].t - log[0].t
    // ~500 actions x 4 ms would add ~2 s if latency stacked; it should be absorbed.
    expect(span(slow.log) - span(plain.log)).toBeLessThan(200)
  })

  it('deleteAll with a modifier selects-all then deletes', async () => {
    const { typer: t, log } = typer(5)
    await t.deleteAll({ count: 0, selectAllModifier: 'Control' })
    const seq = log.map((r) => `${r.op}:${r.key}`)
    expect(seq[0]).toBe('down:Control')
    expect(seq.indexOf('down:a')).toBeGreaterThan(0)
    expect(seq.indexOf('down:a')).toBeLessThan(seq.indexOf('up:Control'))
    expect(seq.indexOf('up:Control')).toBeLessThan(seq.indexOf('down:Backspace'))
    expectBalanced(log)
  })

  it('releases held keys if the driver fails mid-typing', async () => {
    const clock = virtualClock()
    const { input, log } = recordingInput(clock)
    let n = 0
    const failing: TyperInput = {
      ...input,
      async down(key) {
        if (++n === 4) throw new Error('page closed')
        return input.down(key)
      },
    }
    const t = new HumanTyper(failing, { mistakeMultiplier: 0, rng: makeRng(1), clock })
    await expect(t.type('ABCDEF')).rejects.toThrow('page closed')
    expectBalanced(log)
  })
})

describe('KeystrokeTiming', () => {
  const longText = PARAGRAPH.repeat(4)

  it('hits the requested WPM', () => {
    for (const wpm of [40, 80, 120]) {
      const gaps: number[] = []
      for (let seed = 0; seed < 10; seed++) {
        const { downAt } = new KeystrokeTiming(wpm, makeRng(seed)).plan(strokesForText(longText))
        gaps.push((downAt[downAt.length - 1] - downAt[0]) / (downAt.length - 1))
      }
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
      const target = 12000 / wpm
      expect(Math.abs(mean - target) / target, `wpm ${wpm}: mean gap ${mean}`).toBeLessThan(0.12)
    }
  })

  it('pauses inside a word rarely, and briefly', () => {
    const letter = (k: string) => /^[a-zA-Z]$/.test(k)
    const gaps: number[] = []
    for (let seed = 0; seed < 40; seed++) {
      const strokes = strokesForText(longText)
      const { downAt } = new KeystrokeTiming(80, makeRng(seed)).plan(strokes)
      for (let i = 1; i < strokes.length; i++) {
        const [a, b] = [strokes[i - 1].key, strokes[i].key]
        if (letter(a) && letter(b) && b === b.toLowerCase()) gaps.push(downAt[i] - downAt[i - 1])
      }
    }
    const share = (ms: number) => gaps.filter((g) => g > ms).length / gaps.length
    expect(share(1000)).toBeGreaterThan(0)
    expect(share(1000)).toBeLessThan(0.002)
    expect(share(600)).toBeLessThan(0.008)
  })

  it('types common English pairs faster than rare ones (FSU bigrams)', () => {
    const g = (a: string, b: string) => _internals.logGapMean({ key: a }, { key: b })
    expect(g('t', 'h')).toBeLessThan(g('t', 'k'))
    expect(g('i', 'n')).toBeLessThan(g('i', 'j'))
    // 10x more frequent pair -> ~0.71x the gap.
    expect(Math.exp(g('e', 'r') - g('e', 'k'))).toBeLessThan(0.8)
  })

  it('pauses at word starts, punctuation and before correcting a typo', () => {
    const g = (a: string, b: string) => _internals.logGapMean({ key: a }, { key: b })
    expect(g(' ', 't')).toBeGreaterThan(g('e', 't'))
    expect(g('e', ',')).toBeGreaterThan(g('e', 't'))
    expect(g('e', 'Backspace')).toBeGreaterThan(g('Backspace', 'Backspace'))
  })

  it('is deterministic for a seed', () => {
    const a = new KeystrokeTiming(80, makeRng(42)).plan(strokesForText('Same seed.'))
    const b = new KeystrokeTiming(80, makeRng(42)).plan(strokesForText('Same seed.'))
    expect(a).toEqual(b)
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
    const NAMED = new Set(['Enter', 'Tab', 'Backspace', 'Shift'])
    const strictDriver: Driver = {
      async move() {},
      async click() {},
      async down(key) {
        if (NAMED.has(key)) {
          if (key === 'Backspace') text = text.slice(0, -1)
          return
        }
        // Mimic Playwright: only printable US-layout ASCII is a key.
        if (!/^[\x20-\x7e]$/.test(key)) throw new Error(`keyboard.down: Unknown key: "${key}"`)
        text += key
      },
      async up() {},
      async wheel() {},
      async press() {
        throw new Error('typing should use down/up')
      },
      async insertText(t) { text += t },
      async evaluate<A, R>(_fn: PageFunction<A, R>, _arg: A): Promise<R> { return undefined as R },
    }
    const cursor = new Cursor(strictDriver, {
      seed: 42,
      settings: { typing: { mistakeMultiplier: 4, wpm: 2000 } },
    })
    await cursor.type('josé@example.com')
    expect(text).toBe('josé@example.com')
  })
})
