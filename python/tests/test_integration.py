"""Headless Cursor integration tests.

Python can't run the JS page-functions locally, so the fake driver answers
``evaluate`` by recognizing each payload (viewport / bounding-box / wait /
point-hit / scroll) and returning canned geometry for a single element.
"""
import pytest

from myuri import Cursor
from myuri.drivers.base import Driver

RECT = {"x": 100, "y": 100, "width": 200, "height": 50}


class FakeDriver(Driver):
    def __init__(self):
        self.calls = []

    async def move(self, x, y):
        self.calls.append(("move", x, y))

    async def click(self, button="left"):
        self.calls.append(("click", button))

    async def down(self, key):
        self.calls.append(("down", key))

    async def up(self, key):
        self.calls.append(("up", key))

    async def wheel(self, delta_x, delta_y):
        self.calls.append(("wheel", delta_x, delta_y))

    async def press(self, key, delay=None):
        self.calls.append(("press", key))

    async def evaluate(self, js, arg=None):
        if "innerWidth" in js:
            return {"width": 1280, "height": 720}
        if "requireVisible" in js:
            return True
        if "elementFromPoint" in js:  # point-hit test
            x, y = arg["x"], arg["y"]
            inside = RECT["x"] <= x <= RECT["x"] + RECT["width"] and RECT["y"] <= y <= RECT["y"] + RECT["height"]
            return inside
        if "scrollY" in js:
            return {"offset": 0, "maxOffset": 2000}
        if "getBoundingClientRect" in js:
            return dict(RECT)
        if "navigator.platform" in js:
            return False
        return None

    def is_closed(self):
        return False


@pytest.mark.asyncio
async def test_move_lands_inside_element():
    d = FakeDriver()
    cursor = Cursor(d, seed=1)
    await cursor.move("#target")
    loc = cursor.get_location()
    assert RECT["x"] <= loc.x <= RECT["x"] + RECT["width"]
    assert RECT["y"] <= loc.y <= RECT["y"] + RECT["height"]
    assert any(c[0] == "move" for c in d.calls)


@pytest.mark.asyncio
async def test_click_moves_then_clicks():
    d = FakeDriver()
    cursor = Cursor(d, seed=2)
    await cursor.click("#target")
    ops = [c[0] for c in d.calls]
    assert "click" in ops
    assert ops.index("move") < ops.index("click")


@pytest.mark.asyncio
async def test_type_clicks_then_presses():
    d = FakeDriver()
    cursor = Cursor(d, seed=3, settings={"typing": {"mistake_multiplier": 0}})
    await cursor.type("hi", "#target")
    pressed = [c[1] for c in d.calls if c[0] == "press"]
    assert "h" in pressed and "i" in pressed


@pytest.mark.asyncio
async def test_deterministic_same_seed_same_landing():
    a, b = FakeDriver(), FakeDriver()
    ca, cb = Cursor(a, seed=777), Cursor(b, seed=777)
    await ca.move("#target")
    await cb.move("#target")
    assert ca.get_location() == cb.get_location()


@pytest.mark.asyncio
async def test_dispose_idempotent():
    cursor = Cursor(FakeDriver(), seed=4)
    await cursor.dispose()
    await cursor.dispose()
