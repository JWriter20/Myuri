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

  it('notched: a scroll of a few notches is nudged, a lone notch first', () => {
    const gaps: number[] = []
    for (let seed = 0; seed < 200; seed++) {
      const ev = generateWheelPath(500, makeRng(seed))
      // Recorded short scrolls all open with one notch, then a re-grip.
      expect(ev[0].deltaY).toBe(100)
      expect(ev[0].deltaTime).toBeGreaterThanOrEqual(45)
      gaps.push(...ev.slice(0, -1).map((e) => e.deltaTime))
    }
    // Recorded bursts of 4-6 notches: event gaps p10/50/90 16/47/78 ms.
    const sorted = [...gaps].sort((a, b) => a - b)
    expect(sorted[Math.floor(sorted.length / 10)]).toBeLessThanOrEqual(17)
    expect(median(gaps)).toBeGreaterThan(40)
    expect(median(gaps)).toBeLessThan(75)
  })

  it('macos: 16 px lines in 20 ms frames; a re-grip within 150 ms keeps the speed', () => {
    let carried = 0
    let restarted = 0
    for (let seed = 0; seed < 30; seed++) {
      const ev = generateWheelPath(-4000, makeRng(seed), { style: 'macos' })
      expect(ev.reduce((s, e) => s + e.deltaY, 0)).toBe(-250 * 16)
      expect(ev[0].deltaY).toBe(-16)
      for (let i = 0; i + 1 < ev.length; i++) {
        expect(Math.abs(ev[i].deltaY % 16)).toBe(0)
        expect(Math.abs(ev[i].deltaY)).toBeLessThanOrEqual(13 * 16)
        if (ev[i].deltaTime === 20 || ev[i].deltaTime === 40) continue
        // Recorded on macOS: after <= 140 ms the next stroke starts at the last
        // frame's lines or one fewer; after 160+ ms, at one line.
        if (ev[i].deltaTime <= 150) {
          carried++
          // The scroll's last event sends only what is left.
          if (i + 2 < ev.length) expect(Math.abs(ev[i + 1].deltaY)).toBeGreaterThanOrEqual(Math.abs(ev[i].deltaY) - 16)
        } else {
          restarted++
          expect(ev[i + 1].deltaY).toBe(-16)
        }
      }
    }
    expect(carried).toBeGreaterThan(0)
    expect(restarted).toBeGreaterThan(0)
  })

  it('is deterministic per seed', () => {
    expect(generateWheelPath(777, makeRng(5))).toEqual(generateWheelPath(777, makeRng(5)))
    expect(generateWheelPath(777, makeRng(5), { style: 'macos' })).toEqual(
      generateWheelPath(777, makeRng(5), { style: 'macos' }),
    )
  })
})
