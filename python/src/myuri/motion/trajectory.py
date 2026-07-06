"""Recorded human mouse-trajectory dataset: loading, lookup, and distortion helpers.

Python mirror of ``js/src/motion/trajectory.ts`` (the source of truth).

The dataset ships as gzipped JSON. The default loader probes both the
installed-package location (``myuri/assets/trajectories.json.gz`` inside the
wheel) and the dev/source layout (``<repo-root>/assets/trajectories.json.gz``).
Runtimes without filesystem access can inject data via
:func:`set_trajectory_data` / :func:`ensure_trajectories_loaded`.
"""

from __future__ import annotations

import gzip
import importlib.resources
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Tuple, Union

from ..rng import Rng, default_rng, gaussian
from ..types import Vector

#: One entry of the dataset as stored on disk (parsed JSON object with keys
#: ``dx``, ``dy``, ``length``, ``points`` ([[x, y], ...]) and ``timing``).
RawTrajectory = Dict[str, Any]

#: Accepted forms for injected trajectory data (see set_trajectory_data):
#: the parsed list, a JSON string, or gzipped bytes.
TrajectoryData = Union[List[RawTrajectory], str, bytes, bytearray, memoryview]

__all__ = [
    "Trajectory",
    "ClosestTrajectory",
    "set_trajectory_data",
    "ensure_trajectories_loaded",
    "find_nearest_trajectory",
    "find_closest_trajectory",
    "morph_trajectory",
    "jitter_trajectory",
    "generate_middle_biased_point",
    "knot_trajectory",
    "find_trajectory",
]


@dataclass
class Trajectory:
    """A recorded trajectory with points expanded into :class:`Vector` objects."""

    dx: Union[float, List[float]]
    dy: Union[float, List[float]]
    length: float
    points: List[Vector]
    timing: List[float]


class ClosestTrajectory(NamedTuple):
    """Result of :func:`find_closest_trajectory`."""

    trajectory: Trajectory
    dx_tar: float
    dy_tar: float
    len_tar: float


@dataclass
class _Dataset:
    trajectories: List[Trajectory]
    # Straight-line-normalized signed endpoint direction of each trajectory,
    # precomputed once at load time so per-query lookups never re-map the
    # whole dataset.
    dir_x: List[float]
    dir_y: List[float]
    # Recorded arc lengths (used for length similarity scoring).
    lengths: List[float]


_dataset: Optional[_Dataset] = None


def _signed_endpoint_delta(raw: RawTrajectory, points: List[Vector]) -> Tuple[float, float]:
    """Signed endpoint delta of a recorded trajectory. Derived from the recorded
    points themselves whenever possible, which preserves the sign of the
    displacement (a hypot collapse of tuple fields would make leftward and
    rightward moves indistinguishable).
    """
    if len(points) >= 2:
        first = points[0]
        last = points[-1]
        return (last.x - first.x, last.y - first.y)
    # Fallback for degenerate entries: tuples hold [start, end] coordinates,
    # so the signed delta is end - start. Never collapse with hypot.
    raw_dx = raw["dx"]
    raw_dy = raw["dy"]
    dx = raw_dx[1] - raw_dx[0] if isinstance(raw_dx, (list, tuple)) else raw_dx
    dy = raw_dy[1] - raw_dy[0] if isinstance(raw_dy, (list, tuple)) else raw_dy
    return (float(dx), float(dy))


def _build_dataset(raw_trajectories: List[RawTrajectory]) -> _Dataset:
    trajectories = [
        Trajectory(
            dx=raw["dx"],
            dy=raw["dy"],
            length=raw["length"],
            points=[Vector(x, y) for x, y in raw["points"]],
            timing=list(raw["timing"]),
        )
        for raw in raw_trajectories
    ]

    dir_x: List[float] = [0.0] * len(trajectories)
    dir_y: List[float] = [0.0] * len(trajectories)
    lengths: List[float] = [0.0] * len(trajectories)

    for i, traj in enumerate(trajectories):
        delta_x, delta_y = _signed_endpoint_delta(raw_trajectories[i], traj.points)
        # Normalize by the straight-line endpoint distance (NOT the arc
        # length) so the dot product against a unit target vector is a true
        # cosine similarity even for curved paths.
        span = math.hypot(delta_x, delta_y)
        dir_x[i] = delta_x / span if span != 0 else 0.0
        dir_y[i] = delta_y / span if span != 0 else 0.0
        lengths[i] = traj.length

    return _Dataset(trajectories=trajectories, dir_x=dir_x, dir_y=dir_y, lengths=lengths)


