import { describe, it, expect } from 'vitest'
import { Actions, Missed, RETRY_MS, WHEEL_SCALE_RANGE, wheelScaleFrom, type Host, type Step } from '../src/actions.js'
import { HIT_TEST_JS } from '../src/page-functions.js'
import { SCROLL_PLAN_JS, type ScrollPlan } from '../src/scroll-plan.js'
import { makeRng } from '../src/rng.js'

const box = { x: 100, y: 400, width: 120, height: 40 }
const inView: ScrollPlan = { inView: true, deltaY: 0, hoverX: 0, hoverY: 0, isPage: true, region: box, box, borders: [0, 0] }
const below: ScrollPlan = { ...inView, inView: false, deltaY: 900, hoverX: 640, hoverY: 360, region: null }

/**
 * A host on a virtual clock: every call is recorded with the time it was made,
 * each move takes `latency` ms, and the page answers from scripted queues (the
 * last answer repeats).
 */
class FakeHost implements Host<string> {
  t = 0
  calls: unknown[][] = []
  args: unknown[] = []
  constructor(
    readonly plans: (ScrollPlan | null)[] = [inView],
    readonly hits: (string | null)[] = [null],
    readonly latency = 0,
  ) {}
  private next<V>(queue: V[]): V {
    return queue.length > 1 ? (queue.shift() as V) : queue[0]
  }
  move(x: number, y: number) {
    this.calls.push(['move', x, y, this.t])
    this.t += this.latency
  }
  click(button: string, clickCount: number, holdMs: number) {
    this.calls.push(['click', button, clickCount, this.t])
    this.t += holdMs
  }
  down(button: string) {
    this.calls.push(['down', button, this.t])
  }
  up(button: string) {
    this.calls.push(['up', button, this.t])
  }
  wheel(dx: number, dy: number) {
    this.calls.push(['wheel', dx, dy, this.t])
  }
  keyDown(key: string) {
    this.calls.push(['keyDown', key, this.t])
  }
  keyUp(key: string) {
    this.calls.push(['keyUp', key, this.t])
  }
  insertText(text: string) {
    this.calls.push(['insertText', text, this.t])
  }
  evaluate<A, R>(_target: string, fn: (el: any, arg: A) => R, arg?: A): R {
    this.args.push(arg)
    if (fn === (SCROLL_PLAN_JS as unknown)) return this.next(this.plans) as R
    if (fn === (HIT_TEST_JS as unknown)) return this.next(this.hits) as R
    throw new Error('unexpected page function')
  }
  offset(target: string): [number, number] | null {
    return target === '#gone' ? null : [0, 0]
  }
  viewport(): [number, number] {
    return [1280, 720]
  }
  now() {
    return this.t
  }
  sleep(ms: number) {
    this.t += ms
  }
  kinds() {
    return this.calls.map((c) => c[0])
  }
}

const actions = (host: FakeHost, seed = 1, options = {}) => new Actions(host, makeRng(seed), { os: 'windows', ...options })

describe('Actions.play', () => {
  it('sends each step at its time from the start, and a late step delays only itself', async () => {
    const host = new FakeHost([inView], [null], 30)
    const steps: Step[] = [
      ['move', 1, 1, 0],
      ['move', 2, 2, 10],
      ['move', 3, 3, 100],
    ]
    await actions(host).play(steps)
    expect(host.calls).toEqual([
      ['move', 1, 1, 0],
      ['move', 2, 2, 30],
      ['move', 3, 3, 100],
    ])
  })

  it('plays nothing when a step is bad', async () => {
    const host = new FakeHost()
    await expect(actions(host).play([['move', 1, 1, 5], ['move', 2, 2, 1]])).rejects.toThrow(/step 1 .*goes back in time/)
    expect(host.calls).toEqual([])
  })
})

