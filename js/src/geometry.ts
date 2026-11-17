import { type Vector, type BoundingBox, type TimedVector, type ViewportSize, direction, magnitude } from './math.js'
import { type Rng, gaussian } from './rng.js'
import { type BoxOptions, type PathOptions } from './options.js'
import { generateTrajectory } from 'cursory-js'

/** Keep the cursor at least this many px from the viewport edges. */
export const VIEWPORT_PADDING = 10

export function clampToBrowserBounds(x: number, y: number, viewport: ViewportSize): Vector {
  return {
    x: Math.max(VIEWPORT_PADDING, Math.min(x, viewport.width - VIEWPORT_PADDING)),
    y: Math.max(VIEWPORT_PADDING, Math.min(y, viewport.height - VIEWPORT_PADDING)),
  }
}

const clampPct = (v: number | undefined): number | undefined =>
  v == null ? undefined : Math.max(0, Math.min(100, v))

/**
 * Resolve per-side padding (px) for a box. Per-side options take precedence;
 * otherwise the axis percentage is split symmetrically. Overflowing pairs are
 * scaled down so the effective area stays non-negative.
 */
export function resolveSidePaddingPx(
  { width, height }: { width: number; height: number },
  options?: BoxOptions,
  defaults: { widthPaddingPercentage: number; heightPaddingPercentage: number } = {
    widthPaddingPercentage: 0,
    heightPaddingPercentage: 0,
  },
): { left: number; right: number; top: number; bottom: number } {
  const widthPct = clampPct(options?.widthPaddingPercentage) ?? defaults.widthPaddingPercentage
  const heightPct = clampPct(options?.heightPaddingPercentage) ?? defaults.heightPaddingPercentage

  const leftPct = clampPct(options?.paddingLeft) ?? widthPct / 2
  const rightPct = clampPct(options?.paddingRight) ?? widthPct / 2
  const topPct = clampPct(options?.paddingTop) ?? heightPct / 2
  const bottomPct = clampPct(options?.paddingBottom) ?? heightPct / 2

  let left = (width * leftPct) / 100
  let right = (width * rightPct) / 100
  let top = (height * topPct) / 100
  let bottom = (height * bottomPct) / 100

  if (left + right > width) {
    const scale = width / (left + right)
    left *= scale
    right *= scale
  }
  if (top + bottom > height) {
    const scale = height / (top + bottom)
    top *= scale
    bottom *= scale
  }
  return { left, right, top, bottom }
}

export function isPointExcluded(point: Vector, boxes: readonly BoundingBox[] | undefined): boolean {
  if (!boxes || boxes.length === 0) return false
  return boxes.some(
    (b) => point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height,
  )
}

/**
 * Choose a natural point inside a box. Without a current position, samples a
 * center-biased Gaussian; with one, scores several candidates by travel distance
 * and center proximity. Respects exclude boxes via rejection sampling.
 */
