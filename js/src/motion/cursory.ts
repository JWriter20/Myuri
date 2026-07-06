import {
    findTrajectory,
    jitterTrajectory,
    knotTrajectory,
    morphTrajectory,
    type Point
} from './trajectory.js'
import { gaussian, type Rng } from '../rng.js'

/**
 * Generate a realistic mouse trajectory from start to end points using human data.
 *
 * `findTrajectory` returns the closest recorded trajectory deterministically
 * fitted to the target endpoints (no random distortion). The resampled points
 * then go through the knot -> jitter -> morph distortion pipeline exactly once
 * here, so deviation is applied a single time per call.
 *
 * @param targetStart - Starting point of the trajectory
 * @param targetEnd - Ending point of the trajectory
 * @param frequency - Number of samples per second (hz), default is 60
 * @param frequencyRandomizer - Max jitter in ms to apply to each sample time, default is 1
 * @param rng - Seeded random source; the same rng stream yields the same trajectory
 * @returns Trajectory points and their timings in ms
 */
export function generateTrajectory(
    targetStart: Point,
    targetEnd: Point,
    frequency: number = 60,
    frequencyRandomizer: number = 1,
    rng: Rng
): { points: Point[]; timings: number[] } {
    // Closest recorded trajectory, fitted to the target endpoints (undistorted)
    const { points: trajectoryPoints, timing: timings } = findTrajectory(targetStart, targetEnd, rng)

    // Normalize timings to start at 0
    const normalizedTimings = timings.map(t => t - timings[0])
    const totalTime = normalizedTimings[normalizedTimings.length - 1]

    // Milliseconds between samples
    const baseStep = 1000 / frequency

    const sampledPoints: Point[] = []
    const sampledTimings: number[] = []

    // Sample the trajectory at regular intervals with jitter
    let currentTime = 0

    while (currentTime <= totalTime) {
        // Apply Gaussian jitter to the current sampling time
        const jitterScale = Math.max(1.5, frequencyRandomizer)
        let jitter = Math.round(gaussian(rng, 0, frequencyRandomizer / jitterScale))

        // Clamp jitter
        jitter = Math.max(-frequencyRandomizer, Math.min(frequencyRandomizer, jitter))

        // Clamp the jittered time within the trajectory duration
        const sampleTime = Math.max(0, Math.min(totalTime, currentTime + jitter))

        // Find surrounding keyframes for the jittered time
        let prevIdx = 0
        for (let i = 0; i < normalizedTimings.length; i++) {
            if (normalizedTimings[i] <= sampleTime) {
                prevIdx = i
            } else {
                break
            }
        }
        const nextIdx = Math.min(prevIdx + 1, normalizedTimings.length - 1)

        const prevPoint = trajectoryPoints[prevIdx]
        const nextPoint = trajectoryPoints[nextIdx]
        const prevTime = normalizedTimings[prevIdx]
        const nextTime = normalizedTimings[nextIdx]

        // Interpolation factor
        const alpha = nextTime !== prevTime ? (sampleTime - prevTime) / (nextTime - prevTime) : 0.0

        // Linear interpolation to get position at jittered time
        const pointX = prevPoint.x + alpha * (nextPoint.x - prevPoint.x)
        const pointY = prevPoint.y + alpha * (nextPoint.y - prevPoint.y)

        // Save interpolated position and the actual jittered time
        sampledPoints.push({ x: pointX, y: pointY })
        sampledTimings.push(sampleTime)

        // Step forward by the base interval (without jitter here)
        currentTime += baseStep
    }

    // Single distortion pass: knot -> jitter -> morph
    const dxTar = targetEnd.x - targetStart.x
    const dyTar = targetEnd.y - targetStart.y
    const lenTar = Math.hypot(dxTar, dyTar)

    // Knot the newly sampled points
    const sampledKnottedPoints = knotTrajectory(sampledPoints, targetStart, targetEnd, 5, 0.15, rng)

    // Apply jitter to the knotted points
    const sampledJitteredPoints = jitterTrajectory(sampledKnottedPoints, lenTar, 0.01, rng)

    // Morph the trajectory to fit exactly between start and end
    const sampledMorphedPoints = morphTrajectory(
        sampledJitteredPoints,
        targetStart,
        targetEnd,
        dxTar,
        dyTar,
        lenTar
    )

    return { points: sampledMorphedPoints, timings: sampledTimings }
}
