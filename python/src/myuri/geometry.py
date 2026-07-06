"""Box/point geometry and path generation (mirror of ``js/src/geometry.ts``)."""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import List, Optional, Sequence, Union

from .motion.cursory import generate_trajectory
from .options import BoxOptions, PathOptions
from .rng import Rng, gaussian
from .types import BoundingBox, TimedVector, Vector, ViewportSize, direction, magnitude

VIEWPORT_PADDING = 10
"""Keep the cursor at least this many px from the viewport edges."""


def clamp_to_browser_bounds(x: float, y: float, viewport: ViewportSize) -> Vector:
    """Clamp a point so it stays :data:`VIEWPORT_PADDING` px inside the viewport."""
    return Vector(
        x=max(VIEWPORT_PADDING, min(x, viewport.width - VIEWPORT_PADDING)),
        y=max(VIEWPORT_PADDING, min(y, viewport.height - VIEWPORT_PADDING)),
    )


def _clamp_pct(v: Optional[float]) -> Optional[float]:
    return None if v is None else max(0.0, min(100.0, v))


@dataclass(frozen=True)
class SidePadding:
    """Resolved per-side padding, in pixels."""

    left: float
    right: float
    top: float
    bottom: float


def resolve_side_padding_px(
    size: Union[BoundingBox, ViewportSize],
    options: Optional[BoxOptions] = None,
    default_width_padding_percentage: float = 0.0,
    default_height_padding_percentage: float = 0.0,
) -> SidePadding:
    """Resolve per-side padding (px) for a box.

    Per-side options take precedence; otherwise the axis percentage is split
    symmetrically. Overflowing pairs are scaled down so the effective area
    stays non-negative.
    """
    width = size.width
    height = size.height

    width_pct = _clamp_pct(options.width_padding_percentage if options else None)
    if width_pct is None:
        width_pct = default_width_padding_percentage
    height_pct = _clamp_pct(options.height_padding_percentage if options else None)
    if height_pct is None:
        height_pct = default_height_padding_percentage

    left_pct = _clamp_pct(options.padding_left if options else None)
    if left_pct is None:
        left_pct = width_pct / 2
    right_pct = _clamp_pct(options.padding_right if options else None)
    if right_pct is None:
        right_pct = width_pct / 2
    top_pct = _clamp_pct(options.padding_top if options else None)
    if top_pct is None:
        top_pct = height_pct / 2
    bottom_pct = _clamp_pct(options.padding_bottom if options else None)
    if bottom_pct is None:
        bottom_pct = height_pct / 2

    left = width * left_pct / 100
    right = width * right_pct / 100
    top = height * top_pct / 100
    bottom = height * bottom_pct / 100

    if left + right > width:
        scale = width / (left + right)
        left *= scale
        right *= scale
    if top + bottom > height:
        scale = height / (top + bottom)
        top *= scale
        bottom *= scale
    return SidePadding(left=left, right=right, top=top, bottom=bottom)


def is_point_excluded(point: Vector, boxes: Optional[Sequence[BoundingBox]]) -> bool:
    """True if ``point`` lies inside any of ``boxes`` (inclusive edges)."""
    if not boxes:
        return False
    return any(
        b.x <= point.x <= b.x + b.width and b.y <= point.y <= b.y + b.height for b in boxes
    )


