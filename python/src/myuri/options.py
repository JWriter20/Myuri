"""Public option types for Cursor actions (mirror of ``js/src/options.ts``).

All fields are optional and default to ``None``, meaning "use the resolved
settings / built-in default". Options are plain dataclasses so callers can
construct them positionally or by keyword.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence, Union

try:
    from typing import Literal
except ImportError:  # pragma: no cover - py<3.8 fallback, not expected
    Literal = None  # type: ignore[assignment]

MouseButton = Literal["left", "right", "middle"]


@dataclass
class BoxOptions:
    """Padding controls for choosing a point inside a target box."""

    width_padding_percentage: Optional[float] = None
    """Horizontal inset as a % of width (split across left/right unless overridden)."""
    height_padding_percentage: Optional[float] = None
    """Vertical inset as a % of height (split across top/bottom unless overridden)."""
    padding_left: Optional[float] = None
    padding_right: Optional[float] = None
    padding_top: Optional[float] = None
    padding_bottom: Optional[float] = None


@dataclass
class PathOptions:
    """Speed control for a generated path."""

    move_speed: Optional[float] = None
    """>1 is faster, <1 slower. Default 1."""


@dataclass
class MoveOptions(BoxOptions, PathOptions):
    """Options for moving the cursor to an element."""

    max_tries: Optional[int] = None
    """Tries before a miss is raised. Default: try again until ``timeout``."""
    overshoot_threshold: Optional[float] = None
    """Straight-line distance beyond which the move overshoots then corrects."""
    move_delay: Optional[float] = None
    """Delay after the move completes (ms)."""
    randomize_move_delay: Optional[bool] = None
    timeout: Optional[float] = None
    """ms to keep trying (waiting for the element, scrolling, retrying a miss). Default 10000."""
    exclude_selectors: Optional[Union[str, Sequence[str]]] = None
    """Selectors whose boxes the destination point must avoid."""


@dataclass
class ClickOptions(MoveOptions):
    """Options for clicking an element (extends :class:`MoveOptions`)."""

    button: Optional[MouseButton] = None
    click_count: Optional[int] = None
    """2 for a double click, 3 for a triple click. Default 1."""
    hold_ms: Optional[float] = None
    """ms to hold the button down (each click of a multi-click). Default: drawn
    per click from recorded people (median ~97 ms). Set it for a long press."""
    wait_for_click: Optional[float] = None
    """ms to wait after the click before the next action."""


@dataclass
class DragOptions(MoveOptions):
    """Options for dragging (extends :class:`MoveOptions`)."""

    button: Optional[MouseButton] = None
    wait_for_release: Optional[float] = None
    """ms to wait after releasing before the next action. Default 50."""


@dataclass
class MoveToOptions(PathOptions):
    """Options for moving to an absolute coordinate."""

    move_delay: Optional[float] = None
    randomize_move_delay: Optional[bool] = None


@dataclass
class RandomMoveOptions:
    """Options for idle/random cursor movements."""

    move_delay: Optional[float] = None
    randomize_move_delay: Optional[bool] = None
    move_speed: Optional[float] = None


@dataclass
class ScrollRealismOptions:
    """Realism overrides for scrolling."""

    speed_irregularity: Optional[float] = None


@dataclass
class ScrollOptions:
    """Options for scrolling an element into view."""

    speed_factor: Optional[float] = None
    finish_position: Optional[float] = None
    """Where the element lands in the viewport: 0=top, 0.5=center, 1=bottom."""
    realism: Optional[ScrollRealismOptions] = None
    timeout: Optional[float] = None
    """ms to wait for the element. Default 10000."""
    max_tries: Optional[int] = None
    """Scroll passes before giving up. Default 3."""


@dataclass
class TypeOptions:
    """Options for typing into an element."""

    timeout: Optional[float] = None
    """ms to keep trying to click the field. Default 10000."""
    max_tries: Optional[int] = None
    clear_existing: Optional[bool] = None
    """Select-all + delete existing content before typing."""
