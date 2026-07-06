import type { Rng } from '../rng.js'

export interface ScrollEvent {
    deltaTime: number
    deltaY: number
}

/**
 * Synthetic scroll-path generator, tuned to match real recorded human scrolling.
 *
 * The parameters below were fitted from recorded wheel-event traces captured on
 * real job-form pages (Greenhouse / Lever) with a 120 Hz trackpad. See
 * scripts/IDEAL_SCROLLS.json and scripts/analyze-scrolls.mjs for the source data
 * and the fits. The headline findings that drive this model:
 *
 *   1. CADENCE is ~8 ms between events (≈120 Hz), NOT the old 17 ms (≈60 Hz).
 *      This alone was making the old model ~2x slower than a real user. Cadence
 *      stays ~8 ms across distances and only drifts up slightly (~10–11 ms) for
 *      very long (>2500 px) deliberate scrolls.
 *
 *   2. The data is BIMODAL — two coexisting regimes at every distance:
 *        - FLICK (~40% of scrolls): fewer events, bigger per-event deltas,
 *          fast overall pace (~4.9 px/ms median).
 *        - DRAG  (~60% of scrolls): more events, smaller deltas, slower pace
 *          (~2.8 px/ms median) — reading/deliberate scrolling.
 *      The model picks a regime per gesture so the output distribution matches
 *      the real one instead of collapsing to a (wrong) single average.
 *
 *   3. EVENT COUNT behaves differently per regime:
 *        - FLICK: roughly CONSTANT (~27 events) with only gentle linear growth
 *          in distance. The recordings show flicks of 860px and 2000px both use
 *          ~26–30 events — the user fires a fixed number of wheel "kicks" and
 *          just makes each kick bigger for longer distances. So per-event delta
 *          (and thus pace) climbs steeply with distance.  count ≈ 14 + 0.012*d.
 *        - DRAG: grows sub-linearly, more events for more distance: ~0.91*d^0.57.
 *      Per-event delta falls out of distance / eventCount in both cases.
 *
 *   4. VELOCITY SHAPE: a fast ramp to an EARLY, SHARP peak (phase ~0.25–0.3),
 *      then a quick drop to a SUSTAINED plateau at ~0.22x of peak that rides to
 *      the end. Real gestures do NOT decelerate to zero — the finger lifts while
 *      momentum is still carrying, so the last event is still ~0.2 of peak.
 *
 *   5. MULTI-FLICK (long drags): a long DELIBERATE scroll (>~1800px in the slower
 *      drag regime) is not one motion but a sequence of discrete finger-flicks
 *      (~one per 1300px), each a sharp peak that decays toward a brief LULL where
 *      the fingers leave the trackpad (read a little) before the next flick. It
 *      ends fairly abruptly, often with a small CORRECTION scroll (sometimes a
 *      slight reverse) — the "settle". Fast flicks stay a single committed burst
 *      regardless of distance; only the deliberate drag path multi-flicks.
 */
class ScrollModel {
    // --- Cadence (ms between dispatched wheel events) ---
    // Median recorded inter-event dt was ~8.2 ms. Long deliberate scrolls drift
    // up to ~10–11 ms; BASE_DT_LONG is blended in between LONG_DT_START/FULL.
    private readonly BASE_DT = 8.2
    private readonly BASE_DT_LONG = 10.8
    // Cadence stays ~8.2ms until this distance, then drifts toward BASE_DT_LONG.
    // Recorded dt only rises past ~2500px, so start the ramp there, not earlier.
    private readonly LONG_DT_START = 2500
    private readonly LONG_DT_FULL = 4500
    private readonly DT_JITTER = 1.6      // +/- ms uniform jitter per event (recorded dt stdev ~1.5–2)
    private readonly MIN_DT = 5
    private readonly MAX_DT = 22

    // --- Regime mix (bimodal): probability a given scroll is a fast "flick" ---
    private readonly FLICK_PROBABILITY = 0.4

