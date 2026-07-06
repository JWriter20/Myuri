"""Core geometric value types and vector helpers (mirror of ``js/src/math.ts``).

This module is dependency-free within ``myuri`` (it imports no sibling
modules), so every other module can import from it without cycles.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class Vector:
    """A 2D point/vector in CSS pixels."""

    x: float
    y: float


@dataclass(frozen=True)
class TimedVector:
    """A 2D point paired with an absolute timestamp in milliseconds."""

    x: float
    y: float
    timestamp: float


@dataclass(frozen=True)
class BoundingBox:
    """An axis-aligned rectangle: top-left corner plus size."""

    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class ViewportSize:
    """The size of the browser viewport in CSS pixels."""

    width: float
    height: float


def sub(a: Vector, b: Vector) -> Vector:
    """Component-wise ``a - b``."""
    return Vector(a.x - b.x, a.y - b.y)


def add(a: Vector, b: Vector) -> Vector:
    """Component-wise ``a + b``."""
    return Vector(a.x + b.x, a.y + b.y)


def direction(a: Vector, b: Vector) -> Vector:
    """The vector pointing from ``a`` to ``b``."""
    return sub(b, a)


def magnitude(a: Vector) -> float:
    """Euclidean length of ``a``."""
    return math.hypot(a.x, a.y)


def overshoot(coordinate: Vector, radius: float, rng: Callable[[], float]) -> Vector:
    """A point drawn uniformly from a disc of the given radius around ``coordinate``."""
    angle = rng() * 2 * math.pi
    rad = radius * math.sqrt(rng())
    return add(coordinate, Vector(rad * math.cos(angle), rad * math.sin(angle)))