def _load_default_asset() -> List[RawTrajectory]:
    """Read the gzipped dataset shipped with the package.

    Probes both the installed-package layout (``myuri/assets/trajectories.json.gz``
    inside the wheel, via ``importlib.resources``) and the dev/source layout
    (``<repo-root>/assets/trajectories.json.gz``), using whichever exists. This is
    the only place that touches the filesystem; other runtimes should inject data
    via set_trajectory_data / ensure_trajectories_loaded(data).
    """
    last_err: Optional[BaseException] = None

    # Installed/published layout: <site-packages>/myuri/assets/trajectories.json.gz
    try:
        resource = importlib.resources.files("myuri") / "assets" / "trajectories.json.gz"
        if resource.is_file():
            return json.loads(gzip.decompress(resource.read_bytes()).decode("utf-8"))
    except Exception as err:  # noqa: BLE001 - fall through to the dev layout
        last_err = err

    # Dev/source layout: python/src/myuri/motion/trajectory.py -> <repo-root>/assets/...
    try:
        dev_path = Path(__file__).resolve().parents[4] / "assets" / "trajectories.json.gz"
        if dev_path.is_file():
            return json.loads(gzip.decompress(dev_path.read_bytes()).decode("utf-8"))
    except Exception as err:  # noqa: BLE001
        last_err = err

    if last_err is not None:
        raise last_err
    raise FileNotFoundError(
        "trajectories.json.gz not found in the installed package or the repo assets directory"
    )


def _parse_trajectory_data(data: TrajectoryData) -> List[RawTrajectory]:
    if isinstance(data, str):
        return json.loads(data)
    if isinstance(data, (bytes, bytearray, memoryview)):
        return json.loads(gzip.decompress(bytes(data)).decode("utf-8"))
    return data


def set_trajectory_data(data: TrajectoryData) -> None:
    """Supply the trajectory dataset explicitly, replacing anything already
    loaded. Accepts the parsed list, a JSON string, or gzipped bytes.
    Use this in runtimes without filesystem access.
    """
    global _dataset
    _dataset = _build_dataset(_parse_trajectory_data(data))


def ensure_trajectories_loaded(data: Optional[TrajectoryData] = None) -> None:
    """Lazily loads the trajectory dataset on first use (cached afterwards).
    If ``data`` is provided and nothing is loaded yet, it is used instead of
    reading the bundled asset from disk.
    """
    global _dataset
    if _dataset is not None:
        return
    try:
        raw = _parse_trajectory_data(data) if data is not None else _load_default_asset()
        _dataset = _build_dataset(raw)
    except Exception as error:
        raise RuntimeError(f"Failed to load trajectory data: {error}") from error


def find_nearest_trajectory(
    target_start: Vector,
    target_end: Vector,
    direction_weight: float = 0.8,
    length_weight: float = 0.2,
    top_n: int = 5,
) -> List[Trajectory]:
    """Find the top N nearest trajectories to the target start and end points
    based on direction and length similarity.
    """
    ensure_trajectories_loaded()
    assert _dataset is not None
    trajectories = _dataset.trajectories
    dir_x = _dataset.dir_x
    dir_y = _dataset.dir_y
    lengths = _dataset.lengths

    # Calculate target vector components and length
    dx_tar = target_end.x - target_start.x
    dy_tar = target_end.y - target_start.y
    len_tar = math.hypot(dx_tar, dy_tar)

    # Handle zero-length target vector case
    if len_tar == 0:
        order = sorted(range(len(lengths)), key=lambda idx: lengths[idx])
        return [trajectories[idx] for idx in order[:top_n]]

    # Normalize target vector to get direction
    norm_dx_tar = dx_tar / len_tar
    norm_dy_tar = dy_tar / len_tar

    # Cosine similarity of directions (both sides straight-line normalized):
    # 1 for same, -1 for opposite, 0 for perpendicular. Converted to a
    # distance (0 is best) and combined with the normalized length difference.
    combined_score: List[float] = []
    for i in range(len(dir_x)):
        direction_distance = 1 - (dir_x[i] * norm_dx_tar + dir_y[i] * norm_dy_tar)
        length_diff_ratio = abs(lengths[i] - len_tar) / max(len_tar, 1)
        combined_score.append(direction_weight * direction_distance + length_weight * length_diff_ratio)

    # Get indices of trajectories with the lowest combined scores (best matches)
    order = sorted(range(len(combined_score)), key=lambda idx: combined_score[idx])
    return [trajectories[idx] for idx in order[:top_n]]