    // --- Event count per regime ---
    // FLICK: nearly constant + gentle linear growth (count ≈ 14 + 0.012*d).
    //   Fixed number of "kicks", bigger deltas for longer distance => fast pace.
    private readonly FLICK_COUNT_BASE = 14
    private readonly FLICK_COUNT_PER_PX = 0.012
    // DRAG: power law, more events for more distance.
    private readonly DRAG_COUNT_A = 0.912
    private readonly DRAG_COUNT_K = 0.570
    private readonly MIN_EVENTS = 6
    private readonly MAX_REALISTIC_EVENTS = 200

    // --- Velocity curve shape (normalized phase 0..1) ---
    // Peak occurs early; afterwards velocity drops fast to a plateau and never
    // decays to zero. PLATEAU is the fraction of peak sustained through the tail.
    private readonly PEAK_PHASE = 0.28     // where peak velocity lands
    private readonly PLATEAU = 0.22        // sustained tail velocity, as fraction of peak
    private readonly START_VEL = 0.10      // initial velocity, as fraction of peak
    private readonly DECAY_EXP = 2.6       // higher => sharper drop from peak to plateau

    // --- Multi-flick structure (long DRAGS only) ---
    // The recordings show that long DELIBERATE scrolls (the slower "drag" regime)
    // are NOT one continuous motion: they are a sequence of discrete finger-flicks,
    // each ~25-35 events, separated by a brief lull where the fingers leave the
    // trackpad mid-momentum (read a little, flick again). The user then stops
    // fairly abruptly, sometimes with a small corrective scroll (occasionally a
    // slight reverse). Fast FLICKS, by contrast, stay a single burst even at
    // 2000px — they're one committed "send it" motion. So multi-flick is keyed to
    // the drag regime + distance, not to flicks. Above the threshold a drag splits
    // into ceil(distance / FLICK_PX_EACH) flicks.
    private readonly MULTIFLICK_THRESHOLD = 1800   // px; below this, single continuous burst
    private readonly FLICK_PX_EACH = 1300          // px covered per individual flick
    private readonly MAX_FLICKS = 5
    private readonly FLICK_LULL_DT = 34            // ms gap between flicks (finger lift). recorded lulls ~2-4x cadence
    private readonly FLICK_LULL_JITTER = 14        // +/- ms on the lull
    // Each flick within a sequence decays toward this fraction of its peak before
    // the lull — momentum is still carrying when the fingers lift, so it is NOT
    // zero, but lower than a standalone flick's plateau.
    private readonly FLICK_END_VEL = 0.12
    // Correction at the end of a long multi-flick scroll (the "settle" tap).
    private readonly CORRECTION_PROBABILITY = 0.5  // chance a multi-flick ends with a correction
    private readonly CORRECTION_FRACTION = 0.06    // correction size as fraction of total distance
    private readonly CORRECTION_REVERSE_CHANCE = 0.4 // chance the correction is a small reverse

    // Per-event speed noise, fitted from the recordings. Exposed as the default
    // for the optional `speedIrregularity` argument on generateScrollPath so
    // settings.scroll.realism.speedIrregularity can override it.
    static readonly DEFAULT_SPEED_IRREGULARITY = 0.08

    private estimateTargetEvents(distanceAbs: number, isFlick: boolean): number {
        const raw = isFlick
            ? this.FLICK_COUNT_BASE + this.FLICK_COUNT_PER_PX * distanceAbs
            : this.DRAG_COUNT_A * Math.pow(Math.max(distanceAbs, 1), this.DRAG_COUNT_K)
        return Math.max(this.MIN_EVENTS, Math.min(Math.round(raw), this.MAX_REALISTIC_EVENTS))
    }

    /** Per-event cadence in ms, distance-aware with a mild upward drift for long scrolls. */
    private baseDtFor(distanceAbs: number, rng: Rng): number {
        const t = Math.max(0, Math.min(1, (distanceAbs - this.LONG_DT_START) / (this.LONG_DT_FULL - this.LONG_DT_START)))
        const base = this.BASE_DT + (this.BASE_DT_LONG - this.BASE_DT) * t
        const jittered = base + (rng() - 0.5) * 2 * this.DT_JITTER
        return Math.max(this.MIN_DT, Math.min(this.MAX_DT, jittered))
    }

