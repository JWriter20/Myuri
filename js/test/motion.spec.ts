import { describe, it, expect } from 'vitest'
import { makeRng } from '../src/rng.js'
import { path } from '../src/geometry.js'

describe('path generation (loads trajectory asset)', () => {
  it('starts near origin, ends exactly at target, monotonic time', () => {
    const start = { x: 100, y: 100 }
    const end = { x: 700, y: 450 }
    const pts = path(start, end, { moveSpeed: 1 }, makeRng(3))
    expect(pts.length).toBeGreaterThan(2)
    const last = pts[pts.length - 1]
    expect(last.x).toBe(end.x)
    expect(last.y).toBe(end.y)
    // timestamps non-decreasing
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].timestamp).toBeGreaterThanOrEqual(pts[i - 1].timestamp)
    }
  })

  it('is deterministic for a fixed seed', () => {
    const a = path({ x: 0, y: 0 }, { x: 300, y: 200 }, undefined, makeRng(9))
    const b = path({ x: 0, y: 0 }, { x: 300, y: 200 }, undefined, makeRng(9))
    expect(a.map((p) => [p.x, p.y])).toEqual(b.map((p) => [p.x, p.y]))
  })
})
