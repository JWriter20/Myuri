import pako from 'pako'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gaussian, type Rng } from '../rng.js'
import { type Vector } from '../math.js'

/** A 2D point. Alias of the library-wide Vector shape. */
export type Point = Vector

/** Shape of one entry in the recorded-trajectory dataset as stored on disk. */
export interface RawTrajectory {
    dx: number | [number, number]
    dy: number | [number, number]
    length: number
    points: [number, number][]
    timing: number[]
}

/** A recorded trajectory with points expanded into {x, y} objects. */
export interface Trajectory {
    dx: number | [number, number]
    dy: number | [number, number]
    length: number
    points: Point[]
    timing: number[]
}

/** Accepted forms for injected trajectory data (see setTrajectoryData). */
export type TrajectoryData = RawTrajectory[] | string | Uint8Array | ArrayBuffer

interface Dataset {
    trajectories: Trajectory[]
    /**
     * Straight-line-normalized signed endpoint direction of each trajectory,
     * precomputed once at load time so per-query lookups never re-map the
     * whole dataset.
     */
    dirX: number[]
    dirY: number[]
    /** Recorded arc lengths (used for length similarity scoring). */
    lengths: number[]
}

let dataset: Dataset | null = null

/**
 * Signed endpoint delta of a recorded trajectory. Derived from the recorded
 * points themselves whenever possible, which preserves the sign of the
 * displacement (a hypot collapse of tuple fields would make leftward and
 * rightward moves indistinguishable).
 */
function signedEndpointDelta(raw: RawTrajectory, points: Point[]): Point {
    if (points.length >= 2) {
        const first = points[0]
        const last = points[points.length - 1]
        return { x: last.x - first.x, y: last.y - first.y }
    }
    // Fallback for degenerate entries: tuples hold [start, end] coordinates,
    // so the signed delta is end - start. Never collapse with hypot.
    const dx = Array.isArray(raw.dx) ? raw.dx[1] - raw.dx[0] : raw.dx
    const dy = Array.isArray(raw.dy) ? raw.dy[1] - raw.dy[0] : raw.dy
    return { x: dx, y: dy }
}

function buildDataset(rawTrajectories: RawTrajectory[]): Dataset {
    const trajectories: Trajectory[] = rawTrajectories.map(rawTraj => ({
        ...rawTraj,
        points: rawTraj.points.map(([x, y]) => ({ x, y }))
    }))

    const dirX: number[] = new Array(trajectories.length)
    const dirY: number[] = new Array(trajectories.length)
    const lengths: number[] = new Array(trajectories.length)

    trajectories.forEach((traj, i) => {
        const delta = signedEndpointDelta(rawTrajectories[i], traj.points)
        // Normalize by the straight-line endpoint distance (NOT the arc
        // length) so the dot product against a unit target vector is a true
        // cosine similarity even for curved paths.
        const span = Math.hypot(delta.x, delta.y)
        dirX[i] = span !== 0 ? delta.x / span : 0
        dirY[i] = span !== 0 ? delta.y / span : 0
        lengths[i] = traj.length
    })

    return { trajectories, dirX, dirY, lengths }
}

/**
 * Reads the gzipped dataset shipped with the package. The compiled module
 * lives at <pkg>/dist/motion/trajectory.js and the asset ships at
 * <pkg>/dist/assets/trajectories.json.gz, so it always sits one directory up
 * from this file — regardless of the package name or install location.
 * This is the only place that touches the filesystem; non-Node runtimes
 * should inject data via setTrajectoryData / ensureTrajectoriesLoaded(data).
 */
function loadDefaultAsset(): RawTrajectory[] {
    // Built/published layout: dist/motion/trajectory.js -> dist/assets/...
    // Dev/source layout:      js/src/motion/trajectory.ts -> <repo>/assets/...
    const candidates = ['../assets/trajectories.json.gz', '../../../assets/trajectories.json.gz']
    let lastErr: unknown
    for (const rel of candidates) {
        try {
            const compressed = fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)))
            return JSON.parse(pako.inflate(compressed, { to: 'string' })) as RawTrajectory[]
        } catch (err) {
            lastErr = err
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function parseTrajectoryData(data: TrajectoryData): RawTrajectory[] {
    if (typeof data === 'string') {
        return JSON.parse(data) as RawTrajectory[]
    }
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
        return JSON.parse(pako.inflate(bytes, { to: 'string' })) as RawTrajectory[]
    }
    return data
}

