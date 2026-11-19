import { describe, it, expect } from 'vitest'
import { generateProfile } from '../src/profile.js'
import { resolveSettings } from '../src/settings.js'

/** Every numeric leaf, by path. */
const leaves = (o: object, path = ''): [string, number][] =>
  Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'number' ? [[path + k, v] as [string, number]] : v && typeof v === 'object' ? leaves(v, `${path}${k}.`) : [],
  )

describe('generateProfile', () => {
  it('is deterministic, and normalizes the seed (>>> 0)', () => {
    expect(generateProfile(1234)).toEqual(generateProfile(1234))
    expect(generateProfile(5)).toEqual(generateProfile(5 + 0x100000000))
    expect(generateProfile(1234)).not.toEqual(generateProfile(9999))
  })

  it('draws each trait within ±variation of the configured value', () => {
    const settings = { variation: 0.1, mouse: { speedFactor: 3 }, typing: { wpm: 40 } }
    const base = new Map(leaves(resolveSettings(settings)))
    for (const seed of [0, 1, 7, 42, 1234, 9999, 2 ** 31]) {
      for (const [path, value] of leaves(generateProfile(seed, settings))) {
        expect(value, path).toBeGreaterThanOrEqual(base.get(path)! * 0.9 - 1e-9)
        expect(value, path).toBeLessThanOrEqual(base.get(path)! * 1.1 + 1e-9)
      }
    }
  })

  it('runs the settings exactly at variation 0', () => {
    const settings = { variation: 0, typing: { wpm: 120, pauses: { rate: 0.5 } } }
    expect(generateProfile(42, settings)).toEqual(resolveSettings(settings))
  })

  it('keeps a scroll’s finish position inside the viewport', () => {
    for (let seed = 0; seed < 50; seed++) expect(generateProfile(seed, { scroll: { finishPosition: 1 } }).scroll.finishPosition).toBeLessThanOrEqual(1)
  })

  it("uses the OS's wheel style unless the settings name one", () => {
    expect(generateProfile(1, undefined, 'macos').scroll.wheel.style).toBe('macos')
    expect(generateProfile(1, undefined, 'windows').scroll.wheel.style).toBe('notched')
    expect(generateProfile(1, { scroll: { wheel: { style: 'notched' } } }, 'macos').scroll.wheel.style).toBe('notched')
  })
})