    /**
     * Normalized velocity at phase p (0..1): fast ramp from START_VEL to a peak
     * of 1.0 at PEAK_PHASE, then a smooth decay toward `tailLevel`, which is
     * held to the end. This reproduces the recorded "ramp → early peak →
     * momentum tail" profile rather than a symmetric accelerate/decelerate-to-
     * zero bell.
     *
     * `tailLevel` is PLATEAU for a standalone gesture (momentum rides the
     * plateau to the end) or FLICK_END_VEL for one flick inside a multi-flick
     * sequence (velocity decays lower toward the lull, but not to zero —
     * momentum is still carrying when the fingers lift).
     */
    private velocityAt(p: number, tailLevel: number): number {
        if (p <= this.PEAK_PHASE) {
            // Ease-in ramp to the peak.
            const rampProgress = p / this.PEAK_PHASE
            return this.START_VEL + (1 - this.START_VEL) * Math.pow(rampProgress, 1.4)
        }
        // Decay from peak (1.0) toward the sustained tail level. A high
        // DECAY_EXP makes most of the drop happen just after the peak, then it
        // flattens out and rides the tail level to the end.
        const decayProgress = (p - this.PEAK_PHASE) / (1 - this.PEAK_PHASE)
        return tailLevel + (1 - tailLevel) * Math.pow(1 - decayProgress, this.DECAY_EXP)
    }

    /** Build the dy/dt arrays for a single burst of `events` events covering `dist` px. */
    private buildBurst(dist: number, events: number, rng: Rng, single: boolean, speedIrregularity: number): { dy: number[], dt: number[] } {
        const signD = Math.sign(dist)
        const absD = Math.abs(dist)
        const progress = events > 1
            ? Array.from({ length: events }, (_, i) => i / (events - 1))
            : [0]
        const curve = progress.map(p => {
            // Standalone flicks ride a plateau to the end; flicks inside a sequence
            // decay toward the lull.
            const v = this.velocityAt(p, single ? this.PLATEAU : this.FLICK_END_VEL)
            const noise = 1 + (rng() - 0.5) * 2 * speedIrregularity
            return Math.max(0.02, v * noise)
        })
        const sum = curve.reduce((a, b) => a + b, 0)
        const dy = curve.map(v => (v / sum) * absD * signD)
        const dt = Array.from({ length: events }, () => this.baseDtFor(absD, rng))
        return { dy, dt }
    }

    private generateBaseScrollTemplate(targetD: number, rng: Rng, isFlick: boolean, speedIrregularity: number): { dy: number[], dt: number[] } {
        const absD = Math.abs(targetD)

        // Long DRAGS break into a sequence of discrete finger-flicks separated by
        // brief lulls, optionally ending in a small correction. Fast flicks (any
        // distance), and drags below the threshold, stay a single continuous burst.
        if (!isFlick && absD >= this.MULTIFLICK_THRESHOLD) {
            return this.generateMultiFlick(targetD, rng, speedIrregularity)
        }

        const events = this.estimateTargetEvents(absD, isFlick)

        // Single continuous burst with the plateau-tail curve (drags, and flicks
        // below the multi-flick threshold which read as one clean flick).
        return this.buildBurst(targetD, events, rng, true, speedIrregularity)
    }

