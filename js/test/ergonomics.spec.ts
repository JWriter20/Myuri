import { describe, it, expect } from 'vitest'
import {
  Myuri,
  Cursor,
  createCursor,
  fromPlaywright,
  fromCDP,
  fromPuppeteer,
} from '../src/index.js'
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
  it('Myuri is the Cursor class', () => {
    expect(Myuri).toBe(Cursor)
  })

  it('new Myuri(driver) constructs a cursor', () => {
    const cursor = new Myuri(noopDriver(), { seed: 1 })
    expect(cursor.getSeed()).toBe(1)
  })

  it('createCursor accepts a driver directly (not just a page)', () => {
    const cursor = createCursor(noopDriver(), { seed: 5 })
    expect(cursor).toBeInstanceOf(Cursor)
    expect(cursor.getSeed()).toBe(5)
  })

  it('from* wrappers return a driver-like object accepted by Myuri', () => {
    // These only wrap the page; they do not touch it at construction time.
    const fakePage: any = {
      mouse: {}, keyboard: {}, context: () => ({}), evaluate: async () => null, isClosed: () => false,
    }
    for (const build of [fromPlaywright, fromCDP, fromPuppeteer]) {
      const driver = build(fakePage)
      expect(typeof driver.move).toBe('function')
      expect(typeof driver.evaluate).toBe('function')
      const cursor = new Myuri(driver, { seed: 2 })
      expect(cursor).toBeInstanceOf(Cursor)
    }
  })
})
