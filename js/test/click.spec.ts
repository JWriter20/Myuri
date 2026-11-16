import { describe, expect, it } from 'vitest'
import { clickHoldMs, dragCarrySpeed, dragEndMs, dragStartMs, multiClickGapMs, preClickDwellMs } from '../src/motion/click-model.js'
import { makeRng } from '../src/rng.js'

const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.floor((xs.length * p) / 100)]

describe('click timing model', () => {
  it('matches the recorded spreads', () => {
    const rng = makeRng(3)
    const hold = Array.from({ length: 4000 }, () => clickHoldMs(rng))
    const dwell = Array.from({ length: 4000 }, () => preClickDwellMs(rng))
    const gap = Array.from({ length: 4000 }, () => multiClickGapMs(rng))
    // Recorded with a mouse (n 110/89/11): hold p10/50/90 68/93/115, dwell 6/41/259, gap 76/78/101.
    expect(pct(hold, 50)).toBeGreaterThan(85)
    expect(pct(hold, 50)).toBeLessThan(101)
    expect(pct(hold, 10)).toBeGreaterThan(62)
    expect(pct(hold, 90)).toBeLessThan(130)
    expect(pct(dwell, 50)).toBeGreaterThan(34)
    expect(pct(dwell, 50)).toBeLessThan(50)
    expect(pct(dwell, 90)).toBeGreaterThan(180)
    expect(pct(gap, 10)).toBeGreaterThan(62)
    expect(pct(gap, 90)).toBeLessThan(105)
  })

  it('draws the same as the Python mirror', () => {
    // Printed by python/tests/test_click.py's twin.
    const rng = makeRng(7)
    const draw = (f: (r: typeof rng) => number) => Array.from({ length: 5 }, () => f(rng))
    expect(draw(clickHoldMs)).toEqual([166, 92, 76, 95, 90])
    expect(draw(preClickDwellMs)).toEqual([141, 15, 8, 5, 327])
    expect(draw(multiClickGapMs)).toEqual([89, 88, 74, 78, 97])
    const r2 = makeRng(11)
    expect(Array.from({ length: 5 }, () => dragStartMs(r2))).toEqual([11, 15, 21, 4, 14])
    expect(Array.from({ length: 5 }, () => dragEndMs(r2))).toEqual([99, 6, 64, 13, 3])
    expect(Array.from({ length: 2 }, () => +dragCarrySpeed(r2).toFixed(6))).toEqual([0.89843, 0.598639])
  })
})