export function getRandomBoxPoint(
  { x, y, width, height }: BoundingBox,
  options: BoxOptions | undefined,
  currentPosition: Vector | undefined,
  excludeBoxes: readonly BoundingBox[] | undefined,
  rng: Rng,
): Vector {
  const isSmall = width < 40 || height < 40
  const sides = resolveSidePaddingPx({ width, height }, options, {
    widthPaddingPercentage: isSmall ? 50 : 25,
    heightPaddingPercentage: 70,
  })

  const effX = x + sides.left
  const effY = y + sides.top
  const effW = Math.max(0, width - sides.left - sides.right)
  const effH = Math.max(0, height - sides.top - sides.bottom)
  const hasExcludes = excludeBoxes != null && excludeBoxes.length > 0

  const sampleNormal = (spread: number): Vector => ({
    x: effX + Math.max(0, Math.min(1, gaussian(rng) * spread + 0.5)) * effW,
    y: effY + Math.max(0, Math.min(1, gaussian(rng) * spread + 0.5)) * effH,
  })
  const sampleUniform = (): Vector => ({ x: effX + rng() * effW, y: effY + rng() * effH })

  if (!currentPosition) {
    const maxAttempts = hasExcludes ? 64 : 1
    for (let i = 0; i < maxAttempts; i++) {
      const p = sampleNormal(0.2)
      if (!isPointExcluded(p, excludeBoxes)) return { x: Math.round(p.x), y: Math.round(p.y) }
    }
    for (let i = 0; i < 128; i++) {
      const p = sampleUniform()
      if (!isPointExcluded(p, excludeBoxes)) return { x: Math.round(p.x), y: Math.round(p.y) }
    }
    throw new Error('myuri: could not find a non-excluded point inside target bounds')
  }

  let candidates: Vector[] = []
  for (let i = 0; i < 10; i++) candidates.push(sampleNormal(0.25))
  if (hasExcludes) {
    candidates = candidates.filter((c) => !isPointExcluded(c, excludeBoxes))
    for (let i = 0; i < 128 && candidates.length < 10; i++) {
      const p = sampleUniform()
      if (!isPointExcluded(p, excludeBoxes)) candidates.push(p)
    }
    if (candidates.length === 0) {
      throw new Error('myuri: could not find a non-excluded point inside target bounds')
    }
  }

  const centerX = effX + effW / 2
  const centerY = effY + effH / 2
  let best = candidates[0]
  let bestScore = Infinity
  for (const c of candidates) {
    const dist = Math.hypot(c.x - currentPosition.x, c.y - currentPosition.y)
    const centerDist = Math.hypot(c.x - centerX, c.y - centerY)
    const score = dist * 0.7 + centerDist * 0.3
    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  return { x: Math.round(best.x), y: Math.round(best.y) }
}

/** A natural off-origin starting position (center-left of the viewport). */
export function getBetterStartingPosition(
  dimensions: { width: number; height: number } | undefined,
  rng: Rng,
): Vector {
  const { width = 1920, height = 1080 } = dimensions ?? {}
  return { x: width * 0.2 + rng() * 0.15, y: height * 0.35 + rng() * 0.2 }
}

export const shouldOvershoot = (a: Vector, b: Vector, threshold: number): boolean =>
  magnitude(direction(a, b)) > threshold

/** A point of a planned move, `t` ms after the move starts. */
export interface PlannedPoint {
  x: number
  y: number
  t: number
}

/**
 * A mouse reports its position about every 10 ms, whatever the OS: a USB mouse
 * on a Mac, which shows every report, gave 3588 pointermoves while moving
 * 8.8/10/11.1 ms apart (p10/50/90), lognormal mu 2.303, sd 0.091 (log median,
 * 10-90% span / 2.563). Where the OS coalesces reports into display frames
 * (Windows) and stamps them on its timer grid, the browser does that, not the
 * planner.
 */
const REPORT_MU = 2.303
const REPORT_SD = 0.091
const REPORT_MS = 10

/** One human-like stroke from `start` to `end`, one point a mouse report; the last is exactly `end`. */
export function trajectory(start: Vector, end: Vector, options: PathOptions | undefined, rng: Rng): PlannedPoint[] {
  const distance = Math.hypot(end.x - start.x, end.y - start.y)
  let speedFactor = options?.moveSpeed !== undefined && options.moveSpeed > 0 ? 1 / options.moveSpeed : 1
  if (distance < 100) {
    const smallMovementBoost = 1.5 + 1.5 * (1 - distance / 100)
    speedFactor = speedFactor / smallMovementBoost
  }
  // cursory draws from its own numpy-compatible generator, so hand it a seed
  // pulled from our stream: same myuri seed -> same trajectory, in JS and Python.
  // Its timings are scaled by speedFactor afterwards, so ask for one sample a report.
  const { points, timings } = generateTrajectory([start.x, start.y], [end.x, end.y], {
    frequency: (1000 / REPORT_MS) * speedFactor,
    frequencyRandomizer: 1,
    seed: Math.floor(rng() * 0x100000000),
  })
  const times = timings.map((t) => t * speedFactor)
  const total = times[times.length - 1]
  // Read the path where the pointer is at each report; the first report after it stops is `end`.
  const out: PlannedPoint[] = []
  const report = () => Math.exp(gaussian(rng, REPORT_MU, REPORT_SD))
  let j = 0
  let t = report()
  for (; t < total; t += report()) {
    while (times[j + 1] <= t) j++
    const a = (t - times[j]) / (times[j + 1] - times[j])
    const x = points[j][0] + a * (points[j + 1][0] - points[j][0])
    const y = points[j][1] + a * (points[j + 1][1] - points[j][1])
    out.push({ x: Math.max(0, x), y: Math.max(0, y), t })
  }
  out.push({ x: end.x, y: end.y, t })
  return out
}

/** Generate a timed, human-like path from `start` to a point or box. */
export function path(start: Vector, end: BoundingBox | Vector, options: PathOptions | undefined, rng: Rng): TimedVector[] {
  const endPoint =
    typeof end === 'object' && 'width' in end
      ? { x: end.x + end.width / 2, y: end.y + end.height / 2 }
      : end
  const startTime = Date.now()
  return trajectory(start, endPoint, options, rng).map(({ x, y, t }) => ({ x, y, timestamp: startTime + Math.round(t) }))
}