describe('Actions.click', () => {
  it('wheels an element into view over the planned point, then moves onto it and clicks once', async () => {
    const host = new FakeHost([below, inView])
    await actions(host).click('#t')
    const kinds = host.kinds()
    expect(kinds.indexOf('wheel')).toBeGreaterThan(-1)
    expect(kinds.filter((k) => k === 'click')).toHaveLength(1)
    const at = host.calls.filter((c) => c[0] === 'move').at(-1) as number[]
    expect(at[1]).toBeGreaterThanOrEqual(box.x)
    expect(at[1]).toBeLessThanOrEqual(box.x + box.width)
    expect(at[2]).toBeGreaterThanOrEqual(box.y)
    expect(at[2]).toBeLessThanOrEqual(box.y + box.height)
  })

  it("waits for the wheel's scroll to land before it aims", async () => {
    const landing = [700, 550].map((y) => ({ ...inView, region: { ...box, y }, box: { ...box, y } }))
    const host = new FakeHost([below, ...landing, inView])
    await actions(host).click('#t')
    expect(host.kinds().filter((k) => k === 'click')).toHaveLength(1)
    const at = host.calls.filter((c) => c[0] === 'move').at(-1) as number[]
    expect(at[1]).toBeGreaterThanOrEqual(box.x)
    expect(at[1]).toBeLessThanOrEqual(box.x + box.width)
    expect(at[2]).toBeGreaterThanOrEqual(box.y)
    expect(at[2]).toBeLessThanOrEqual(box.y + box.height)
  })

  it('tries a miss again after a wait, as Playwright retries an action', async () => {
    const host = new FakeHost([inView], ['<div> intercepts pointer events', null])
    await actions(host).click('#t')
    expect(host.kinds().filter((k) => k === 'click')).toHaveLength(1)
  })

  it('throws the reason once its attempts are spent', async () => {
    const host = new FakeHost([inView], ['<div> intercepts pointer events'])
    await expect(actions(host).click('#t', { attempts: 2 })).rejects.toThrow(new Missed('<div> intercepts pointer events'))
    expect(host.kinds()).not.toContain('click')
  })

  it('stops trying at the timeout', async () => {
    const host = new FakeHost([inView], ['<div> intercepts pointer events'])
    await expect(actions(host).click('#t', { timeout: 2000 })).rejects.toThrow(Missed)
    expect(host.t).toBeGreaterThanOrEqual(2000)
    expect(host.t).toBeLessThan(2000 + Math.max(...RETRY_MS) + 1000)
  })

  it('does not count an element that is gone as reached', async () => {
    const host = new FakeHost()
    await expect(actions(host).click('#gone', { attempts: 1 })).rejects.toThrow(/element is not visible/)
  })

  it('is deterministic for a seed', async () => {
    const a = new FakeHost([below, inView])
    const b = new FakeHost([below, inView])
    await actions(a, 9).click('#t')
    await actions(b, 9).click('#t')
    expect(a.calls).toEqual(b.calls)
  })
})

describe('parts', () => {
  it('a part replaces myuri’s and can call it through default', async () => {
    const host = new FakeHost()
    const seen: number[][] = []
    const a = actions(host, 1, {
      parts: {
        move: (_h: Host<string>, x: number, y: number, ctx: { default: () => Promise<void> }) => {
          seen.push([x, y])
          return ctx.default()
        },
      },
    })
    await a.click('#t')
    expect(seen).toHaveLength(1)
    expect(host.calls.filter((c) => c[0] === 'move').at(-1)?.slice(1, 3)).toEqual(seen[0].map(Math.round))
  })

  it('a scroll part is the scroll the click uses', async () => {
    const host = new FakeHost([below, inView])
    const scrolled: string[] = []
    // This scroll part brings the element straight into view.
    const intoView = (_h: Host<string>, target: string) => {
      scrolled.push(target)
      host.plans.shift()
    }
    await actions(host, 1, { parts: { intoView } }).click('#t')
    expect(scrolled).toEqual(['#t'])
    expect(host.kinds()).not.toContain('wheel')
  })

  it('point and reaches decide where to press and whether it lands', async () => {
    const host = new FakeHost([inView], ['would miss'])
    await actions(host, 1, {
      parts: { point: () => ({ x: 130, y: 410 }), reaches: () => null },
    }).click('#t')
    expect(host.calls.filter((c) => c[0] === 'move').at(-1)?.slice(1, 3)).toEqual([130, 410])
    expect(host.kinds()).toContain('click')
  })

  it('names the parts when one is unknown', () => {
    expect(() => actions(new FakeHost(), 1, { parts: { scroll: () => {} } })).toThrow(/'scroll' is not a part; the parts are move, press/)
  })
})

