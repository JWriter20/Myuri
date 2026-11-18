import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createCursor } from '../src/index.js'
import { type Driver, type PageFunction } from '../src/drivers/types.js'
import { scrollModel, type ScrollEvent } from '../src/motion/scroll-model.js'

/**
 * Replace globals for one page-function call and return the undo. Defined, not
 * assigned: Node 21+ has a getter-only `navigator`.
 */
function stubGlobals(values: Record<string, unknown>): () => void {
  const names = ['document', 'window', 'navigator']
  const saved = names.map((n) => Object.getOwnPropertyDescriptor(globalThis, n))
  for (const [n, value] of Object.entries(values))
    Object.defineProperty(globalThis, n, { value, configurable: true, writable: true })
  return () =>
    names.forEach((n, i) => {
      const d = saved[i]
      if (d) Object.defineProperty(globalThis, n, d)
      else delete (globalThis as Record<string, unknown>)[n]
    })
}

/**
 * A headless driver that runs page-functions against a minimal DOM stub, so the
 * whole Cursor -> page-query -> driver path can be exercised without a browser.
 * A single element sits at the given rect; `elementFromPoint` reports it for any
 * point inside the rect.
 */
function makeFakeDriver(rect = { x: 100, y: 100, width: 200, height: 50 }) {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const record = (op: string, ...args: unknown[]) => calls.push({ op, args })

  const el = {
    tagName: 'BUTTON',
    localName: 'button',
    shadowRoot: null,
    parentNode: null,
    parentElement: null,
    assignedSlot: null,
    get ownerDocument() {
      return documentStub
    },
    matches: () => false,
    closest: () => null,
    contains: (node: unknown) => node === el,
    // cursor.ts walks up via parentElement, falling back to getRootNode() to
    // detect a shadow host. This top-level stub has no shadow root, so return a
    // document-like root with no `.host` (traversal stops there).
    getRootNode: () => documentStub,
    getBoundingClientRect: () => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    }),
  }
  const documentStub = {
    documentElement: {
      clientWidth: 1280,
      clientHeight: 720,
      scrollHeight: 2000,
      // scroll-plan uses the documentElement as the page scroller and calls
      // getBoundingClientRect() on it (values unused on the page path).
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: 1280,
        height: 720,
        right: 1280,
        bottom: 720,
      }),
    },
    body: {},
    get defaultView() {
      return windowStub
    },
    querySelector: (_sel: string) => el,
    querySelectorAll: (_sel: string) => [] as unknown[],
    evaluate: () => ({ singleNodeValue: null }),
    elementFromPoint: (x: number, y: number) =>
      x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height ? el : null,
  }
  const windowStub = {
    innerWidth: 1280,
    innerHeight: 720,
    scrollY: 0,
    frameElement: null,
    getComputedStyle: () => ({ visibility: 'visible', position: 'static', overflowY: 'visible' }),
  }
  const navigatorStub = { platform: 'Linux x86_64', userAgent: 'test' }

  const driver: Driver = {
    async move(x, y) {
      record('move', x, y)
    },
    async click(button, clickCount = 1) {
      record('click', button, clickCount)
    },
    async down(key) {
      record('down', key)
    },
    async up(key) {
      record('up', key)
    },
    async wheel(dx, dy) {
      record('wheel', dx, dy)
    },
    async press(key) {
      record('press', key)
    },
    async evaluate<A, R>(fn: PageFunction<A, R>, arg: A): Promise<R> {
      const restore = stubGlobals({ document: documentStub, window: windowStub, navigator: navigatorStub })
      try {
        return (await fn(arg)) as R
      } finally {
        restore()
      }
    },
    isClosed() {
      return false
    },
  }
  return { driver, calls, rect }
}