    /**
     * A long flick = several sub-flicks (each ~one FLICK_PX_EACH worth, 25-35
     * events) separated by a lull event (a single long-dt gap = finger lift),
     * optionally ending in a small correction scroll (sometimes a slight reverse).
     * Reproduces the recorded "flick → slow → flick → abrupt stop → small fix".
     */
    private generateMultiFlick(targetD: number, rng: Rng, speedIrregularity: number): { dy: number[], dt: number[] } {
        const signD = Math.sign(targetD)
        const absD = Math.abs(targetD)

        // Decide whether a correction tap closes out the gesture, and reserve its
        // distance from the main flicks.
        const hasCorrection = rng() < this.CORRECTION_PROBABILITY
        const reverse = hasCorrection && rng() < this.CORRECTION_REVERSE_CHANCE
        const correctionAbs = hasCorrection
            ? Math.round(absD * this.CORRECTION_FRACTION * (0.5 + rng()))
            : 0
        // Main flicks carry the distance minus a forward correction (a reverse
        // correction overshoots first, so main flicks carry a bit MORE).
        const mainAbs = reverse ? absD + correctionAbs : absD - correctionAbs

        const numFlicks = Math.max(2, Math.min(this.MAX_FLICKS, Math.round(mainAbs / this.FLICK_PX_EACH)))

        // Split the main distance across flicks with mild per-flick variation so
        // they are not all identical (recorded flicks within a gesture vary).
        const weights = Array.from({ length: numFlicks }, () => 0.75 + rng() * 0.5)
        const wSum = weights.reduce((a, b) => a + b, 0)
        const flickDists = weights.map(w => (w / wSum) * mainAbs * signD)

        const dy: number[] = []
        const dt: number[] = []

        for (let f = 0; f < numFlicks; f++) {
            // Sub-flicks inside a long deliberate scroll are a touch denser than a
            // standalone fast flick: size them between the flick and drag laws so
            // the total event count matches recorded multi-burst drags.
            const flickEv = this.estimateTargetEvents(Math.abs(flickDists[f]), true)
            const dragEv = this.estimateTargetEvents(Math.abs(flickDists[f]), false)
            const fEvents = Math.round((flickEv + dragEv) / 2)
            const burst = this.buildBurst(flickDists[f], fEvents, rng, false, speedIrregularity)
            dy.push(...burst.dy)
            dt.push(...burst.dt)

            // Lull between flicks (not after the last): a brief reading pause where
            // the fingers are off the trackpad and momentum nearly stalls — a long
            // gap plus a couple of slow residual glide events.
            if (f < numFlicks - 1) {
                const glideEvents = 1 + Math.floor(rng() * 2) // 1-2 residual glide events
                for (let k = 0; k < glideEvents; k++) {
                    dy.push(signD * (1 + rng() * 2)) // near-zero residual glide
                    dt.push(this.FLICK_LULL_DT + (rng() - 0.5) * 2 * this.FLICK_LULL_JITTER)
                }
            }
        }

        // Correction: a short pause then a small settle scroll (forward or reverse).
        if (hasCorrection && correctionAbs >= 2) {
            dt.push(this.FLICK_LULL_DT + (rng() - 0.5) * 2 * this.FLICK_LULL_JITTER)
            dy.push((reverse ? -signD : signD) * (1 + rng() * 2))
            const corrSign = reverse ? -signD : signD
            const corrEvents = Math.max(4, Math.min(14, this.estimateTargetEvents(correctionAbs, true)))
            const corr = this.buildBurst(corrSign * correctionAbs, corrEvents, rng, true, speedIrregularity)
            dy.push(...corr.dy)
            dt.push(...corr.dt)
        }

        return { dy, dt }
    }

    /**
     * Absorb an integer `remainder` into the last `maxEvents` events of `path`
     * in +/-1 steps, round-robin from the end, WITHOUT ever flipping (or
     * zeroing) an event's sign. Events whose magnitude would drop below 1 are
     * skipped. Returns the portion of the remainder that could not be absorbed
     * (0 in all but degenerate cases).
     */
    private absorbIntoTail(path: ScrollEvent[], remainder: number, maxEvents: number): number {
        const step = Math.sign(remainder)
        let left = Math.abs(remainder)
        while (left > 0) {
            let applied = false
            for (let i = 0; i < maxEvents && left > 0; i++) {
                const ev = path[path.length - 1 - i]
                const next = ev.deltaY + step
                // Never flip or zero the event's sign (keeps the gesture
                // monotonic; growing an event is always safe).
                if (next !== 0 && Math.sign(next) === Math.sign(ev.deltaY)) {
                    ev.deltaY = next
                    left--
                    applied = true
                }
            }
            if (!applied) break
        }
        return left * step
    }