describe('Actions settings', () => {
  const elapsed = async (settings: object, act: (a: Actions<string>) => Promise<void>) => {
    let sum = 0
    for (let seed = 0; seed < 20; seed++) {
      const host = new FakeHost()
      const a = actions(host, seed, { settings })
      a.moved(10, 20)
      await act(a)
      sum += host.t
    }
    return sum / 20
  }

  it('moves, scrolls and types at the speeds in settings', async () => {
    const move = (a: Actions<string>) => a.move(800, 450)
    expect((await elapsed({ mouse: { speedFactor: 2 } }, move)) / (await elapsed({}, move))).toBeCloseTo(0.5, 1)
    const wheel = (a: Actions<string>) => a.wheel(0, 900)
    expect(await elapsed({ scroll: { speedFactor: 2 } }, wheel)).toBeCloseTo((await elapsed({}, wheel)) / 2, 6)
    const type = (a: Actions<string>) => a.type('The quick brown fox jumps over the lazy dog.')
    expect(await elapsed({ typing: { pauses: { rate: 0 } } }, type)).toBeLessThan(await elapsed({}, type))
  })

  it('scrolls the element to settings.scroll.finishPosition', async () => {
    const host = new FakeHost([below, inView])
    await actions(host, 1, { settings: { scroll: { finishPosition: 0.2 } } }).click('#t')
    expect(host.args).toContainEqual(expect.objectContaining({ finishPosition: 0.2 }))
  })
})

/**
 * A page that scrolls `ratio` px for each wheel px, as Camoufox moves 132 px
 * for a 100 px notch: the target sits at `top` in the document and wants to
 * be 300 px down the viewport.
 */
class ScrollingHost extends FakeHost {
  scrollY = 0
  peak = 0
  constructor(readonly ratio: number, readonly top = 2200) {
    super()
  }
  wheel(dx: number, dy: number) {
    super.wheel(dx, dy)
    this.scrollY += dy * this.ratio
    this.peak = Math.max(this.peak, this.scrollY)
  }
  evaluate<A, R>(target: string, fn: (el: any, arg: A) => R, arg?: A): R {
    if (fn !== (SCROLL_PLAN_JS as unknown)) return super.evaluate(target, fn, arg)
    const at = { ...box, y: this.top - this.scrollY }
    const deltaY = at.y - 300
    return { ...below, inView: Math.abs(deltaY) < 60, deltaY, box: at, region: at } as R
  }
}

describe('wheel calibration', () => {
  it('reads the wheel px a page px takes, clamped and only from a scroll the right way', () => {
    expect(wheelScaleFrom(700, 924)).toBe(0.76)
    expect(wheelScaleFrom(100, 1000)).toBe(WHEEL_SCALE_RANGE[0])
    expect(wheelScaleFrom(1000, 100)).toBe(WHEEL_SCALE_RANGE[1])
    expect(wheelScaleFrom(700, -924)).toBeNull()
    expect(wheelScaleFrom(700, 0)).toBeNull()
    expect(wheelScaleFrom(Number.NaN, 924)).toBeNull()
  })

  it('probes a long scroll with a first flick, then lands without overshooting a fast page', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const host = new ScrollingHost(1.32)
      const a = actions(host, seed)
      await a.click('#t')
      expect(a.wheelScale).toBeCloseTo(1 / 1.32, 1)
      const goal = host.top - 300
      expect(Math.abs(host.scrollY - goal)).toBeLessThan(60)
      expect(host.peak - goal).toBeLessThan(60)
    }
  })

  it('keeps the scale it read for later scrolls', async () => {
    const host = new ScrollingHost(1.32)
    const a = actions(host, 3)
    await a.click('#t')
    const scale = a.wheelScale
    host.calls.length = 0
    await a.wheel(0, 1000)
    const sent = host.calls.filter((c) => c[0] === 'wheel').reduce((s, c) => s + (c[2] as number), 0)
    expect(a.wheelScale).toBe(scale)
    expect(Math.abs(sent * 1.32 - 1000)).toBeLessThan(140)
  })
})