describe('Cursor (headless integration)', () => {
  let restore: () => void
  beforeEach(() => {
    restore = stubGlobals({})
  })
  afterEach(() => restore())

  it('move lands the cursor inside the target element', async () => {
    const { driver, calls, rect } = makeFakeDriver()
    const cursor = createCursor({ driver, seed: 1 })
    await cursor.move('#target')
    const loc = cursor.getLocation()
    expect(loc.x).toBeGreaterThanOrEqual(rect.x)
    expect(loc.x).toBeLessThanOrEqual(rect.x + rect.width)
    expect(loc.y).toBeGreaterThanOrEqual(rect.y)
    expect(loc.y).toBeLessThanOrEqual(rect.y + rect.height)
    expect(calls.some((c) => c.op === 'move')).toBe(true)
  })

  it('click moves then dispatches a click', async () => {
    const { driver, calls } = makeFakeDriver()
    const cursor = createCursor({ driver, seed: 2 })
    await cursor.click('#target')
    const clickIdx = calls.findIndex((c) => c.op === 'click')
    const firstMoveIdx = calls.findIndex((c) => c.op === 'move')
    expect(clickIdx).toBeGreaterThan(-1)
    expect(firstMoveIdx).toBeGreaterThan(-1)
    expect(firstMoveIdx).toBeLessThan(clickIdx)
  })

  it('clicks the element again where the pointer rests, without a move', async () => {
    const { driver, calls } = makeFakeDriver()
    const cursor = createCursor({ driver, seed: 2 })
    await cursor.click('#target')
    const first = calls.length
    await cursor.click('#target')
    expect(calls.slice(first).map((c) => c.op)).toEqual(['click'])
  })

  it('continues a run when clicked again in place, as rapid clicks are', async () => {
    const { driver } = makeFakeDriver()
    const times: number[] = []
    const holds: number[] = []
    const cursor = createCursor({
      driver: { ...driver, async click(_b, _n, holdMs) { times.push(Date.now()); holds.push(holdMs ?? 0) } },
      seed: 5,
    })
    await cursor.move('#target')
    for (let i = 0; i < 15; i++) await cursor.click(undefined, { waitForClick: 0 })
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    // People's rapid clicks in place: up -> down 71-88 ms, held 63-79 ms.
    expect(med(times.slice(1).map((t, i) => t - times[i]))).toBeGreaterThan(60)
    expect(med(holds.slice(1))).toBeLessThan(88)
  })

  it('type clicks the field then presses keys', async () => {
    const { driver, calls } = makeFakeDriver()
    const cursor = createCursor({ driver, seed: 3, settings: { typing: { mistakeMultiplier: 0 } } })
    await cursor.type('hi', '#target')
    const pressed = calls.filter((c) => c.op === 'down').map((c) => c.args[0])
    expect(pressed).toContain('h')
    expect(pressed).toContain('i')
    // Every key that went down came back up.
    expect(calls.filter((c) => c.op === 'up').map((c) => c.args[0]).sort()).toEqual([...pressed].sort())
  })

  /**
   * Give the fake a focused field (the target rect) holding `text`. The
   * focused-field page function can't run against the DOM stub, so answer it
   * directly; Backspace empties the field, as it would once triple-click has
   * selected everything.
   */
  function withFocusedField(fake: ReturnType<typeof makeFakeDriver>, text: string) {
    let value = text
    const driver: Driver = {
      ...fake.driver,
      async evaluate<A, R>(fn: PageFunction<A, R>, arg: A): Promise<R> {
        if (String(fn).includes('visualLines')) {
          const { rect } = fake
          return {
            box: rect,
            empty: value === '',
            selection: 'all',
            lines: 1,
            visualLines: 1,
            scrollTop: 0,
            firstLine: { x: rect.x + 8, y: rect.y + rect.height / 2 },
          } as R
        }
        return fake.driver.evaluate(fn, arg)
      },
      async down(key) {
        if (key === 'Backspace') value = ''
        return fake.driver.down(key)
      },
    }
    return { driver, calls: fake.calls }
  }

  const clickCounts = (calls: Array<{ op: string; args: unknown[] }>) =>
    calls.filter((c) => c.op === 'click').map((c) => c.args[1])

  it('clearExisting triple-clicks and never sends a modifier key', async () => {
    const { driver, calls } = withFocusedField(makeFakeDriver(), 'Glassdoor')
    const cursor = createCursor({ driver, seed: 5, settings: { typing: { mistakeMultiplier: 0 } } })
    await cursor.type('hi', '#target', { clearExisting: true })
    // The focusing click is click 1; clicks 2 and 3 complete the triple-click.
    expect(clickCounts(calls)).toEqual([1, 2, 3])
    expect(calls.filter((c) => c.op === 'down' && ['Control', 'Meta'].includes(c.args[0] as string))).toEqual([])
    expect(calls.some((c) => c.op === 'down' && c.args[0] === 'Backspace')).toBe(true)
  })

  it('clearExisting leaves an empty field alone', async () => {
    const { driver, calls } = withFocusedField(makeFakeDriver(), '')
    const cursor = createCursor({ driver, seed: 5, settings: { typing: { mistakeMultiplier: 0 } } })
    await cursor.type('hi', '#target', { clearExisting: true })
    expect(clickCounts(calls)).toEqual([1])
  })

  it('clearExisting uses keyboard select-all only when selectAllModifier is set', async () => {
    const { driver, calls } = withFocusedField(makeFakeDriver(), 'Glassdoor')
    const cursor = createCursor({ driver, seed: 5, selectAllModifier: 'Meta', settings: { typing: { mistakeMultiplier: 0 } } })
    await cursor.type('hi', '#target', { clearExisting: true })
    expect(calls.some((c) => c.op === 'down' && c.args[0] === 'Meta')).toBe(true)
    expect(clickCounts(calls)).toEqual([1])
  })

  it('scroll keeps the model timing when the browser acks each wheel a frame later', async () => {
    // A real browser acknowledges a wheel event only on its next frame. Awaiting
    // each one used to stretch gestures planned at ~8 ms cadence to 1.5-2x.
    const fake = makeFakeDriver({ x: 100, y: 1500, width: 200, height: 50 })
    const gestures: ScrollEvent[][] = []
    const generate = scrollModel.generateScrollPath
    scrollModel.generateScrollPath = (...args) => {
      const events = generate.apply(scrollModel, args)
      gestures.push(events)
      return events
    }
    const sent: Array<{ t: number; deltaY: number; gesture: number }> = []
    let inFlight = 0
    let maxInFlight = 0
    const driver: Driver = {
      ...fake.driver,
      async wheel(deltaX, deltaY) {
        sent.push({ t: performance.now(), deltaY, gesture: gestures.length - 1 })
        maxInFlight = Math.max(maxInFlight, ++inFlight)
        await new Promise((r) => setTimeout(r, 17))
        inFlight--
      },
    }
    try {
      const cursor = createCursor({ driver, seed: 8, settings: { scroll: { speedFactor: 1 } } })
      await cursor.scroll('#target', { maxTries: 1 })
    } finally {
      scrollModel.generateScrollPath = generate
    }

    const planned = gestures[0]
    const intended = planned.reduce((sum, e) => sum + e.deltaTime, 0)
    const first = sent.filter((w) => w.gesture === 0)
    const span = first.at(-1)!.t - first[0].t
    expect(span).toBeLessThan(intended * 1.3)
    expect(span).toBeGreaterThan(intended * 0.7)
    // Sends overlap rather than waiting on each ack, and lose no distance.
    expect(maxInFlight).toBeGreaterThan(1)
    const plannedDistance = planned.reduce((sum, e) => sum + e.deltaY, 0)
    const sentDistance = first.reduce((sum, w) => sum + w.deltaY, 0)
    expect(Math.abs(sentDistance - plannedDistance)).toBeLessThanOrEqual(1)
  })

  it('scroll with device mouse sends whole notches', async () => {
    const fake = makeFakeDriver({ x: 100, y: 1500, width: 200, height: 50 })
    const sent: number[] = []
    const driver: Driver = {
      ...fake.driver,
      async wheel(_deltaX, deltaY) {
        sent.push(deltaY)
      },
    }
    const cursor = createCursor({ driver, seed: 8, settings: { scroll: { device: 'mouse' } } })
    await cursor.scroll('#target', { maxTries: 1 })
    expect(sent.length).toBeGreaterThan(0)
    for (const d of sent) expect(d % 100).toBe(0)
  })

  it('is deterministic: same seed -> same landing point', async () => {
    const a = makeFakeDriver()
    const b = makeFakeDriver()
    const ca = createCursor({ driver: a.driver, seed: 777 })
    const cb = createCursor({ driver: b.driver, seed: 777 })
    await ca.move('#target')
    await cb.move('#target')
    expect(ca.getLocation()).toEqual(cb.getLocation())
  })

  it('dispose is idempotent and stops random moves', async () => {
    const { driver } = makeFakeDriver()
    const cursor = createCursor({ driver, seed: 4, performRandomMovesInitially: true })
    await cursor.dispose()
    await cursor.dispose()
  })
})
