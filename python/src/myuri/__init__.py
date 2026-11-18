"""myuri — API-agnostic human-like browser cursor, keyboard, and scroll.

Bring your own driver (Playwright by default, or any backend that can dispatch
input and run JS in the page). The simulation core (trajectories, scroll model,
Markov typing, seeded RNG) is pure and shared with the TypeScript package.
"""
import importlib.metadata as _metadata
from .actions import PARTS, RETRY_MS, SCROLL_PASSES, Actions, Host, Missed, run_async, run_sync, validate_steps
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
from .geometry import PlannedPoint, get_better_starting_position, get_random_box_point, path
from .options import (
    ClickOptions,
    DragOptions,
    MoveOptions,
    MoveToOptions,
    RandomMoveOptions,
    ScrollOptions,
    TypeOptions,
)
from .target_os import primary_modifier
from .page_functions import (
    HIT_TEST_JS,
    RESOLVE_SELECTOR_JS,
    SCROLL_EDGE,
    SCROLL_FINISH_POSITION,
    SCROLL_PAD,
    SCROLL_PLAN_JS,
    on_selector,
)
from .plan import (
    KeyStep,
    WheelStep,
    plan_click,
    plan_move,
    plan_point,
    plan_press,
    plan_select_all,
    plan_type,
    plan_wheel,
    wheel_steps,
)
from .profile import profile_from_seed
from .rng import SeededRng, gaussian, generate_random_seed, make_rng
from .settings import MyuriSettings, default_settings, resolve_settings
from .types import BoundingBox, TimedVector, Vector, ViewportSize
from .typing_engine.typer import HumanTyper, TyperInput

try:
    __version__ = _metadata.version("myuri")
except _metadata.PackageNotFoundError:  # running from a source checkout
    __version__ = "0.0.0"

__all__ = [
    "Cursor",
    "create_cursor",
    "Actions",
    "Host",
    "Missed",
    "PARTS",
    "RETRY_MS",
    "SCROLL_PASSES",
    "run_async",
    "run_sync",
    "validate_steps",
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
    "primary_modifier",
    "plan_move",
    "plan_point",
    "plan_click",
    "plan_type",
    "plan_press",
    "plan_select_all",
    "plan_wheel",
    "wheel_steps",
    "PlannedPoint",
    "KeyStep",
    "WheelStep",
    "SCROLL_PLAN_JS",
    "HIT_TEST_JS",
    "RESOLVE_SELECTOR_JS",
    "on_selector",
    "SCROLL_FINISH_POSITION",
    "SCROLL_PAD",
    "SCROLL_EDGE",
    "MoveOptions",
    "ClickOptions",
    "DragOptions",
    "MoveToOptions",
    "ScrollOptions",
    "TypeOptions",
    "RandomMoveOptions",
]
