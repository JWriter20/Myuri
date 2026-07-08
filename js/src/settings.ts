/**
 * Behavioral tuning for myuri. Unlike the old global-singleton settings, these
 * are plain immutable defaults; a Cursor takes a per-instance settings object so
 * two cursors with different seeds never share or race on mutable config.
 */

export interface MyuriSettings {
  overshoot: {
    spread: number
    radius: number
    threshold: number
    correctionSpeedFactor: number
    dwell: { minMs: number; maxMs: number }
  }
  correction: {
    retrySpread: number
    retryMoveSpeedFactor: number
    dynamicAdjustmentShiftThreshold: number
    dynamicAdjustmentSpeedFactor: number
    dynamicAdjustmentNoiseScale: number
  }
  scroll: {
    delay: number
    speedFactor: number
    overshoot: number
    finishPosition: number
    realism: { speedIrregularity: number }
  }
  typing: {
    wpm: number
    layout: 'qwerty' | 'azerty'
    mistakeMultiplier: number
    /**
     * Per-keystroke hold delay (keydown→keyup), in ms, sampled uniformly in
     * [min, max]. Independent of `wpm`, this is a realistic floor so a burst at
     * very high wpm still holds each key briefly — which also gives async widgets
     * (autocomplete/typeahead dropdowns) time to react between keys. 0/0 to disable.
     */
    keyDelay: { min: number; max: number }
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
  correction: {
    retrySpread: 5,
    retryMoveSpeedFactor: 1,
    dynamicAdjustmentShiftThreshold: 5,
    dynamicAdjustmentSpeedFactor: 1,
    dynamicAdjustmentNoiseScale: 0.5,
  },
  scroll: {
    delay: 50,
    speedFactor: 1.0,
    overshoot: 30,
    finishPosition: 0.5,
    realism: { speedIrregularity: 0.08 },
  },
  typing: {
    wpm: 80,
    layout: 'qwerty',
    mistakeMultiplier: 1.0,
    keyDelay: { min: 30, max: 50 },
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
