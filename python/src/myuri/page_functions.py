"""The functions the smart actions run in the page (``actions.py``).

The JS package is their source (``js/src/page-functions.ts`` and
``js/src/scroll-plan.ts``): ``js/scripts/page-functions.mjs`` writes
``page_functions.json`` from its build, and a JS test fails when the file is
out of date. Coordinates are in the viewport of the window that runs them.

- ``SCROLL_PLAN_JS``: ``(el, {finishPosition, pad, edge, fromX, fromY})`` -> the
  scroll plan, or None when the element is not visible.
- ``HIT_TEST_JS``: ``(el, {x, y, pressing} | None)`` -> why a press at the point
  (the element's middle for None) would miss the element, or None.
- ``RESOLVE_SELECTOR_JS``: ``(selector) -> element | None``.
- ``BOX_JS``: ``(el) ->`` its border box in the top page's viewport, or None
  when it has no size.
- ``FOCUSED_FIELD_JS``: ``() ->`` the focused text field's state, or None.
"""
from __future__ import annotations

import json
from importlib.resources import files

from .geometry import VIEWPORT_PADDING

_SOURCE = json.loads(files(__package__).joinpath("page_functions.json").read_text(encoding="utf-8"))

RESOLVE_SELECTOR_JS: str = _SOURCE["RESOLVE_SELECTOR_JS"]
HIT_TEST_JS: str = _SOURCE["HIT_TEST_JS"]
SCROLL_PLAN_JS: str = _SOURCE["SCROLL_PLAN_JS"]
BOX_JS: str = _SOURCE["BOX_JS"]
FOCUSED_FIELD_JS: str = _SOURCE["FOCUSED_FIELD_JS"]

SCROLL_PAD = max(20, VIEWPORT_PADDING + 5)
"""Top and bottom margin (px) of the band the target is scrolled into."""
SCROLL_EDGE = VIEWPORT_PADDING
"""Left and right margin (px) of the region the cursor may land in."""


def on_selector(fn: str) -> str:
    """A page function ``(el, arg) => ...`` run on the element a selector names,
    taking ``{"selector": ..., "arg": ...}``; None when nothing matches."""
    return (
        "(a) => { const el = (" + RESOLVE_SELECTOR_JS + ")(a.selector); "
        "return el ? (" + fn + ")(el, a.arg) : null }"
    )
