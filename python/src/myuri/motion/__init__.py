"""Motion generation: fitted scroll dynamics.

Python mirror of ``js/src/motion/`` in the TypeScript package. Mouse trajectories
come from `cursory <https://github.com/Vinyzu/cursory>`_ (see ``myuri.geometry.path``).
"""

from .scroll_model import ScrollEvent, ScrollModel, scroll_model

__all__ = [
    "ScrollEvent",
    "ScrollModel",
    "scroll_model",
]
