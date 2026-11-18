import { describe, it, expect } from 'vitest'
import { Actions, Missed, RETRY_MS, type Host, type Step } from '../src/actions.js'
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
  evaluate<A, R>(_target: string, fn: (el: any, arg: A) => R): R {
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
