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
    """Retries if the cursor misses the element. Default 3."""
    overshoot_threshold: Optional[float] = None
    """Straight-line distance beyond which the move overshoots then corrects."""
    wait_for_selector: Optional[float] = None
    """ms to wait for the selector before failing. Default 10000."""
    move_delay: Optional[float] = None
    """Delay after the move completes (ms)."""
    randomize_move_delay: Optional[bool] = None
    timeout: Optional[float] = None
    """Overall move timeout (ms); aborts the whole attempt."""
    exclude_selectors: Optional[Union[str, Sequence[str]]] = None
    """Selectors whose boxes the destination point must avoid."""


@dataclass
class ClickOptions(MoveOptions):
    """Options for clicking an element (extends :class:`MoveOptions`)."""

    button: Optional[MouseButton] = None
    wait_for_click: Optional[float] = None
    """ms to hold the button."""
    micro_jitter: Optional[bool] = None
    """Nudge 1px right before clicking."""
    dynamic_adjustment: Optional[bool] = None
    """Re-check the target box just before clicking and correct if it moved."""


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

    delay: Optional[float] = None
    speed_factor: Optional[float] = None
    overshoot: Optional[float] = None
    finish_position: Optional[float] = None
    """Where the element lands in the viewport: 0=top, 0.5=center, 1=bottom."""
    realism: Optional[ScrollRealismOptions] = None
    wait_for_selector: Optional[float] = None
    max_tries: Optional[int] = None


@dataclass
class TypeOptions:
    """Options for typing into an element."""

    delay: Optional[float] = None
    """Per-key delay hint (ms); the Markov model is the primary timing source."""
    wait_for_selector: Optional[float] = None
    max_tries: Optional[int] = None
    clear_existing: Optional[bool] = None
    """Select-all + delete existing content before typing."""
