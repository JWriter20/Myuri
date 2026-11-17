import { describe, expect, it } from 'vitest'
import { generateWheelPath } from '../src/motion/wheel-model.js'
import { makeRng } from '../src/rng.js'

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

describe('mouse wheel model', () => {
  it('notched: whole 100 px notches, nearest count, at least one', () => {
    for (const [d, n] of [[1000, 10], [-340, 3], [30, 1], [-60, 1], [149, 1], [151, 2]]) {
      const ev = generateWheelPath(d, makeRng(1))
      expect(ev.reduce((s, e) => s + e.deltaY, 0)).toBe(Math.sign(d) * n * 100)
      for (const e of ev) expect(e.deltaY % 100 === 0 && Math.sign(e.deltaY) === Math.sign(d)).toBe(true)
    }
    expect(generateWheelPath(0.3, makeRng(1))).toEqual([])
  })

  it('notched: flicks in 60 Hz frames, batched when fast, split by re-grips', () => {
    const regrips: number[] = []
    let events = 0
    let batched = 0
    for (let seed = 0; seed < 40; seed++) {
      for (const e of generateWheelPath(3000, makeRng(seed))) {
        // Re-grips are drawn >= 50 ms; within a flick, events are one or two frames apart.
        if (e.deltaTime >= 40) regrips.push(e.deltaTime)
        else expect([16, 17, 33, 34]).toContain(e.deltaTime)
        events++
        if (Math.abs(e.deltaY) > 100) batched++
      }
    }
    // Recorded: 59% of a long scroll's events carry 2+ notches; re-grip median 71 ms.
    expect(batched / events).toBeGreaterThan(0.4)
    expect(batched / events).toBeLessThan(0.7)
    expect(median(regrips)).toBeGreaterThan(60)
    expect(median(regrips)).toBeLessThan(100)
  })

  it('macos: 16 px lines in 20 ms frames, ramping from one line', () => {
    let firsts = 0
    let strokes = 0
    for (let seed = 0; seed < 30; seed++) {
      const ev = generateWheelPath(-2000, makeRng(seed), { style: 'macos' })
      expect(ev.reduce((s, e) => s + e.deltaY, 0)).toBe(-125 * 16)
      let startOfStroke = true
      for (const e of ev) {
        expect(Math.abs(e.deltaY % 16)).toBe(0)
        expect(Math.abs(e.deltaY)).toBeLessThanOrEqual(13 * 16)
        if (startOfStroke) {
          strokes++
          if (e.deltaY === -16) firsts++
        }
        startOfStroke = e.deltaTime !== 20 && e.deltaTime !== 40
      }
    }
    expect(firsts).toBe(strokes)
  })

  it('is deterministic per seed', () => {
    expect(generateWheelPath(777, makeRng(5))).toEqual(generateWheelPath(777, makeRng(5)))
    expect(generateWheelPath(777, makeRng(5), { style: 'macos' })).toEqual(
      generateWheelPath(777, makeRng(5), { style: 'macos' }),
    )
  })
})
