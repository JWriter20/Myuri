import { describe, expect, it } from 'vitest'
import {
  createCursor,
  defineDriver,
  makeRng,
  planClick,
  planMove,
  planPoint,
  planPress,
  planSelectAll,
  planType,
  planWheel,
  primaryModifier,
  type Driver,
  type KeyStep,
  type Os,
  type PlannedPoint,
  type WheelStep,
} from '../src/index.js'

// Golden values are shared with python/tests/test_plan.py: the same seed must
// plan the same in both languages. Times are rounded to 1 us.
const r3 = (x: number): number => Math.round(x * 1000) / 1000
const digest = (pts: PlannedPoint[]) => [
  pts.length,
  r3(pts.reduce((s, p) => s + p.x, 0)),
  r3(pts.reduce((s, p) => s + p.y, 0)),
  r3(pts.reduce((s, p) => s + p.t, 0)),
]
const keys = (steps: KeyStep[]) => steps.map(([t, type, key]) => [r3(t), type, key])
const wheelDigest = (planned: WheelStep[]) => {
  const steps = planned.map((s) => s.map((v) => (typeof v === 'number' ? r3(v) : v)) as WheelStep)
  const sum = (f: (s: WheelStep) => number) => r3(steps.reduce((a, s) => a + f(s), 0))
  return [
    steps.length,
    steps.filter((s) => s[0] === 'key').map((s) => [s[2], s[3]]),
    sum((s) => (s[0] === 'wheel' ? s[1] : 0)),
    sum((s) => (s[0] === 'wheel' ? s[2] : 0)),
    sum((s) => s[3]),
  ]
}

const OSES: Array<Os | undefined> = [undefined, 'macos', 'windows', 'linux']

const GOLDEN = {
  move: [106, 68640.738, 36725.706, 58499.625],
  moveShort: [11, 501.518, 372.564, 669.904],
  click: { dwellMs: 600, presses: [[0, 92], [162, 246], [323, 425]] },
  // planType('Hi, Bob!'): the release time of each key.
  typeUps: [93.693, 160.601, 163.587, 397.27, 476.726, 970.07, 985.174, 1091.661, 1178.239, 1671.725, 1697.921],
  press: [[0, 'down', 'Control'], [74.196, 'down', 'Shift'], [242.174, 'down', 'z'], [267.111, 'up', 'Control'], [310.546, 'up', 'z'], [350.309, 'up', 'Shift']],
  // Per OS in OSES order: the wheel is what the OS changes.
  wheelMouse: [
    [10, [['down', 330], ['up', 8318.707]], 0, 800, 14078.601],
    [11, [['down', 191], ['up', 1895.11]], 304, 496, 5965.91],
    [10, [['down', 330], ['up', 8318.707]], 0, 800, 14078.601],
    [10, [['down', 330], ['up', 8318.707]], 0, 800, 14078.601],
  ],
  wheelPad: [
    [15, [['down', 0], ['up', 2427.008]], 0, -200, 14223.494],
    [15, [['down', 0], ['up', 2427.008]], -200, 0, 14223.494],
    [15, [['down', 0], ['up', 2427.008]], 0, -200, 14223.494],
    [15, [['down', 0], ['up', 2427.008]], 0, -200, 14223.494],
  ],
}