    /**
     * @param rng  Seeded RNG; required so scroll paths stay reproducible.
     * @param forceFlick  Testing/validation hook: force the FLICK regime (true)
     *   or DRAG regime (false). Leave undefined in production so the regime is
     *   chosen probabilistically (FLICK_PROBABILITY).
     * @param speedIrregularity  Per-event speed noise; defaults to the fitted
     *   value. Wired from settings.scroll.realism.speedIrregularity.
     *
     * Guarantees: every emitted deltaY is a non-zero integer, the signed sum of
     * all deltaY values equals Math.round(desiredD) exactly, and any request
     * that rounds to a non-zero distance yields at least one event. Only a
     * request that rounds to 0 px returns [].
     */
    public generateScrollPath(desiredD: number, rng: Rng, forceFlick?: boolean, speedIrregularity: number = ScrollModel.DEFAULT_SPEED_IRREGULARITY): ScrollEvent[] {
        // The integer distance the emitted events must sum to.
        const target = Math.round(desiredD)
        if (target === 0) {
            return [] // sub-half-pixel request: nothing to scroll
        }

        // Pick a regime for this gesture: ~40% fast flicks, ~60% slower drags.
        const isFlick = forceFlick ?? (rng() < this.FLICK_PROBABILITY)

        const template = this.generateBaseScrollTemplate(desiredD, rng, isFlick, speedIrregularity)

        // Round every event to an integer deltaY. Events that round to 0 are
        // dropped, but their deltaTime is folded into the next kept event (or
        // the previous one at the tail) so the gesture's total duration is
        // preserved.
        const genPath: ScrollEvent[] = []
        let pendingDt = 0
        for (let i = 0; i < template.dy.length; i++) {
            const roundedDt = Math.max(this.MIN_DT, Math.round(template.dt[i]))
            const roundedDy = Math.round(template.dy[i])

            if (roundedDy !== 0) {
                genPath.push({
                    deltaTime: roundedDt + pendingDt,
                    deltaY: roundedDy
                })
                pendingDt = 0
            } else {
                pendingDt += roundedDt
            }
        }
        if (pendingDt > 0 && genPath.length > 0) {
            genPath[genPath.length - 1].deltaTime += pendingDt
        }

        // Tiny scrolls (e.g. 2-5px) can round every template event to 0. Never
        // return [] for a non-zero request: emit one event carrying the whole
        // distance and the accumulated duration.
        if (genPath.length === 0) {
            return [{
                deltaTime: Math.max(this.MIN_DT, pendingDt),
                deltaY: target
            }]
        }

        // Distribute the integer remainder so the signed sum equals `target`
        // exactly, without flipping any event's sign.
        const currentSum = genPath.reduce((sum, p) => sum + p.deltaY, 0)
        let remainder = target - currentSum

        if (remainder !== 0) {
            const remainderPercent = Math.abs(remainder) / Math.abs(target)

            if (Math.abs(remainder) <= 3) {
                // Small remainder: fold it into the last event.
                remainder = this.absorbIntoTail(genPath, remainder, 1)
            } else if (remainderPercent <= 0.08) {
                // Moderate remainder: spread it across up to 5 tail events.
                remainder = this.absorbIntoTail(genPath, remainder, Math.min(5, genPath.length))
            }

            if (remainder !== 0) {
                if (Math.sign(remainder) === Math.sign(target)) {
                    // Larger same-direction remainder: append a few extra scroll
                    // events to smooth it out (1-3 events based on size).
                    const numRemainderEvents = Math.max(1, Math.min(3, Math.ceil(Math.abs(remainder) / 25)))
                    const perEvent = Math.trunc(remainder / numRemainderEvents)
                    let left = remainder
                    for (let i = 0; i < numRemainderEvents; i++) {
                        const isLast = i === numRemainderEvents - 1
                        const deltaY = isLast ? left : perEvent
                        if (deltaY === 0) continue
                        genPath.push({
                            deltaTime: Math.round(this.baseDtFor(Math.abs(desiredD), rng)),
                            deltaY,
                        })
                        left -= deltaY
                    }
                    remainder = left
                } else {
                    // Opposite-direction remainder: shrink existing events across
                    // the whole path rather than appending reverse events, which
                    // would stutter the gesture (down -> up -> down).
                    remainder = this.absorbIntoTail(genPath, remainder, genPath.length)
                }
            }

            if (remainder !== 0) {
                // Degenerate path with no sign-safe capacity left: collapse to a
                // single event carrying the exact distance and full duration.
                const totalDt = genPath.reduce((sum, p) => sum + p.deltaTime, 0)
                genPath.length = 0
                genPath.push({ deltaTime: totalDt, deltaY: target })
            }
        }

        return genPath
    }

}

export const scrollModel = new ScrollModel()