def find_closest_trajectory(
    target_start: Vector,
    target_end: Vector,
    num_nearest_to_sample: int = 5,
    random_sample_iterations: int = 20,
    length_preference_power: float = 2,
    rng: Optional[Rng] = None,
) -> ClosestTrajectory:
    """Find the closest trajectory to the target start and end points, with a
    preference for shorter trajectories. Randomly selects from top candidates,
    heavily biased towards shorter trajectories through weighted random sampling.
    """
    if rng is None:
        rng = default_rng  # unseeded fallback; mirrors defaultRng in rng.ts
    ensure_trajectories_loaded()
    dx_tar = target_end.x - target_start.x
    dy_tar = target_end.y - target_start.y
    len_tar = math.hypot(dx_tar, dy_tar)

    # Initial selection of top trajectories
    top_trajectories = find_nearest_trajectory(target_start, target_end, 0.8, 0.2, num_nearest_to_sample)

    # Iteratively refine top trajectories by perturbing target end and re-querying
    for _ in range(random_sample_iterations):
        perturbed_target_end = Vector(
            target_end.x + (rng() * 2 - 1) * len_tar * 0.1,
            target_end.y + (rng() * 2 - 1) * len_tar * 0.1,
        )
        top_trajectories = top_trajectories + find_nearest_trajectory(
            target_start, perturbed_target_end, 0.8, 0.2, num_nearest_to_sample
        )

    # Calculate weights based on inverse length, powered to strongly prefer
    # shorter trajectories
    epsilon = 1e-10
    inverse_lengths = [
        1.0 / ((traj.length + epsilon) ** length_preference_power) for traj in top_trajectories
    ]
    sum_weights = sum(inverse_lengths)
    weights = [w / sum_weights for w in inverse_lengths]

    # Randomly select a trajectory index based on the calculated weights.
    # If float rounding lets the loop finish without a hit, the correct
    # fallback is the LAST index (cumulative weight ~1), not the first.
    rand = rng()
    cumulative_weight = 0.0
    selected_index = len(weights) - 1
    for i, w in enumerate(weights):
        cumulative_weight += w
        if rand <= cumulative_weight:
            selected_index = i
            break

    return ClosestTrajectory(
        trajectory=top_trajectories[selected_index],
        dx_tar=dx_tar,
        dy_tar=dy_tar,
        len_tar=len_tar,
    )


def morph_trajectory(
    points: List[Vector],
    target_start: Vector,
    target_end: Vector,
    dx_tar: float,
    dy_tar: float,
    len_tar: float,
) -> List[Vector]:
    """Morph a given trajectory to match the target start and end points by
    scaling, rotating, and translating. Purely deterministic (no rng).
    """
    if len(points) == 0:
        return []

    start = points[0]
    end = points[-1]

    # Calculate original trajectory's displacement and length
    dx_orig = end.x - start.x
    dy_orig = end.y - start.y
    len_orig = math.hypot(dx_orig, dy_orig)

    # Calculate scaling factor based on target and original lengths
    scale_factor = len_tar / len_orig if len_orig != 0 else 1.0

    # Calculate rotation angle needed to align original trajectory direction
    # with target direction
    angle_orig = math.atan2(dy_orig, dx_orig)
    angle_tar = math.atan2(dy_tar, dx_tar)
    rotation_angle = angle_tar - angle_orig

    # Create rotation matrix
    cos_a = math.cos(rotation_angle)
    sin_a = math.sin(rotation_angle)

    # Apply transformation: Scale, Rotate, Translate
    morphed_points: List[Vector] = []
    for point in points:
        # Translate to origin
        x = point.x - start.x
        y = point.y - start.y

        # Scale
        x *= scale_factor
        y *= scale_factor

        # Rotate
        rotated_x = x * cos_a - y * sin_a
        rotated_y = x * sin_a + y * cos_a

        # Translate to target start
        morphed_points.append(Vector(rotated_x + target_start.x, rotated_y + target_start.y))

    # Ensure exact start and end point matching
    morphed_points[0] = Vector(target_start.x, target_start.y)
    morphed_points[-1] = Vector(target_end.x, target_end.y)

    return morphed_points


def jitter_trajectory(
    points: List[Vector],
    trajectory_length: float,
    scale: float = 0.01,
    rng: Optional[Rng] = None,
) -> List[Vector]:
    """Applies a smooth jitter to the trajectory points, scaling jitter based on
    distance and trajectory length.
    """
    if rng is None:
        rng = default_rng  # unseeded fallback; mirrors defaultRng in rng.ts
    if len(points) == 0:
        return []

    # Scale jitter based on trajectory length
    length_scale = min(1.0, trajectory_length / 400)

    # Calculate distances between consecutive points
    distances: List[float] = [0.0]
    for i in range(1, len(points)):
        dx = points[i].x - points[i - 1].x
        dy = points[i].y - points[i - 1].y
        distances.append(math.sqrt(dx * dx + dy * dy))

    # Calculate average distances for adaptive jitter scale
    distances_prev = [0.0] + distances[1:]
    distances_next = distances[1:] + [0.0]
    avg_distances = [(prev + distances_next[i]) / 2 for i, prev in enumerate(distances_prev)]

    max_avg_distance = max(max(avg_distances, default=0.0), 1)
    adaptive_scales = [scale * (avg / max_avg_distance) * length_scale for avg in avg_distances]

    # Generate jitter values and apply to points
    jittered: List[Vector] = []
    for i, point in enumerate(points):
        if i == 0:
            jittered.append(Vector(point.x, point.y))  # Keep first point unchanged
            continue

        # Zero-mean symmetric jitter, independent per axis: (rng()-0.5)*2 maps
        # to [-1, 1] so displacement is centered on the original point with no
        # directional bias.
        jitter_x = (rng() - 0.5) * 2 * adaptive_scales[i]
        jitter_y = (rng() - 0.5) * 2 * adaptive_scales[i]

        jittered.append(Vector(point.x + jitter_x, point.y + jitter_y))
    return jittered


