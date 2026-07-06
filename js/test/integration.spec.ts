import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createCursor } from '../src/index.js'
import { type Driver, type PageFunction } from '../src/drivers/types.js'

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
    shadowRoot: null,
    parentNode: null,
    assignedSlot: null,
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
    documentElement: { clientWidth: 1280, clientHeight: 720, scrollHeight: 2000 },
    querySelector: (_sel: string) => el,
    querySelectorAll: (_sel: string) => [] as unknown[],
    evaluate: () => ({ singleNodeValue: null }),
    elementFromPoint: (x: number, y: number) =>
      x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height ? el : null,
  }
  const windowStub = { innerWidth: 1280, innerHeight: 720, scrollY: 0 }
  const navigatorStub = { platform: 'Linux x86_64', userAgent: 'test' }

  const driver: Driver = {
    async move(x, y) {
      record('move', x, y)
    },
    async click(button) {
      record('click', button)
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
      const g = globalThis as Record<string, unknown>
      const saved = { document: g.document, window: g.window, navigator: g.navigator }
      g.document = documentStub
      g.window = windowStub
      g.navigator = navigatorStub
      try {
        return (await fn(arg)) as R
      } finally {
        g.document = saved.document
        g.window = saved.window
        g.navigator = saved.navigator
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
    const g = globalThis as Record<string, unknown>
    const prev = { document: g.document, window: g.window, navigator: g.navigator }
    restore = () => {
      g.document = prev.document
      g.window = prev.window
      g.navigator = prev.navigator
    }
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

  it('type clicks the field then presses keys', async () => {
    const { driver, calls } = makeFakeDriver()
    const cursor = createCursor({ driver, seed: 3, settings: { typing: { mistakeMultiplier: 0 } } })
    await cursor.type('hi', '#target')
    const pressed = calls.filter((c) => c.op === 'press').map((c) => c.args[0])
    expect(pressed).toContain('h')
    expect(pressed).toContain('i')
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
