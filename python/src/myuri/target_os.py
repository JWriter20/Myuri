"""What the operating system a browser claims changes about its input.

Python mirror of ``js/src/target-os.ts``. A person's timing does not depend on
the OS (recordings on a Mac mouse, a MacBook trackpad and a Windows touchpad
differ by device, not by OS), so the timing models are shared, and so is the
mouse's report rate. ``os`` changes only what the OS itself does: the modifier
of shortcuts, whether a move may repeat the position the pointer already had
(only macOS), how a notched mouse wheel reaches the page, and how Shift turns
the wheel sideways (see ``plan_wheel``).
"""
from __future__ import annotations

from typing import Optional

OS_NAMES = ("macos", "windows", "linux")


def check_os(os: Optional[str]) -> None:
    """Raise unless ``os`` is ``None`` or one of :data:`OS_NAMES`."""
    if os is not None and os not in OS_NAMES:
        raise ValueError(f"myuri: unknown os {os!r}; use 'macos', 'windows' or 'linux'")


def primary_modifier(os: str) -> str:
    """The modifier of select-all, copy and paste on ``os``: Meta on macOS, Control elsewhere."""
    check_os(os)
    return "Meta" if os == "macos" else "Control"
