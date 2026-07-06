import { describe, it, expect } from 'vitest'
import { Cursor, createCursor, fromPlaywright, fromCDP, fromPuppeteer } from '../src/index.js'
import { type Driver, type PageFunction } from '../src/drivers/types.js'

function noopDriver(): Driver {
  return {
    async move() {},
    async click() {},
    async down() {},
    async up() {},
    async wheel() {},
    async press() {},
    async evaluate<A, R>(_fn: PageFunction<A, R>, _arg: A): Promise<R> {
      return undefined as R
    },
    isClosed() {
      return false
    },
  }
}

describe('ergonomic constructors', () => {
  it('createCursor accepts a driver directly (not just a page)', () => {
    const cursor = createCursor(noopDriver(), { seed: 5 })
    expect(cursor).toBeInstanceOf(Cursor)
    expect(cursor.getSeed()).toBe(5)
  })

  it('createCursor(fromX(page)) works for each prebuilt wrapper', () => {
    // These only wrap the page; they do not touch it at construction time.
    const fakePage: any = {
      mouse: {}, keyboard: {}, context: () => ({}), evaluate: async () => null, isClosed: () => false,
    }
    for (const build of [fromPlaywright, fromCDP, fromPuppeteer]) {
      const driver = build(fakePage)
      expect(typeof driver.move).toBe('function')
      expect(typeof driver.evaluate).toBe('function')
      const cursor = createCursor(driver, { seed: 2 })
      expect(cursor).toBeInstanceOf(Cursor)
    }
  })
})
