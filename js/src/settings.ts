/**
 * Behavioral tuning for myuri. Unlike the old global-singleton settings, these
 * are plain immutable defaults; a Cursor takes a per-instance settings object so
 * two cursors with different seeds never share or race on mutable config.
 */

import type { WheelStyle } from './motion/wheel-model.js'

export interface MyuriSettings {
  overshoot: {
    spread: number
    radius: number
    threshold: number
    correctionSpeedFactor: number
    dwell: { minMs: number; maxMs: number }
  }
  scroll: {
    delay: number
    speedFactor: number
    overshoot: number
    finishPosition: number
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
    wpm: number
    mistakeMultiplier: number
    /**
     * @deprecated Ignored since 3.1. Key holds are now drawn per key from
     * recorded typing (see `typing/timing.ts`); accepted so old configs load.
     */
    keyDelay?: { min: number; max: number }
  }
}

export const defaultSettings: MyuriSettings = {
  overshoot: {
    spread: 10,
    radius: 120,
    threshold: 500,
    correctionSpeedFactor: 1,
    dwell: { minMs: 20, maxMs: 60 },
  },
  scroll: {
    delay: 50,
    speedFactor: 1.0,
    overshoot: 30,
    finishPosition: 0.5,
    realism: { speedIrregularity: 0.08 },
    device: 'trackpad',
    wheel: { style: 'notched', pxPerNotch: 100, pxPerLine: 16 },
  },
  typing: {
    wpm: 80,
    mistakeMultiplier: 1.0,
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

function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  const out = deepClone(base)
  if (!override) return out
  for (const key of Object.keys(override) as Array<keyof T>) {
    const ov = override[key]
    if (ov === undefined) continue
    const bv = out[key]
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object') {
      out[key] = deepMerge(bv, ov as DeepPartial<typeof bv>)
    } else {
      out[key] = ov as T[keyof T]
    }
  }
  return out
}

/** Produce a fresh, fully-owned settings object from a partial override. */
export function resolveSettings(override?: DeepPartial<MyuriSettings>): MyuriSettings {
  return deepMerge(defaultSettings, override)
}

export type { DeepPartial }