describe('planners', () => {
  OSES.forEach((os, i) => {
    describe(`os ${os ?? '(none)'}`, () => {
      it('plans moves that end exactly at the target, on a rising clock', () => {
        const move = planMove({ x: 10, y: 20 }, { x: 800, y: 450 }, makeRng(5), { os })
        expect(digest(move)).toEqual(GOLDEN.move)
        expect(move[move.length - 1]).toMatchObject({ x: 800, y: 450 })
        expect(move.every((p, j) => j === 0 || p.t > move[j - 1].t)).toBe(true)
        const short = planMove({ x: 10, y: 20 }, { x: 60, y: 40 }, makeRng(5), { os, moveSpeed: 2 })
        expect(digest(short)).toEqual(GOLDEN.moveShort)
      })

      it('plans clicks', () => {
        expect(planClick(makeRng(7), { os, clickCount: 3 })).toEqual(GOLDEN.click)
      })

      it('plans typing with Playwright key names', () => {
        const steps = keys(planType('Hi, Bob!', makeRng(9), { os }))
        expect(steps.map((s) => s[2]).filter((k, j) => steps[j][1] === 'down')).toEqual(['Shift', 'H', 'i', ',', ' ', 'Shift', 'B', 'o', 'b', 'Shift', '!'])
        expect(steps.filter((s) => s[1] === 'up').map((s) => s[0])).toEqual(GOLDEN.typeUps)
      })

      it('plans chords', () => {
        expect(keys(planPress('Control+Shift+z', makeRng(3), { os }))).toEqual(GOLDEN.press)
      })

      it('plans wheels, a horizontal part with Shift held', () => {
        expect(wheelDigest(planWheel(300, 500, makeRng(13), { os, device: 'mouse' }))).toEqual(GOLDEN.wheelMouse[i])
        expect(wheelDigest(planWheel(-200, 0, makeRng(13), { os, device: 'trackpad' }))).toEqual(GOLDEN.wheelPad[i])
      })
    })
  })

  it('presses what a key needs', () => {
    expect(keys(planPress('A', makeRng(3)))).toEqual([[0, 'down', 'Shift'], [74.196, 'down', 'A'], [130.88, 'up', 'Shift'], [199.967, 'up', 'A']])
    expect(keys(planPress('Control++', makeRng(3))).map((s) => s[2])).toEqual(['Control', 'Shift', '+', 'Control', '+', 'Shift'])
    expect(keys(planSelectAll(makeRng(3), { os: 'macos' }))).toEqual([[0, 'down', 'Meta'], [74.196, 'down', 'a'], [130.88, 'up', 'Meta'], [199.967, 'up', 'a']])
    expect(planSelectAll(makeRng(3), { os: 'linux' })[0]).toEqual([0, 'down', 'Control'])
  })

  it('picks a point in a box', () => {
    const box = { x: 100, y: 200, width: 120, height: 40 }
    expect(planPoint(box, makeRng(4))).toEqual({ x: 156, y: 224 })
    expect(planPoint(box, makeRng(4), { start: { x: 0, y: 0 } })).toEqual({ x: 128, y: 215 })
  })

  it('presses where the pointer is when it is already on the box', () => {
    const box = { x: 100, y: 200, width: 120, height: 40 }
    expect(planPoint(box, makeRng(4), { start: { x: 101.5, y: 238 } })).toEqual({ x: 101.5, y: 238 })
  })
})

describe('click runs', () => {
  const median = (v: number[]): number => v.sort((a, b) => a - b)[v.length >> 1]
  const holds = (plans: { presses: [number, number][] }[], i: number) => median(plans.map((p) => p.presses[i][1] - p.presses[i][0]))
  const seeds = Array.from({ length: 2000 }, (_, i) => makeRng(i + 1))

  // People's presses after the first of a run (a double or triple click, or
  // rapid clicks in place) are held shorter: median 83 ms against 96.
  it('holds a later press of a run as people do', () => {
    const plans = seeds.map((rng) => planClick(rng, { clickCount: 3 }))
    expect(holds(plans, 0)).toBeGreaterThan(88)
    expect(holds(plans, 1)).toBeGreaterThanOrEqual(78)
    expect(holds(plans, 1)).toBeLessThanOrEqual(88)
    expect(holds(plans, 2)).toBeLessThanOrEqual(88)
  })

  it('continues a run after a recent release in place', () => {
    const plans = seeds.map((rng) => planClick(rng, { sinceReleaseMs: 20 }))
    // The gap from the release is the run's, about 78 ms, of which 20 have passed.
    expect(median(plans.map((p) => p.dwellMs))).toBeGreaterThanOrEqual(50)
    expect(median(plans.map((p) => p.dwellMs))).toBeLessThanOrEqual(66)
    expect(Math.min(...plans.map((p) => p.dwellMs))).toBeGreaterThanOrEqual(0)
    expect(holds(plans, 0)).toBeLessThanOrEqual(88)
  })

  it('presses at once after a release past the double-click time', () => {
    const plans = seeds.map((rng) => planClick(rng, { sinceReleaseMs: 800 }))
    expect(plans.every((p) => p.dwellMs === 0)).toBe(true)
    expect(holds(plans, 0)).toBeGreaterThan(88)
  })
})

