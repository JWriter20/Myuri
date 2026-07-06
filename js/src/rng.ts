/**
 * Seeded random number generator for reproducible cursor behavior.
 *
 * Mulberry32 — a small, fast 32-bit PRNG. The same seed produces the exact
 * same stream, so passing the same seed to `createCursor` yields identical
 * mouse movements, scrolls, typing rhythm, and starting position.
 */

export type Rng = () => number

export class SeededRng {
  private state: number

  constructor(seed: number) {
    // Use the seed verbatim (mod 2^32). Mulberry32 is non-degenerate at
    // state 0 because the first step adds the odd increment 0x6D2B79F5,
    // so there is no need to coerce 0 -> 1 (the old `|| 1` made seeds 0
    // and 1 collide onto the same stream).
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Generate a fresh random 32-bit seed. This is the only place `Math.random()`
 * is used inside the library.
 */
export function generateRandomSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0
}

/** Create an Rng function from a seed. Same seed -> same sequence. */
export function makeRng(seed: number): Rng {
  const r = new SeededRng(seed)
  return () => r.next()
}

/**
 * A Gaussian sample via the Box-Muller transform. `u1` is nudged off exactly 0
 * so `log(0)` can never produce -Infinity.
 */
export function gaussian(rng: Rng, mean = 0, std = 1): number {
  const u1 = rng() || Number.MIN_VALUE
  const u2 = rng()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return mean + z * std
}

/**
 * Fallback Rng used only when a caller constructs a helper without threading a
 * seeded Rng. The Cursor always injects its own seeded Rng, so reproducible
 * runs never touch this.
 */
export const defaultRng: Rng = () => Math.random()
