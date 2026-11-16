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
    // Recorded (4 machines): hold p5/50/95 63/96/156, dwell 8/24/154, gap p10/90 63/110.
    expect(pct(hold, 50)).toBeGreaterThan(88)
    expect(pct(hold, 50)).toBeLessThan(106)
    expect(pct(hold, 5)).toBeGreaterThan(55)
    expect(pct(hold, 95)).toBeLessThan(165)
    expect(pct(dwell, 50)).toBeGreaterThan(22)
    expect(pct(dwell, 50)).toBeLessThan(36)
    expect(pct(dwell, 95)).toBeGreaterThan(100)
    expect(pct(gap, 10)).toBeGreaterThan(55)
    expect(pct(gap, 90)).toBeLessThan(125)
  })

  it('draws the same as the Python mirror', () => {
    // Printed by python/tests/test_click.py's twin.
    const rng = makeRng(7)
    const draw = (f: (r: typeof rng) => number) => Array.from({ length: 5 }, () => f(rng))
    expect(draw(clickHoldMs)).toEqual([199, 96, 76, 100, 94])
    expect(draw(preClickDwellMs)).toEqual([68, 15, 9, 7, 123])
    expect(draw(multiClickGapMs)).toEqual([120, 118, 77, 90, 146])
    const r2 = makeRng(11)
    expect(Array.from({ length: 5 }, () => dragStartMs(r2))).toEqual([50, 59, 69, 27, 55])
    expect(Array.from({ length: 5 }, () => dragEndMs(r2))).toEqual([78, 16, 61, 24, 11])
    expect(Array.from({ length: 2 }, () => +dragCarrySpeed(r2).toFixed(6))).toEqual([0.89843, 0.598639])
  })
})