describe('os', () => {
  it('rejects an unknown os', () => {
    expect(() => primaryModifier('Windows' as Os)).toThrow(/unknown os "Windows"/)
    expect(() => planClick(makeRng(1), { os: 'win' as Os })).toThrow(/unknown os/)
    expect(() => createCursor({ driver: keyDriver(), os: 'Mac' as Os })).toThrow(/unknown os/)
  })

  // A driver that records the keys it is sent; its page claims a Windows platform.
  const keyDriver = (downs: string[] = []): Driver => ({
    async move() {},
    async click() {},
    async down(k) { downs.push(k) },
    async up() {},
    async wheel() {},
    async press(k) { downs.push(k) },
    async setClipboard() {},
    async evaluate() { return false as never },
  })

  it('moves at a mouse report rate, and repeats a pixel only on macOS', async () => {
    const run = async (os: Os | undefined) => {
      const moves: [number, number, number][] = []
      const driver: Driver = { ...keyDriver(), async move(x, y) { moves.push([x, y, Date.now()]) }, async evaluate() { return { width: 1200, height: 800 } as never } }
      const cursor = createCursor({ driver, os, seed: 4, start: { x: 100, y: 100 } })
      await cursor.moveTo({ x: 300, y: 160 }, { moveSpeed: 0.5 })
      const gaps = moves.slice(1).map((m, j) => m[2] - moves[j][2]).sort((x, y) => x - y)
      const repeats = moves.filter((m, j) => j > 0 && m[0] === moves[j - 1][0] && m[1] === moves[j - 1][1]).length
      return { gaps, repeats }
    }
    const mac = await run('macos')
    expect(mac.repeats).toBeGreaterThan(0)
    expect(mac.gaps[Math.floor(mac.gaps.length / 2)]).toBeGreaterThanOrEqual(9)
    expect(mac.gaps[Math.floor(mac.gaps.length / 2)]).toBeLessThanOrEqual(12)
    for (const os of [undefined, 'windows', 'linux'] as const) expect((await run(os)).repeats).toBe(0)
  })

  it('refuses a select-all modifier the OS does not use', () => {
    expect(() => createCursor({ driver: keyDriver(), os: 'windows', selectAllModifier: 'Meta' })).toThrow(/not select-all on windows/)
    expect(() => createCursor({ driver: keyDriver(), os: 'macos', selectAllModifier: 'Meta' })).not.toThrow()
  })

  it('pastes with the modifier of os, not the one the page reports (#10)', async () => {
    const downs: string[] = []
    await defineDriver(keyDriver(downs), { os: 'macos' }).insertText('é')
    expect(downs).toEqual(['Meta', 'v'])
  })
})

describe('settings', () => {
  const SEEDS = Array.from({ length: 50 }, (_, i) => i)
  const mean = (f: (seed: number) => number) => SEEDS.reduce((sum, seed) => sum + f(seed), 0) / SEEDS.length
  const moveMs = (settings = {}, moveSpeed?: number) =>
    mean((seed) => planMove({ x: 10, y: 20 }, { x: 800, y: 450 }, makeRng(seed), { moveSpeed, settings }).at(-1)!.t)
  const wheelTimes = (settings = {}) => planWheel(0, 900, makeRng(13), { device: 'mouse', settings }).map((s) => s[s.length - 1] as number)
  const typeMs = (pauses?: { rate: number; length: number }) =>
    mean((seed) => planType('The quick brown fox jumps over the lazy dog.', makeRng(seed), { pauses }).at(-1)![0])

  it('mouse.speedFactor 2 about halves a move, and a call’s moveSpeed replaces it', () => {
    // Not exactly: the pointer still reports every ~10 ms.
    expect(moveMs({ mouse: { speedFactor: 2 } }) / moveMs()).toBeCloseTo(0.5, 1)
    expect(moveMs({ mouse: { speedFactor: 2 } }, 1)).toBe(moveMs())
  })

  it('scroll.speedFactor 2 halves every time in a scroll, the pause between strokes included', () => {
    const fast = wheelTimes({ scroll: { speedFactor: 2 } })
    wheelTimes().forEach((t, i) => expect(fast[i]).toBeCloseTo(t / 2, 6))
  })

  it('typing.pauses: fewer or shorter pauses type faster, more or longer ones slower', () => {
    expect(typeMs({ rate: 1, length: 1 })).toBe(typeMs())
    expect(typeMs({ rate: 0, length: 1 })).toBeLessThan(typeMs())
    expect(typeMs({ rate: 1, length: 0 })).toBeLessThan(typeMs())
    expect(typeMs({ rate: 3, length: 1 })).toBeGreaterThan(typeMs())
    expect(typeMs({ rate: 1, length: 3 })).toBeGreaterThan(typeMs())
  })

  it('throws on a setting that does not exist', () => {
    expect(() => planMove({ x: 0, y: 0 }, { x: 1, y: 1 }, makeRng(1), { settings: { mouse: { speed: 2 } } as never })).toThrow(
      "myuri: unknown setting 'mouse.speed'",
    )
  })
})
