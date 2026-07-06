"""myuri — API-agnostic human-like browser cursor, keyboard, and scroll.

Bring your own driver (Playwright by default, or any backend that can dispatch
input and run JS in the page). The simulation core (trajectories, scroll model,
Markov typing, seeded RNG) is pure and shared with the TypeScript package.
"""
from .cursor import Cursor, create_cursor
from .drivers import Driver, PlaywrightDriver, define_driver, driver_from_page
from .geometry import get_better_starting_position, get_random_box_point, path
from .motion.trajectory import set_trajectory_data
from .options import (
    ClickOptions,
    MoveOptions,
    MoveToOptions,
    RandomMoveOptions,
    ScrollOptions,
    TypeOptions,
)
from .rng import SeededRng, gaussian, generate_random_seed, make_rng
from .settings import MyuriSettings, default_settings, resolve_settings
from .types import BoundingBox, TimedVector, Vector, ViewportSize
from .typing_engine.typer import HumanTyper, TyperInput

__version__ = "2.0.0"

__all__ = [
    "Cursor",
    "create_cursor",
    "Driver",
    "PlaywrightDriver",
    "define_driver",
    "driver_from_page",
    "HumanTyper",
    "TyperInput",
    "Vector",
    "BoundingBox",
    "TimedVector",
    "ViewportSize",
    "make_rng",
    "SeededRng",
    "gaussian",
    "generate_random_seed",
    "MyuriSettings",
    "default_settings",
    "resolve_settings",
    "set_trajectory_data",
    "path",
    "get_random_box_point",
    "get_better_starting_position",
    "MoveOptions",
    "ClickOptions",
    "MoveToOptions",
    "ScrollOptions",
    "TypeOptions",
    "RandomMoveOptions",
]