/**
 * Supply the trajectory dataset explicitly, replacing anything already
 * loaded. Accepts the parsed array, a JSON string, or gzipped bytes.
 * Use this in runtimes without filesystem access.
 */
export function setTrajectoryData(data: TrajectoryData): void {
    dataset = buildDataset(parseTrajectoryData(data))
}

/**
 * Lazily loads the trajectory dataset on first use (cached afterwards).
 * If `data` is provided and nothing is loaded yet, it is used instead of
 * reading the bundled asset from disk.
 */
export function ensureTrajectoriesLoaded(data?: TrajectoryData): void {
    if (dataset) return
    try {
        const raw = data !== undefined ? parseTrajectoryData(data) : loadDefaultAsset()
        dataset = buildDataset(raw)
    } catch (error) {
        throw new Error(
            `Failed to load trajectory data: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
        )
    }
}

/**
 * Find the top N nearest trajectories to the target start and end points
 * based on direction and length similarity.
 */
export function findNearestTrajectory(
    targetStart: Point,
    targetEnd: Point,
    directionWeight: number = 0.8,
    lengthWeight: number = 0.2,
    topN: number = 5
): Trajectory[] {
    ensureTrajectoriesLoaded()
    const { trajectories, dirX, dirY, lengths } = dataset!

    // Calculate target vector components and length
    const dxTar = targetEnd.x - targetStart.x
    const dyTar = targetEnd.y - targetStart.y
    const lenTar = Math.hypot(dxTar, dyTar)

    // Handle zero-length target vector case
    if (lenTar === 0) {
        return lengths
            .map((len, idx) => ({ len, idx }))
            .sort((a, b) => a.len - b.len)
            .slice(0, topN)
            .map(item => trajectories[item.idx])
    }

    // Normalize target vector to get direction
    const normDxTar = dxTar / lenTar
    const normDyTar = dyTar / lenTar

    // Cosine similarity of directions (both sides straight-line normalized):
    // 1 for same, -1 for opposite, 0 for perpendicular. Converted to a
    // distance (0 is best) and combined with the normalized length difference.
    const combinedScore = dirX.map((dx, i) => {
        const directionDistance = 1 - (dx * normDxTar + dirY[i] * normDyTar)
        const lengthDiffRatio = Math.abs(lengths[i] - lenTar) / Math.max(lenTar, 1)
        return directionWeight * directionDistance + lengthWeight * lengthDiffRatio
    })

    // Get indices of trajectories with the lowest combined scores (best matches)
    return combinedScore
        .map((score, idx) => ({ score, idx }))
        .sort((a, b) => a.score - b.score)
        .slice(0, topN)
        .map(item => trajectories[item.idx])
}

/**
 * Find the closest trajectory to the target start and end points, with a
 * preference for shorter trajectories. Randomly selects from top candidates,
 * heavily biased towards shorter trajectories through weighted random sampling.
 */
export function findClosestTrajectory(
    targetStart: Point,
    targetEnd: Point,
    numNearestToSample: number = 5,
    randomSampleIterations: number = 20,
    lengthPreferencePower: number = 2,
    rng: Rng
): { trajectory: Trajectory; dxTar: number; dyTar: number; lenTar: number } {
    ensureTrajectoriesLoaded()
    const dxTar = targetEnd.x - targetStart.x
    const dyTar = targetEnd.y - targetStart.y
    const lenTar = Math.hypot(dxTar, dyTar)

    // Initial selection of top trajectories
    let topTrajectories = findNearestTrajectory(targetStart, targetEnd, 0.8, 0.2, numNearestToSample)

    // Iteratively refine top trajectories by perturbing target end and re-querying
    for (let i = 0; i < randomSampleIterations; i++) {
        const perturbedTargetEnd: Point = {
            x: targetEnd.x + (rng() * 2 - 1) * lenTar * 0.1,
            y: targetEnd.y + (rng() * 2 - 1) * lenTar * 0.1
        }
        topTrajectories = topTrajectories.concat(
            findNearestTrajectory(targetStart, perturbedTargetEnd, 0.8, 0.2, numNearestToSample)
        )
    }

    // Calculate weights based on inverse length, powered to strongly prefer
    // shorter trajectories
    const epsilon = 1e-10
    const inverseLengths = topTrajectories.map(
        traj => 1.0 / ((traj.length + epsilon) ** lengthPreferencePower)
    )
    const sumWeights = inverseLengths.reduce((sum, w) => sum + w, 0)
    const weights = inverseLengths.map(w => w / sumWeights)

    // Randomly select a trajectory index based on the calculated weights.
    // If float rounding lets the loop finish without a hit, the correct
    // fallback is the LAST index (cumulative weight ~1), not the first.
    const rand = rng()
    let cumulativeWeight = 0
    let selectedIndex = weights.length - 1
    for (let i = 0; i < weights.length; i++) {
        cumulativeWeight += weights[i]
        if (rand <= cumulativeWeight) {
            selectedIndex = i
            break
        }
    }

    return { trajectory: topTrajectories[selectedIndex], dxTar, dyTar, lenTar }
}

/**
 * Morph a given trajectory to match the target start and end points by
 * scaling, rotating, and translating. Purely deterministic (no rng).
 */
export function morphTrajectory(
    points: Point[],
    targetStart: Point,
    targetEnd: Point,
    dxTar: number,
    dyTar: number,
    lenTar: number
): Point[] {
    if (points.length === 0) return []

    const start = points[0]
    const end = points[points.length - 1]

    // Calculate original trajectory's displacement and length
    const dxOrig = end.x - start.x
    const dyOrig = end.y - start.y
    const lenOrig = Math.hypot(dxOrig, dyOrig)

    // Calculate scaling factor based on target and original lengths
    const scaleFactor = lenOrig !== 0 ? lenTar / lenOrig : 1.0

    // Calculate rotation angle needed to align original trajectory direction
    // with target direction
    const angleOrig = Math.atan2(dyOrig, dxOrig)
    const angleTar = Math.atan2(dyTar, dxTar)
    const rotationAngle = angleTar - angleOrig

    // Create rotation matrix
    const cosA = Math.cos(rotationAngle)
    const sinA = Math.sin(rotationAngle)

    // Apply transformation: Scale, Rotate, Translate
    const morphedPoints = points.map(point => {
        // Translate to origin
        let x = point.x - start.x
        let y = point.y - start.y

        // Scale
        x *= scaleFactor
        y *= scaleFactor

        // Rotate
        const rotatedX = x * cosA - y * sinA
        const rotatedY = x * sinA + y * cosA

        // Translate to target start
        return {
            x: rotatedX + targetStart.x,
            y: rotatedY + targetStart.y
        }
    })

    // Ensure exact start and end point matching
    morphedPoints[0] = { ...targetStart }
    morphedPoints[morphedPoints.length - 1] = { ...targetEnd }

    return morphedPoints
}

/**
 * Applies a smooth jitter to the trajectory points, scaling jitter based on
 * distance and trajectory length.
 */
export function jitterTrajectory(
    points: Point[],
    trajectoryLength: number,
    scale: number = 0.01,
    rng: Rng
): Point[] {
    if (points.length === 0) return []

    // Scale jitter based on trajectory length
    const lengthScale = Math.min(1.0, trajectoryLength / 400)

    // Calculate distances between consecutive points
    const distances: number[] = [0]
    for (let i = 1; i < points.length; i++) {
        const dx = points[i].x - points[i - 1].x
        const dy = points[i].y - points[i - 1].y
        distances.push(Math.sqrt(dx * dx + dy * dy))
    }

    // Calculate average distances for adaptive jitter scale
    const distancesPrev: number[] = [0, ...distances.slice(1)]
    const distancesNext: number[] = [...distances.slice(1), 0]
    const avgDistances = distancesPrev.map((prev, i) => (prev + distancesNext[i]) / 2)

    const maxAvgDistance = Math.max(...avgDistances, 1)
    const adaptiveScales = avgDistances.map(avg => scale * (avg / maxAvgDistance) * lengthScale)

    // Generate jitter values and apply to points
    return points.map((point, i) => {
        if (i === 0) return { ...point } // Keep first point unchanged

        // Zero-mean symmetric jitter, independent per axis: (rng()-0.5)*2 maps
        // to [-1, 1] so displacement is centered on the original point with no
        // directional bias.
        const jitterX = (rng() - 0.5) * 2 * adaptiveScales[i]
        const jitterY = (rng() - 0.5) * 2 * adaptiveScales[i]

        return {
            x: point.x + jitterX,
            y: point.y + jitterY
        }
    })
}

/**
 * Generates a random point within a rectangle defined by two corner points,
 * with a Gaussian bias towards the center of the rectangle.
 */
export function generateMiddleBiasedPoint(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    biasFactor: number = 2.0,
    rng: Rng
): Point {
    // Determine rectangle bounds
    const minX = Math.min(x1, x2)
    const maxX = Math.max(x1, x2)
    const minY = Math.min(y1, y2)
    const maxY = Math.max(y1, y2)

    // Calculate center and dimensions of the rectangle
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    const width = maxX - minX
    const height = maxY - minY

    // Gaussian offsets biased towards the rectangle center
    const offsetX = gaussian(rng, 0, width / (2 * biasFactor))
    const offsetY = gaussian(rng, 0, height / (2 * biasFactor))

    // Calculate final point coordinates, clamped to stay within the rectangle bounds
    const x = Math.max(minX, Math.min(maxX, centerX + offsetX))
    const y = Math.max(minY, Math.min(maxY, centerY + offsetY))

    return { x, y }
}

/**
 * Introduces "knots" into a trajectory by displacing points towards randomly
 * generated biased points.
 */
export function knotTrajectory(
    trajPoints: Point[],
    targetStart: Point,
    targetEnd: Point,
    numKnots: number = 5,
    knotStrength: number = 0.15,
    rng: Rng
): Point[] {
    if (trajPoints.length === 0) return []

    // Initialize knot offsets
    const knotOffsets: Point[] = trajPoints.map(() => ({ x: 0, y: 0 }))

    for (let k = 0; k < numKnots; k++) {
        // Generate a biased point within the bounding box of target start and end
        const knot = generateMiddleBiasedPoint(
            targetStart.x,
            targetStart.y,
            targetEnd.x,
            targetEnd.y,
            2.0,
            rng
        )

        // Calculate distances from each trajectory point to the knot point
        const distances = trajPoints.map(point => {
            const dx = knot.x - point.x
            const dy = knot.y - point.y
            return Math.sqrt(dx * dx + dy * dy)
        })

        const maxDistance = Math.max(...distances)

        // Skip adjustment if max distance is too small
        if (maxDistance < 1e-6) continue

        // Calculate proximity-based scaling and apply knot offsets
        trajPoints.forEach((point, i) => {
            const dx = knot.x - point.x
            const dy = knot.y - point.y
            const proximity = 1.0 - distances[i] / maxDistance
            const scalingFactor = proximity * knotStrength

            knotOffsets[i].x += dx * scalingFactor
            knotOffsets[i].y += dy * scalingFactor
        })
    }

    // Apply square-root scaling to knot displacements for smoother effect
    const signedSqrt = (x: number): number => Math.sign(x) * Math.sqrt(Math.abs(x))

    // Apply displacements to trajectory points
    return trajPoints.map((point, i) => ({
        x: point.x + signedSqrt(knotOffsets[i].x),
        y: point.y + signedSqrt(knotOffsets[i].y)
    }))
}

/**
 * Raw nearest-trajectory lookup: selects the closest recorded trajectory and
 * deterministically morphs (scale/rotate/translate) its recorded points to
 * fit exactly between the target start and end.
 *
 * NO random distortion (knot/jitter) is applied here — the caller (see
 * cursory.generateTrajectory) runs the single knot -> jitter -> morph pass on
 * the resampled points, so the distortion pipeline executes exactly once.
 */
export function findTrajectory(
    targetStart: Point,
    targetEnd: Point,
    rng: Rng
): { points: Point[]; timing: number[] } {
    const { trajectory, dxTar, dyTar, lenTar } = findClosestTrajectory(
        targetStart,
        targetEnd,
        5,
        20,
        2,
        rng
    )

    const points = morphTrajectory(trajectory.points, targetStart, targetEnd, dxTar, dyTar, lenTar)

    return { points, timing: trajectory.timing.slice() }
}
