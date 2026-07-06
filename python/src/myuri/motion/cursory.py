"""Human-like mouse trajectory generation from recorded data.

Python mirror of ``js/src/motion/cursory.ts`` (the source of truth).
"""

from __future__ import annotations

import math
from typing import List, Optional, Tuple

from ..rng import Rng, default_rng, gaussian
from ..types import Vector
from .trajectory import find_trajectory, jitter_trajectory, knot_trajectory, morph_trajectory

__all__ = ["generate_trajectory"]


def _js_round(x: float) -> int:
    """JavaScript ``Math.round``: half-values round toward +infinity."""
    return math.floor(x + 0.5)


def generate_trajectory(
    target_start: Vector,
    target_end: Vector,
    frequency: float = 60,
    frequency_randomizer: float = 1,
    rng: Optional[Rng] = None,
) -> Tuple[List[Vector], List[float]]:
    """Generate a realistic mouse trajectory from start to end points using human data.

    :func:`find_trajectory` returns the closest recorded trajectory deterministically
    fitted to the target endpoints (no random distortion). The resampled points
    then go through the knot -> jitter -> morph distortion pipeline exactly once
    here, so deviation is applied a single time per call.

    :param target_start: Starting point of the trajectory
    :param target_end: Ending point of the trajectory
    :param frequency: Number of samples per second (hz), default is 60
    :param frequency_randomizer: Max jitter in ms to apply to each sample time, default is 1
    :param rng: Seeded random source; the same rng stream yields the same trajectory
    :returns: ``(points, timings)`` -- trajectory points and their timings in ms
    """
    if rng is None:
        rng = default_rng  # unseeded fallback; mirrors defaultRng in rng.ts

    # Closest recorded trajectory, fitted to the target endpoints (undistorted)
    trajectory_points, timings = find_trajectory(target_start, target_end, rng)

    # Normalize timings to start at 0
    normalized_timings = [t - timings[0] for t in timings]
    total_time = normalized_timings[-1] if normalized_timings else float("-inf")

    # Milliseconds between samples
    base_step = 1000 / frequency

    sampled_points: List[Vector] = []
    sampled_timings: List[float] = []

    # Sample the trajectory at regular intervals with jitter
    current_time = 0.0

    while current_time <= total_time:
        # Apply Gaussian jitter to the current sampling time
        jitter_scale = max(1.5, frequency_randomizer)
        jitter = _js_round(gaussian(rng, 0, frequency_randomizer / jitter_scale))

        # Clamp jitter
        jitter = max(-frequency_randomizer, min(frequency_randomizer, jitter))

        # Clamp the jittered time within the trajectory duration
        sample_time = max(0, min(total_time, current_time + jitter))

        # Find surrounding keyframes for the jittered time
        prev_idx = 0
        for i in range(len(normalized_timings)):
            if normalized_timings[i] <= sample_time:
                prev_idx = i
            else:
                break
        next_idx = min(prev_idx + 1, len(normalized_timings) - 1)

        prev_point = trajectory_points[prev_idx]
        next_point = trajectory_points[next_idx]
        prev_time = normalized_timings[prev_idx]
        next_time = normalized_timings[next_idx]

        # Interpolation factor
        alpha = (sample_time - prev_time) / (next_time - prev_time) if next_time != prev_time else 0.0

        # Linear interpolation to get position at jittered time
        point_x = prev_point.x + alpha * (next_point.x - prev_point.x)
        point_y = prev_point.y + alpha * (next_point.y - prev_point.y)

        # Save interpolated position and the actual jittered time
        sampled_points.append(Vector(point_x, point_y))
        sampled_timings.append(sample_time)

        # Step forward by the base interval (without jitter here)
        current_time += base_step

    # Single distortion pass: knot -> jitter -> morph
    dx_tar = target_end.x - target_start.x
    dy_tar = target_end.y - target_start.y
    len_tar = math.hypot(dx_tar, dy_tar)

    # Knot the newly sampled points
    sampled_knotted_points = knot_trajectory(sampled_points, target_start, target_end, 5, 0.15, rng)

    # Apply jitter to the knotted points
    sampled_jittered_points = jitter_trajectory(sampled_knotted_points, len_tar, 0.01, rng)

    # Morph the trajectory to fit exactly between start and end
    sampled_morphed_points = morph_trajectory(
        sampled_jittered_points,
        target_start,
        target_end,
        dx_tar,
        dy_tar,
        len_tar,
    )

    return sampled_morphed_points, sampled_timings