def generate_middle_biased_point(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    bias_factor: float = 2.0,
    rng: Optional[Rng] = None,
) -> Vector:
    """Generates a random point within a rectangle defined by two corner points,
    with a Gaussian bias towards the center of the rectangle.
    """
    if rng is None:
        rng = default_rng  # unseeded fallback; mirrors defaultRng in rng.ts
    # Determine rectangle bounds
    min_x = min(x1, x2)
    max_x = max(x1, x2)
    min_y = min(y1, y2)
    max_y = max(y1, y2)

    # Calculate center and dimensions of the rectangle
    center_x = (min_x + max_x) / 2
    center_y = (min_y + max_y) / 2
    width = max_x - min_x
    height = max_y - min_y

    # Gaussian offsets biased towards the rectangle center
    offset_x = gaussian(rng, 0, width / (2 * bias_factor))
    offset_y = gaussian(rng, 0, height / (2 * bias_factor))

    # Calculate final point coordinates, clamped to stay within the rectangle bounds
    x = max(min_x, min(max_x, center_x + offset_x))
    y = max(min_y, min(max_y, center_y + offset_y))

    return Vector(x, y)


def knot_trajectory(
    traj_points: List[Vector],
    target_start: Vector,
    target_end: Vector,
    num_knots: int = 5,
    knot_strength: float = 0.15,
    rng: Optional[Rng] = None,
) -> List[Vector]:
    """Introduces "knots" into a trajectory by displacing points towards randomly
    generated biased points.
    """
    if rng is None:
        rng = default_rng  # unseeded fallback; mirrors defaultRng in rng.ts
    if len(traj_points) == 0:
        return []

    # Initialize knot offsets
    offsets_x = [0.0] * len(traj_points)
    offsets_y = [0.0] * len(traj_points)

    for _ in range(num_knots):
        # Generate a biased point within the bounding box of target start and end
        knot = generate_middle_biased_point(
            target_start.x,
            target_start.y,
            target_end.x,
            target_end.y,
            2.0,
            rng,
        )

        # Calculate distances from each trajectory point to the knot point
        distances: List[float] = []
        for point in traj_points:
            dx = knot.x - point.x
            dy = knot.y - point.y
            distances.append(math.sqrt(dx * dx + dy * dy))

        max_distance = max(distances)

        # Skip adjustment if max distance is too small
        if max_distance < 1e-6:
            continue

        # Calculate proximity-based scaling and apply knot offsets
        for i, point in enumerate(traj_points):
            dx = knot.x - point.x
            dy = knot.y - point.y
            proximity = 1.0 - distances[i] / max_distance
            scaling_factor = proximity * knot_strength

            offsets_x[i] += dx * scaling_factor
            offsets_y[i] += dy * scaling_factor

    # Apply square-root scaling to knot displacements for smoother effect
    def signed_sqrt(x: float) -> float:
        return math.copysign(math.sqrt(abs(x)), x) if x != 0 else 0.0

    # Apply displacements to trajectory points
    return [
        Vector(point.x + signed_sqrt(offsets_x[i]), point.y + signed_sqrt(offsets_y[i]))
        for i, point in enumerate(traj_points)
    ]


def find_trajectory(
    target_start: Vector,
    target_end: Vector,
    rng: Optional[Rng] = None,
) -> Tuple[List[Vector], List[float]]:
    """Raw nearest-trajectory lookup: selects the closest recorded trajectory and
    deterministically morphs (scale/rotate/translate) its recorded points to
    fit exactly between the target start and end.

    NO random distortion (knot/jitter) is applied here -- the caller (see
    cursory.generate_trajectory) runs the single knot -> jitter -> morph pass on
    the resampled points, so the distortion pipeline executes exactly once.

    Returns ``(points, timing)``.
    """
    trajectory, dx_tar, dy_tar, len_tar = find_closest_trajectory(
        target_start,
        target_end,
        5,
        20,
        2,
        rng,
    )

    points = morph_trajectory(trajectory.points, target_start, target_end, dx_tar, dy_tar, len_tar)

    return points, list(trajectory.timing)
