"""Motion generation: fitted trackpad and mouse-wheel scroll dynamics.

Python mirror of ``js/src/motion/`` in the TypeScript package. Mouse trajectories
come from `cursory <https://github.com/Vinyzu/cursory>`_ (see ``myuri.geometry.path``).
"""

from .scroll_model import ScrollEvent, ScrollModel, scroll_model
from .wheel_model import generate_wheel_path

__all__ = [
    "ScrollEvent",
    "ScrollModel",
    "scroll_model",
    "generate_wheel_path",
]