def get_random_box_point(
    box: BoundingBox,
    options: Optional[BoxOptions],
    current_position: Optional[Vector],
    exclude_boxes: Optional[Sequence[BoundingBox]],
    rng: Rng,
) -> Vector:
    """Choose a natural point inside a box.

    Without a current position, samples a center-biased Gaussian; with one,
    scores several candidates by travel distance and center proximity.
    Respects exclude boxes via rejection sampling.
    """
    is_small = box.width < 40 or box.height < 40
    sides = resolve_side_padding_px(
        box,
        options,
        default_width_padding_percentage=50 if is_small else 25,
        default_height_padding_percentage=70,
    )

    eff_x = box.x + sides.left
    eff_y = box.y + sides.top
    eff_w = max(0.0, box.width - sides.left - sides.right)
    eff_h = max(0.0, box.height - sides.top - sides.bottom)
    has_excludes = exclude_boxes is not None and len(exclude_boxes) > 0

    def sample_normal(spread: float) -> Vector:
        # Sample x before y so the rng call order matches the TS reference.
        px = eff_x + max(0.0, min(1.0, gaussian(rng) * spread + 0.5)) * eff_w
        py = eff_y + max(0.0, min(1.0, gaussian(rng) * spread + 0.5)) * eff_h
        return Vector(px, py)

    def sample_uniform() -> Vector:
        px = eff_x + rng() * eff_w
        py = eff_y + rng() * eff_h
        return Vector(px, py)

    if current_position is None:
        max_attempts = 64 if has_excludes else 1
        for _ in range(max_attempts):
            p = sample_normal(0.2)
            if not is_point_excluded(p, exclude_boxes):
                return Vector(_js_round(p.x), _js_round(p.y))
        for _ in range(128):
            p = sample_uniform()
            if not is_point_excluded(p, exclude_boxes):
                return Vector(_js_round(p.x), _js_round(p.y))
        raise RuntimeError("myuri: could not find a non-excluded point inside target bounds")

    candidates: List[Vector] = [sample_normal(0.25) for _ in range(10)]
    if has_excludes:
        candidates = [c for c in candidates if not is_point_excluded(c, exclude_boxes)]
        i = 0
        while i < 128 and len(candidates) < 10:
            p = sample_uniform()
            if not is_point_excluded(p, exclude_boxes):
                candidates.append(p)
            i += 1
        if not candidates:
            raise RuntimeError("myuri: could not find a non-excluded point inside target bounds")

    center_x = eff_x + eff_w / 2
    center_y = eff_y + eff_h / 2
    best = candidates[0]
    best_score = math.inf
    for c in candidates:
        dist = math.hypot(c.x - current_position.x, c.y - current_position.y)
        center_dist = math.hypot(c.x - center_x, c.y - center_y)
        score = dist * 0.7 + center_dist * 0.3
        if score < best_score:
            best_score = score
            best = c
    return Vector(_js_round(best.x), _js_round(best.y))


def get_better_starting_position(
    dimensions: Optional[ViewportSize],
    rng: Rng,
) -> Vector:
    """A natural off-origin starting position (center-left of the viewport)."""
    width = dimensions.width if dimensions is not None else 1920
    height = dimensions.height if dimensions is not None else 1080
    # x consumes the first rng() draw, y the second (matches the TS reference).
    x = width * 0.2 + rng() * 0.15
    y = height * 0.35 + rng() * 0.2
    return Vector(x, y)


def should_overshoot(a: Vector, b: Vector, threshold: float) -> bool:
    """True when the straight-line distance from ``a`` to ``b`` exceeds ``threshold``."""
    return magnitude(direction(a, b)) > threshold


def _js_round(v: float) -> float:
    """JS ``Math.round`` semantics: halves round toward +Infinity."""
    return math.floor(v + 0.5)


def _ensure_terminal_point(path_points: List[TimedVector], end: Vector) -> List[TimedVector]:
    """Force the last point of the path to land exactly on ``end``."""
    if not path_points:
        return []
    last = path_points[-1]
    return path_points[:-1] + [TimedVector(x=end.x, y=end.y, timestamp=last.timestamp)]


def path(
    start: Vector,
    end: Union[BoundingBox, Vector],
    options: Optional[PathOptions],
    rng: Rng,
) -> List[TimedVector]:
    """Generate a timed, human-like path from ``start`` to a point or box."""
    opts = options if options is not None else PathOptions()
    if isinstance(end, BoundingBox):
        end_point = Vector(end.x + end.width / 2, end.y + end.height / 2)
    else:
        end_point = end

    distance = math.hypot(end_point.x - start.x, end_point.y - start.y)
    points, timings = generate_trajectory(Vector(start.x, start.y), end_point, 60, 1, rng)

    speed_factor = (
        1 / opts.move_speed if opts.move_speed is not None and opts.move_speed > 0 else 1.0
    )
    if distance < 100:
        small_movement_boost = 1.5 + 1.5 * (1 - distance / 100)
        speed_factor = speed_factor / small_movement_boost

    start_time = time.time() * 1000
    timed = [
        TimedVector(
            x=max(0.0, p.x),
            y=max(0.0, p.y),
            timestamp=start_time + _js_round(timings[i] * speed_factor),
        )
        for i, p in enumerate(points)
    ]
    return _ensure_terminal_point(timed, end_point)
