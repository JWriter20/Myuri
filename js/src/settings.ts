/**
 * Behavioral tuning for myuri. Unlike the old global-singleton settings, these
 * are plain immutable defaults; a Cursor takes a per-instance settings object so
 * two cursors with different seeds never share or race on mutable config.
 */

import type { WheelStyle } from './motion/wheel-model.js'

export interface MyuriSettings {
  /**
   * How far each trait of a seed's profile may stray from these settings: a
   * trait is drawn within ±`variation` of its value (0.2 = ±20%). 0 runs the
   * settings exactly. See `generateProfile`.
   */
  variation: number
  mouse: {
    /** Move speed (2 = moves take half as long). A call's `moveSpeed` replaces it. */
    speedFactor: number
  }
  overshoot: {
    /** How far past the target an overshoot lands, px. */
    radius: number
    /** Moves longer than this (px) overshoot and correct back. */
    threshold: number
    /** Speed of the correction back, relative to the move. */
    correctionSpeedFactor: number
    /** Pause at the overshoot point before correcting, ms. */
    dwell: { minMs: number; maxMs: number }
  }
  scroll: {
    /** Scroll speed (2 = each scroll and the pause between strokes take half as long). */
    speedFactor: number
    /** Where a scroll leaves the element in the viewport: 0 top, 0.5 middle, 1 bottom. */
    finishPosition: number
    /** How unevenly a trackpad scroll's speed varies. */
    realism: { speedIrregularity: number }
    /**
     * What the identity scrolls with. `trackpad` (default) sends a stream of
     * small pixel deltas; `mouse` turns a wheel in notches (see `wheel`).
     * Camoufox turns every wheel call into notches, so use `mouse` there.
     */
    device: 'trackpad' | 'mouse'
    wheel: {
      /** `notched` (Windows, Linux) or `macos` (accelerated lines in 20 ms frames). */
      style: WheelStyle
      pxPerNotch: number
      pxPerLine: number
    }
  }
  typing: {
    /** Words per minute, with the default pauses. */
    wpm: number
    /** How often typos happen (0 = never, 2 = twice as often). */
    mistakeMultiplier: number
    /**
     * Hesitations between keys: `rate` scales how often one happens, `length`
     * how much time it adds. `wpm` counts the default pauses, so fewer or
     * shorter pauses type a little faster than `wpm`.
     */
    pauses: { rate: number; length: number }
  }
}

export const defaultSettings: MyuriSettings = {
  variation: 0.2,
  mouse: { speedFactor: 1 },
  overshoot: {
    radius: 120,
    threshold: 500,
    correctionSpeedFactor: 1,
    dwell: { minMs: 20, maxMs: 60 },
  },
  scroll: {
    speedFactor: 1,
    finishPosition: 0.5,
    realism: { speedIrregularity: 0.08 },
    device: 'trackpad',
    wheel: { style: 'notched', pxPerNotch: 100, pxPerLine: 16 },
  },
  typing: {
    wpm: 80,
    mistakeMultiplier: 1,
    pauses: { rate: 1, length: 1 },
  },
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/** A structured deep clone (no shared nested references). */
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T
  const out = {} as T
  for (const key of Object.keys(value) as Array<keyof T>) {
    out[key] = deepClone(value[key])
  }
  return out
}

function deepMerge<T>(base: T, override: DeepPartial<T> | undefined, path: string): T {
  const out = deepClone(base)
  if (!override) return out
  for (const key of Object.keys(override) as Array<keyof T>) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) throw new TypeError(`myuri: unknown setting '${path}${String(key)}'`)
    const ov = override[key]
    if (ov === undefined) continue
    const bv = out[key]
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object') {
      out[key] = deepMerge(bv, ov as DeepPartial<typeof bv>, `${path}${String(key)}.`)
    } else {
      out[key] = ov as T[keyof T]
    }
  }
  return out
}

/** Produce a fresh, fully-owned settings object from a partial override. Unknown keys throw. */
export function resolveSettings(override?: DeepPartial<MyuriSettings>): MyuriSettings {
  return deepMerge(defaultSettings, override, '')
}

export type { DeepPartial }
