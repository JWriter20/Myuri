import { type Vector, type BoundingBox, type TimedVector, type ViewportSize, direction, magnitude } from './math.js'
import { type Rng, gaussian } from './rng.js'
import { type BoxOptions, type PathOptions } from './options.js'
import { generateTrajectory } from './motion/cursory.js'

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

function ensureTerminalPoint(pathPoints: TimedVector[], end: Vector): TimedVector[] {
  if (pathPoints.length === 0) return []
  const last = pathPoints[pathPoints.length - 1]
  return [...pathPoints.slice(0, -1), { ...last, x: end.x, y: end.y }]
}

/** Generate a timed, human-like path from `start` to a point or box. */
export function path(start: Vector, end: BoundingBox | Vector, options: PathOptions | undefined, rng: Rng): TimedVector[] {
  const opts = options ?? {}
  const endPoint =
    typeof end === 'object' && 'width' in end
      ? { x: end.x + end.width / 2, y: end.y + end.height / 2 }
      : end

  const distance = Math.hypot(endPoint.x - start.x, endPoint.y - start.y)
  const { points, timings } = generateTrajectory({ x: start.x, y: start.y }, endPoint, 60, 1, rng)

  let speedFactor = opts.moveSpeed !== undefined && opts.moveSpeed > 0 ? 1 / opts.moveSpeed : 1
  if (distance < 100) {
    const smallMovementBoost = 1.5 + 1.5 * (1 - distance / 100)
    speedFactor = speedFactor / smallMovementBoost
  }

  const startTime = Date.now()
  const timed: TimedVector[] = points.map((p, i) => ({
    x: Math.max(0, p.x),
    y: Math.max(0, p.y),
    timestamp: startTime + Math.round(timings[i] * speedFactor),
  }))
  return ensureTerminalPoint(timed, endPoint)
}
