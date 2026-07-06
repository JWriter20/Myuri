"""Synthetic scroll-path generator, tuned to match real recorded human scrolling.

Python mirror of ``js/src/motion/scroll-model.ts`` (the source of truth).

The parameters below were fitted from recorded wheel-event traces captured on
real job-form pages (Greenhouse / Lever) with a 120 Hz trackpad. See
scripts/IDEAL_SCROLLS.json and scripts/analyze-scrolls.mjs for the source data
and the fits. The headline findings that drive this model:

  1. CADENCE is ~8 ms between events (~120 Hz), NOT the old 17 ms (~60 Hz).
     This alone was making the old model ~2x slower than a real user. Cadence
     stays ~8 ms across distances and only drifts up slightly (~10-11 ms) for
     very long (>2500 px) deliberate scrolls.

  2. The data is BIMODAL -- two coexisting regimes at every distance:
       - FLICK (~40% of scrolls): fewer events, bigger per-event deltas,
         fast overall pace (~4.9 px/ms median).
       - DRAG  (~60% of scrolls): more events, smaller deltas, slower pace
         (~2.8 px/ms median) -- reading/deliberate scrolling.
     The model picks a regime per gesture so the output distribution matches
     the real one instead of collapsing to a (wrong) single average.

  3. EVENT COUNT behaves differently per regime:
       - FLICK: roughly CONSTANT (~27 events) with only gentle linear growth
         in distance. The recordings show flicks of 860px and 2000px both use
         ~26-30 events -- the user fires a fixed number of wheel "kicks" and
         just makes each kick bigger for longer distances. So per-event delta
         (and thus pace) climbs steeply with distance.  count ~= 14 + 0.012*d.
       - DRAG: grows sub-linearly, more events for more distance: ~0.91*d^0.57.
     Per-event delta falls out of distance / eventCount in both cases.

  4. VELOCITY SHAPE: a fast ramp to an EARLY, SHARP peak (phase ~0.25-0.3),
     then a quick drop to a SUSTAINED plateau at ~0.22x of peak that rides to
     the end. Real gestures do NOT decelerate to zero -- the finger lifts while
     momentum is still carrying, so the last event is still ~0.2 of peak.

  5. MULTI-FLICK (long drags): a long DELIBERATE scroll (>~1800px in the slower
     drag regime) is not one motion but a sequence of discrete finger-flicks
     (~one per 1300px), each a sharp peak that decays toward a brief LULL where
     the fingers leave the trackpad (read a little) before the next flick. It
     ends fairly abruptly, often with a small CORRECTION scroll (sometimes a
     slight reverse) -- the "settle". Fast flicks stay a single committed burst
     regardless of distance; only the deliberate drag path multi-flicks.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from ..rng import Rng

__all__ = ["ScrollEvent", "ScrollModel", "scroll_model"]


def _js_round(x: float) -> int:
    """JavaScript ``Math.round``: half-values round toward +infinity."""
    return math.floor(x + 0.5)


def _sign(x: float) -> int:
    """JavaScript ``Math.sign`` restricted to the integer results used here."""
    return (x > 0) - (x < 0)


@dataclass
class ScrollEvent:
    """One dispatched wheel event: ms since the previous event, and its deltaY."""

    delta_time: float
    delta_y: int


class ScrollModel:
    # --- Cadence (ms between dispatched wheel events) ---
    # Median recorded inter-event dt was ~8.2 ms. Long deliberate scrolls drift
    # up to ~10-11 ms; BASE_DT_LONG is blended in between LONG_DT_START/FULL.
    BASE_DT = 8.2
    BASE_DT_LONG = 10.8
    # Cadence stays ~8.2ms until this distance, then drifts toward BASE_DT_LONG.
    # Recorded dt only rises past ~2500px, so start the ramp there, not earlier.
    LONG_DT_START = 2500
    LONG_DT_FULL = 4500
    DT_JITTER = 1.6  # +/- ms uniform jitter per event (recorded dt stdev ~1.5-2)
    MIN_DT = 5
    MAX_DT = 22

    # --- Regime mix (bimodal): probability a given scroll is a fast "flick" ---
    FLICK_PROBABILITY = 0.4

    # --- Event count per regime ---
    # FLICK: nearly constant + gentle linear growth (count ~= 14 + 0.012*d).
    #   Fixed number of "kicks", bigger deltas for longer distance => fast pace.
    FLICK_COUNT_BASE = 14
    FLICK_COUNT_PER_PX = 0.012
    # DRAG: power law, more events for more distance.
    DRAG_COUNT_A = 0.912
    DRAG_COUNT_K = 0.570
    MIN_EVENTS = 6
    MAX_REALISTIC_EVENTS = 200

    # --- Velocity curve shape (normalized phase 0..1) ---
    # Peak occurs early; afterwards velocity drops fast to a plateau and never
    # decays to zero. PLATEAU is the fraction of peak sustained through the tail.
    PEAK_PHASE = 0.28  # where peak velocity lands
    PLATEAU = 0.22  # sustained tail velocity, as fraction of peak
    START_VEL = 0.10  # initial velocity, as fraction of peak
    DECAY_EXP = 2.6  # higher => sharper drop from peak to plateau

    # --- Multi-flick structure (long DRAGS only) ---
    # The recordings show that long DELIBERATE scrolls (the slower "drag" regime)
    # are NOT one continuous motion: they are a sequence of discrete finger-flicks,
    # each ~25-35 events, separated by a brief lull where the fingers leave the
    # trackpad mid-momentum (read a little, flick again). The user then stops
    # fairly abruptly, sometimes with a small corrective scroll (occasionally a
    # slight reverse). Fast FLICKS, by contrast, stay a single burst even at
    # 2000px -- they're one committed "send it" motion. So multi-flick is keyed to
    # the drag regime + distance, not to flicks. Above the threshold a drag splits
    # into ceil(distance / FLICK_PX_EACH) flicks.
    MULTIFLICK_THRESHOLD = 1800  # px; below this, single continuous burst
    FLICK_PX_EACH = 1300  # px covered per individual flick
    MAX_FLICKS = 5
    FLICK_LULL_DT = 34  # ms gap between flicks (finger lift). recorded lulls ~2-4x cadence
    FLICK_LULL_JITTER = 14  # +/- ms on the lull
    # Each flick within a sequence decays toward this fraction of its peak before
    # the lull -- momentum is still carrying when the fingers lift, so it is NOT
    # zero, but lower than a standalone flick's plateau.
    FLICK_END_VEL = 0.12
    # Correction at the end of a long multi-flick scroll (the "settle" tap).
    CORRECTION_PROBABILITY = 0.5  # chance a multi-flick ends with a correction
    CORRECTION_FRACTION = 0.06  # correction size as fraction of total distance
    CORRECTION_REVERSE_CHANCE = 0.4  # chance the correction is a small reverse

    # Per-event speed noise, fitted from the recordings. Exposed as the default
    # for the optional `speed_irregularity` argument on generate_scroll_path so
    # settings.scroll.realism.speedIrregularity can override it.
    DEFAULT_SPEED_IRREGULARITY = 0.08

    def _estimate_target_events(self, distance_abs: float, is_flick: bool) -> int:
        if is_flick:
            raw = self.FLICK_COUNT_BASE + self.FLICK_COUNT_PER_PX * distance_abs
        else:
            raw = self.DRAG_COUNT_A * (max(distance_abs, 1) ** self.DRAG_COUNT_K)
        return max(self.MIN_EVENTS, min(_js_round(raw), self.MAX_REALISTIC_EVENTS))

    def _base_dt_for(self, distance_abs: float, rng: Rng) -> float:
        """Per-event cadence in ms, distance-aware with a mild upward drift for long scrolls."""
        t = max(
            0.0,
            min(1.0, (distance_abs - self.LONG_DT_START) / (self.LONG_DT_FULL - self.LONG_DT_START)),
        )
        base = self.BASE_DT + (self.BASE_DT_LONG - self.BASE_DT) * t
        jittered = base + (rng() - 0.5) * 2 * self.DT_JITTER
        return max(self.MIN_DT, min(self.MAX_DT, jittered))

    def _velocity_at(self, p: float, tail_level: float) -> float:
        """Normalized velocity at phase p (0..1): fast ramp from START_VEL to a peak
        of 1.0 at PEAK_PHASE, then a smooth decay toward ``tail_level``, which is
        held to the end. This reproduces the recorded "ramp -> early peak ->
        momentum tail" profile rather than a symmetric accelerate/decelerate-to-
        zero bell.

        ``tail_level`` is PLATEAU for a standalone gesture (momentum rides the
        plateau to the end) or FLICK_END_VEL for one flick inside a multi-flick
        sequence (velocity decays lower toward the lull, but not to zero --
        momentum is still carrying when the fingers lift).
        """
        if p <= self.PEAK_PHASE:
            # Ease-in ramp to the peak.
            ramp_progress = p / self.PEAK_PHASE
            return self.START_VEL + (1 - self.START_VEL) * (ramp_progress ** 1.4)
        # Decay from peak (1.0) toward the sustained tail level. A high
        # DECAY_EXP makes most of the drop happen just after the peak, then it
        # flattens out and rides the tail level to the end.
        decay_progress = (p - self.PEAK_PHASE) / (1 - self.PEAK_PHASE)
        return tail_level + (1 - tail_level) * ((1 - decay_progress) ** self.DECAY_EXP)

    def _build_burst(
        self,
        dist: float,
        events: int,
        rng: Rng,
        single: bool,
        speed_irregularity: float,
    ) -> "tuple[list[float], list[float]]":
        """Build the (dy, dt) arrays for a single burst of ``events`` events covering ``dist`` px."""
        sign_d = _sign(dist)
        abs_d = abs(dist)
        if events > 1:
            progress = [i / (events - 1) for i in range(events)]
        else:
            progress = [0.0]
        curve: "list[float]" = []
        for p in progress:
            # Standalone flicks ride a plateau to the end; flicks inside a sequence
            # decay toward the lull.
            v = self._velocity_at(p, self.PLATEAU if single else self.FLICK_END_VEL)
            noise = 1 + (rng() - 0.5) * 2 * speed_irregularity
            curve.append(max(0.02, v * noise))
        total = sum(curve)
        dy = [(v / total) * abs_d * sign_d for v in curve]
        dt = [self._base_dt_for(abs_d, rng) for _ in range(events)]
        return dy, dt

    def _generate_base_scroll_template(
        self,
        target_d: float,
        rng: Rng,
        is_flick: bool,
        speed_irregularity: float,
    ) -> "tuple[list[float], list[float]]":
        abs_d = abs(target_d)

        # Long DRAGS break into a sequence of discrete finger-flicks separated by
        # brief lulls, optionally ending in a small correction. Fast flicks (any
        # distance), and drags below the threshold, stay a single continuous burst.
        if not is_flick and abs_d >= self.MULTIFLICK_THRESHOLD:
            return self._generate_multi_flick(target_d, rng, speed_irregularity)

        events = self._estimate_target_events(abs_d, is_flick)

        # Single continuous burst with the plateau-tail curve (drags, and flicks
        # below the multi-flick threshold which read as one clean flick).
        return self._build_burst(target_d, events, rng, True, speed_irregularity)

    def _generate_multi_flick(
        self,
        target_d: float,
        rng: Rng,
        speed_irregularity: float,
    ) -> "tuple[list[float], list[float]]":
        """A long flick = several sub-flicks (each ~one FLICK_PX_EACH worth, 25-35
        events) separated by a lull event (a single long-dt gap = finger lift),
        optionally ending in a small correction scroll (sometimes a slight reverse).
        Reproduces the recorded "flick -> slow -> flick -> abrupt stop -> small fix".
        """
        sign_d = _sign(target_d)
        abs_d = abs(target_d)

        # Decide whether a correction tap closes out the gesture, and reserve its
        # distance from the main flicks.
        has_correction = rng() < self.CORRECTION_PROBABILITY
        reverse = has_correction and rng() < self.CORRECTION_REVERSE_CHANCE
        correction_abs = (
            _js_round(abs_d * self.CORRECTION_FRACTION * (0.5 + rng())) if has_correction else 0
        )
        # Main flicks carry the distance minus a forward correction (a reverse
        # correction overshoots first, so main flicks carry a bit MORE).
        main_abs = abs_d + correction_abs if reverse else abs_d - correction_abs

        num_flicks = max(2, min(self.MAX_FLICKS, _js_round(main_abs / self.FLICK_PX_EACH)))

        # Split the main distance across flicks with mild per-flick variation so
        # they are not all identical (recorded flicks within a gesture vary).
        weights = [0.75 + rng() * 0.5 for _ in range(num_flicks)]
        w_sum = sum(weights)
        flick_dists = [(w / w_sum) * main_abs * sign_d for w in weights]

        dy: "list[float]" = []
        dt: "list[float]" = []

        for f in range(num_flicks):
            # Sub-flicks inside a long deliberate scroll are a touch denser than a
            # standalone fast flick: size them between the flick and drag laws so
            # the total event count matches recorded multi-burst drags.
            flick_ev = self._estimate_target_events(abs(flick_dists[f]), True)
            drag_ev = self._estimate_target_events(abs(flick_dists[f]), False)
            f_events = _js_round((flick_ev + drag_ev) / 2)
            burst_dy, burst_dt = self._build_burst(
                flick_dists[f], f_events, rng, False, speed_irregularity
            )
            dy.extend(burst_dy)
            dt.extend(burst_dt)

            # Lull between flicks (not after the last): a brief reading pause where
            # the fingers are off the trackpad and momentum nearly stalls -- a long
            # gap plus a couple of slow residual glide events.
            if f < num_flicks - 1:
                glide_events = 1 + math.floor(rng() * 2)  # 1-2 residual glide events
                for _ in range(glide_events):
                    dy.append(sign_d * (1 + rng() * 2))  # near-zero residual glide
                    dt.append(self.FLICK_LULL_DT + (rng() - 0.5) * 2 * self.FLICK_LULL_JITTER)

        # Correction: a short pause then a small settle scroll (forward or reverse).
        if has_correction and correction_abs >= 2:
            dt.append(self.FLICK_LULL_DT + (rng() - 0.5) * 2 * self.FLICK_LULL_JITTER)
            dy.append((-sign_d if reverse else sign_d) * (1 + rng() * 2))
            corr_sign = -sign_d if reverse else sign_d
            corr_events = max(4, min(14, self._estimate_target_events(correction_abs, True)))
            corr_dy, corr_dt = self._build_burst(
                corr_sign * correction_abs, corr_events, rng, True, speed_irregularity
            )
            dy.extend(corr_dy)
            dt.extend(corr_dt)

        return dy, dt

    def _absorb_into_tail(self, path: "list[ScrollEvent]", remainder: int, max_events: int) -> int:
        """Absorb an integer ``remainder`` into the last ``max_events`` events of ``path``
        in +/-1 steps, round-robin from the end, WITHOUT ever flipping (or
        zeroing) an event's sign. Events whose magnitude would drop below 1 are
        skipped. Returns the portion of the remainder that could not be absorbed
        (0 in all but degenerate cases).
        """
        step = _sign(remainder)
        left = abs(remainder)
        while left > 0:
            applied = False
            for i in range(max_events):
                if left <= 0:
                    break
                ev = path[len(path) - 1 - i]
                nxt = ev.delta_y + step
                # Never flip or zero the event's sign (keeps the gesture
                # monotonic; growing an event is always safe).
                if nxt != 0 and _sign(nxt) == _sign(ev.delta_y):
                    ev.delta_y = nxt
                    left -= 1
                    applied = True
            if not applied:
                break
        return left * step

    def generate_scroll_path(
        self,
        desired_d: float,
        rng: Rng,
        force_flick: Optional[bool] = None,
        speed_irregularity: float = DEFAULT_SPEED_IRREGULARITY,
    ) -> "list[ScrollEvent]":
        """Generate a human-like wheel-event path covering ``desired_d`` px.

        :param rng: Seeded RNG; required so scroll paths stay reproducible.
        :param force_flick: Testing/validation hook: force the FLICK regime (True)
            or DRAG regime (False). Leave ``None`` in production so the regime is
            chosen probabilistically (FLICK_PROBABILITY).
        :param speed_irregularity: Per-event speed noise; defaults to the fitted
            value. Wired from settings.scroll.realism.speedIrregularity.

        Guarantees: every emitted delta_y is a non-zero integer, the signed sum of
        all delta_y values equals ``round(desired_d)`` (JS Math.round) exactly, and
        any request that rounds to a non-zero distance yields at least one event.
        Only a request that rounds to 0 px returns ``[]``.
        """
        # The integer distance the emitted events must sum to.
        target = _js_round(desired_d)
        if target == 0:
            return []  # sub-half-pixel request: nothing to scroll

        # Pick a regime for this gesture: ~40% fast flicks, ~60% slower drags.
        is_flick = force_flick if force_flick is not None else (rng() < self.FLICK_PROBABILITY)

        template_dy, template_dt = self._generate_base_scroll_template(
            desired_d, rng, is_flick, speed_irregularity
        )

        # Round every event to an integer delta_y. Events that round to 0 are
        # dropped, but their delta_time is folded into the next kept event (or
        # the previous one at the tail) so the gesture's total duration is
        # preserved.
        gen_path: "list[ScrollEvent]" = []
        pending_dt = 0
        for i in range(len(template_dy)):
            rounded_dt = max(self.MIN_DT, _js_round(template_dt[i]))
            rounded_dy = _js_round(template_dy[i])

            if rounded_dy != 0:
                gen_path.append(ScrollEvent(delta_time=rounded_dt + pending_dt, delta_y=rounded_dy))
                pending_dt = 0
            else:
                pending_dt += rounded_dt
        if pending_dt > 0 and len(gen_path) > 0:
            gen_path[-1].delta_time += pending_dt

        # Tiny scrolls (e.g. 2-5px) can round every template event to 0. Never
        # return [] for a non-zero request: emit one event carrying the whole
        # distance and the accumulated duration.
        if len(gen_path) == 0:
            return [ScrollEvent(delta_time=max(self.MIN_DT, pending_dt), delta_y=target)]

        # Distribute the integer remainder so the signed sum equals `target`
        # exactly, without flipping any event's sign.
        current_sum = sum(p.delta_y for p in gen_path)
        remainder = target - current_sum

        if remainder != 0:
            remainder_percent = abs(remainder) / abs(target)

            if abs(remainder) <= 3:
                # Small remainder: fold it into the last event.
                remainder = self._absorb_into_tail(gen_path, remainder, 1)
            elif remainder_percent <= 0.08:
                # Moderate remainder: spread it across up to 5 tail events.
                remainder = self._absorb_into_tail(gen_path, remainder, min(5, len(gen_path)))

            if remainder != 0:
                if _sign(remainder) == _sign(target):
                    # Larger same-direction remainder: append a few extra scroll
                    # events to smooth it out (1-3 events based on size).
                    num_remainder_events = max(1, min(3, math.ceil(abs(remainder) / 25)))
                    per_event = math.trunc(remainder / num_remainder_events)
                    left = remainder
                    for i in range(num_remainder_events):
                        is_last = i == num_remainder_events - 1
                        delta_y = left if is_last else per_event
                        if delta_y == 0:
                            continue
                        gen_path.append(
                            ScrollEvent(
                                delta_time=_js_round(self._base_dt_for(abs(desired_d), rng)),
                                delta_y=delta_y,
                            )
                        )
                        left -= delta_y
                    remainder = left
                else:
                    # Opposite-direction remainder: shrink existing events across
                    # the whole path rather than appending reverse events, which
                    # would stutter the gesture (down -> up -> down).
                    remainder = self._absorb_into_tail(gen_path, remainder, len(gen_path))

            if remainder != 0:
                # Degenerate path with no sign-safe capacity left: collapse to a
                # single event carrying the exact distance and full duration.
                total_dt = sum(p.delta_time for p in gen_path)
                gen_path.clear()
                gen_path.append(ScrollEvent(delta_time=total_dt, delta_y=target))

        return gen_path


scroll_model = ScrollModel()
