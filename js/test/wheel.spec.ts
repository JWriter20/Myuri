import { describe, expect, it } from 'vitest'
import { generateWheelPath } from '../src/motion/wheel-model.js'
import { makeRng } from '../src/rng.js'

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

describe('mouse wheel model', () => {
  it('notched: whole 100 px notches, nearest count, at least one', () => {
    for (const [d, n] of [[1000, 10], [-340, 3], [30, 1], [-60, 1], [149, 1], [151, 2]]) {
      const ev = generateWheelPath(d, makeRng(1))
      expect(ev.length).toBe(n)
      for (const e of ev) expect(e.deltaY).toBe(Math.sign(d) * 100)
    }
    expect(generateWheelPath(0.3, makeRng(1))).toEqual([])
  })

  it('notched: strokes of a few notches split by re-grips', () => {
    const inStroke: number[] = []
    const regrips: number[] = []
    for (let seed = 0; seed < 40; seed++) {
      for (const e of generateWheelPath(3000, makeRng(seed))) {
        expect(Number.isInteger(e.deltaTime)).toBe(true)
        // Re-grips are drawn >= 50 ms; in-stroke gaps are much shorter.
        ;(e.deltaTime >= 100 ? regrips : inStroke).push(e.deltaTime)
      }
    }
    expect(median(inStroke)).toBeGreaterThan(20)
    expect(median(inStroke)).toBeLessThan(80)
    expect(median(regrips)).toBeGreaterThan(110)
    expect(median(regrips)).toBeLessThan(220)
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
