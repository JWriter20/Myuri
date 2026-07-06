"""Motion generation: human-like cursor trajectories and scroll paths.

Python mirror of ``js/src/motion/`` in the TypeScript package.
"""

from .cursory import generate_trajectory
from .scroll_model import ScrollEvent, ScrollModel, scroll_model
from .trajectory import (
    ClosestTrajectory,
    Trajectory,
    ensure_trajectories_loaded,
    find_closest_trajectory,
    find_nearest_trajectory,
    find_trajectory,
    generate_middle_biased_point,
    jitter_trajectory,
    knot_trajectory,
    morph_trajectory,
    set_trajectory_data,
)

__all__ = [
    "ScrollEvent",
    "ScrollModel",
    "scroll_model",
    "generate_trajectory",
    "Trajectory",
    "ClosestTrajectory",
    "set_trajectory_data",
    "ensure_trajectories_loaded",
    "find_trajectory",
    "find_nearest_trajectory",
    "find_closest_trajectory",
    "morph_trajectory",
    "jitter_trajectory",
    "knot_trajectory",
    "generate_middle_biased_point",
]
