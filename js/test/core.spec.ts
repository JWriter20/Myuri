import { describe, it, expect } from 'vitest'
import { makeRng } from '../src/rng.js'
import { resolveSettings, defaultSettings } from '../src/settings.js'
import { scrollModel } from '../src/motion/scroll-model.js'
import { getRandomBoxPoint } from '../src/geometry.js'

describe('rng', () => {
  it('produces identical streams for the same seed', () => {
    const a = makeRng(12345)
    const b = makeRng(12345)
    const sa = Array.from({ length: 8 }, () => a())
    const sb = Array.from({ length: 8 }, () => b())
    expect(sa).toEqual(sb)
  })

  it('does not collide seeds 0 and 1 (regression)', () => {
    const zero = makeRng(0)
    const one = makeRng(1)
    const s0 = Array.from({ length: 5 }, () => zero())
    const s1 = Array.from({ length: 5 }, () => one())
    expect(s0).not.toEqual(s1)
  })

  it('stays in [0,1)', () => {
    const r = makeRng(7)
    for (let i = 0; i < 1000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('settings', () => {
  it('returns a fully-owned deep copy (no shared nested refs)', () => {
    const s = resolveSettings()
    s.scroll.realism.speedIrregularity = 9999
    expect(defaultSettings.scroll.realism.speedIrregularity).not.toBe(9999)
  })

  it('deep-merges overrides without mutating defaults', () => {
    const before = defaultSettings.typing.wpm
    const s = resolveSettings({ typing: { wpm: 200 } })
    expect(s.typing.wpm).toBe(200)
    expect(defaultSettings.typing.wpm).toBe(before)
  })
})

describe('scroll-model', () => {
  const rng = makeRng(42)

  it('never returns an empty path for a non-zero request (regression: small scrolls)', () => {
    for (const d of [2, 3, 4, 5, -3, 1]) {
      const path = scrollModel.generateScrollPath(d, makeRng(1))
      expect(path.length).toBeGreaterThan(0)
    }
  })

  it('emits only integer deltas that sum (with sign) to the rounded request', () => {
    for (const d of [3, 37, 250, -180, 5, 42.6]) {
      const path = scrollModel.generateScrollPath(d, makeRng(2))
      const sum = path.reduce((s, e) => s + e.deltaY, 0)
      for (const e of path) expect(Number.isInteger(e.deltaY)).toBe(true)
      expect(sum).toBe(Math.round(d))
    }
  })

  it('does not flip sign within a downward gesture', () => {
    const path = scrollModel.generateScrollPath(300, rng)
    const anyUp = path.some((e) => e.deltaY < 0)
    expect(anyUp).toBe(false)
  })
})

describe('getRandomBoxPoint', () => {
  const rng = makeRng(99)
  const box = { x: 100, y: 200, width: 300, height: 80 }

  it('returns a point inside the box', () => {
    for (let i = 0; i < 50; i++) {
      const p = getRandomBoxPoint(box, undefined, undefined, undefined, rng)
      expect(p.x).toBeGreaterThanOrEqual(box.x)
      expect(p.x).toBeLessThanOrEqual(box.x + box.width)
      expect(p.y).toBeGreaterThanOrEqual(box.y)
      expect(p.y).toBeLessThanOrEqual(box.y + box.height)
    }
  })

  it('avoids excluded regions', () => {
    const exclude = [{ x: 100, y: 200, width: 150, height: 80 }] // left half
    for (let i = 0; i < 50; i++) {
      const p = getRandomBoxPoint(box, undefined, undefined, exclude, rng)
      const inExcluded = p.x >= 100 && p.x <= 250 && p.y >= 200 && p.y <= 280
      expect(inExcluded).toBe(false)
    }
  })
})
