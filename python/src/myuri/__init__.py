"""myuri — API-agnostic human-like browser cursor, keyboard, and scroll.

Bring your own driver (Playwright by default, or any backend that can dispatch
input and run JS in the page). The simulation core (trajectories, scroll model,
Markov typing, seeded RNG) is pure and shared with the TypeScript package.
"""
from .cursor import Cursor, create_cursor
from .drivers import (
    CdpDriver,
    Driver,
    PlaywrightDriver,
    define_driver,
    driver_from_page,
    from_cdp,
    from_playwright,
)
from .geometry import get_better_starting_position, get_random_box_point, path
from .options import (
    ClickOptions,
    DragOptions,
    MoveOptions,
    MoveToOptions,
    RandomMoveOptions,
    ScrollOptions,
    TypeOptions,
)
from .profile import profile_from_seed
from .rng import SeededRng, gaussian, generate_random_seed, make_rng
from .settings import MyuriSettings, default_settings, resolve_settings
from .types import BoundingBox, TimedVector, Vector, ViewportSize
from .typing_engine.typer import HumanTyper, TyperInput

__version__ = "2.1.0"

__all__ = [
    "Cursor",
    "create_cursor",
    "Driver",
    "PlaywrightDriver",
    "CdpDriver",
    "define_driver",
    "driver_from_page",
    "from_playwright",
    "from_cdp",
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
    "profile_from_seed",
    "path",
    "get_random_box_point",
    "get_better_starting_position",
    "MoveOptions",
    "ClickOptions",
    "DragOptions",
    "MoveToOptions",
    "ScrollOptions",
    "TypeOptions",
    "RandomMoveOptions",
]
