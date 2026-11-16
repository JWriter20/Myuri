"""Headless Cursor integration tests.

Python can't run the JS page-functions locally, so the fake driver answers
``evaluate`` by recognizing each payload (scroll-plan / viewport / bounding-box /
wait / point-hit / scroll) and returning canned geometry for a single element.
"""
import asyncio
import time

import pytest

from myuri import Cursor, ScrollOptions, TypeOptions
from myuri.motion.scroll_model import scroll_model
from myuri.drivers.base import Driver

RECT = {"x": 100, "y": 100, "width": 200, "height": 50}


class FakeDriver(Driver):
    def __init__(self, field_text=""):
        self.calls = []
        # Text of the focused field (RECT); Backspace empties it, as it would
        # once triple-click has selected everything.
        self.field_text = field_text

    async def move(self, x, y):
        self.calls.append(("move", x, y))

    async def click(self, button="left", click_count=1):
        self.calls.append(("click", button, click_count))

    async def down(self, key):
        self.calls.append(("down", key))
        if key == "Backspace":
            self.field_text = ""

    async def up(self, key):
        self.calls.append(("up", key))

    async def wheel(self, delta_x, delta_y):
        self.calls.append(("wheel", delta_x, delta_y))

    async def press(self, key, delay=None):
        self.calls.append(("press", key))

    async def evaluate(self, js, arg=None):
        if "visualLines" in js:  # focused field (clear_existing)
            return {
                "box": dict(RECT),
                "empty": self.field_text == "",
                "selection": "all",
                "lines": 1,
                "visualLines": 1,
                "scrollTop": 0,
                "firstLine": {"x": RECT["x"] + 8, "y": RECT["y"] + 25},
            }
        if "wheelReaches" in js:  # scroll plan: element visible, nothing to scroll
            return {
                "inView": True,
                "deltaY": 0,
                "hoverX": arg["fromX"],
                "hoverY": arg["fromY"],
                "isPage": True,
                "region": dict(RECT),
            }
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
    pressed = [c[1] for c in d.calls if c[0] == "down"]
    assert "h" in pressed and "i" in pressed
    # Every key that went down came back up.
    assert sorted(c[1] for c in d.calls if c[0] == "up") == sorted(pressed)


@pytest.mark.asyncio
async def test_clear_existing_triple_clicks_without_modifier_keys():
    d = FakeDriver(field_text="Glassdoor")
    cursor = Cursor(d, seed=5, settings={"typing": {"mistake_multiplier": 0}})
    await cursor.type("hi", "#target", TypeOptions(clear_existing=True))
    # The focusing click is click 1; clicks 2 and 3 complete the triple-click.
    assert [c[2] for c in d.calls if c[0] == "click"] == [1, 2, 3]
    assert not [c for c in d.calls if c[0] == "down" and c[1] in ("Control", "Meta")]
    assert ("down", "Backspace") in d.calls


@pytest.mark.asyncio
async def test_clear_existing_skips_an_empty_field():
    d = FakeDriver(field_text="")
    cursor = Cursor(d, seed=5, settings={"typing": {"mistake_multiplier": 0}})
    await cursor.type("hi", "#target", TypeOptions(clear_existing=True))
    assert [c[2] for c in d.calls if c[0] == "click"] == [1]


@pytest.mark.asyncio
async def test_clear_existing_uses_select_all_modifier_only_when_set():
    d = FakeDriver(field_text="Glassdoor")
    cursor = Cursor(
        d, seed=5, settings={"typing": {"mistake_multiplier": 0}}, select_all_modifier="Meta"
    )
    await cursor.type("hi", "#target", TypeOptions(clear_existing=True))
    assert ("down", "Meta") in d.calls
    assert [c[2] for c in d.calls if c[0] == "click"] == [1]


class SlowWheelDriver(FakeDriver):
    """A page 1500px above the target, whose wheel acks arrive a frame later."""

    def __init__(self):
        super().__init__()
        self.sent = []
        self.in_flight = 0
        self.max_in_flight = 0

    async def evaluate(self, js, arg=None):
        if "wheelReaches" in js:  # scroll plan: page must scroll down 1500px
            return {
                "inView": False,
                "deltaY": 1500,
                "hoverX": 400,
                "hoverY": 300,
                "isPage": True,
                "region": dict(RECT),
            }
        return await super().evaluate(js, arg)

    async def wheel(self, delta_x, delta_y):
        self.sent.append((time.monotonic() * 1000, delta_y))
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        await asyncio.sleep(0.017)
        self.in_flight -= 1


@pytest.mark.asyncio
async def test_scroll_keeps_model_timing_when_wheel_acks_take_a_frame(monkeypatch):
    # A real browser acknowledges a wheel event only on its next frame. Awaiting
    # each one used to stretch gestures planned at ~8 ms cadence to 1.5-2x.
    gestures = []
    generate = scroll_model.generate_scroll_path

    def record(*args, **kwargs):
        events = generate(*args, **kwargs)
        gestures.append(events)
        return events

    monkeypatch.setattr(scroll_model, "generate_scroll_path", record)
    d = SlowWheelDriver()
    cursor = Cursor(d, seed=8, settings={"scroll": {"speed_factor": 1}})
    await cursor.scroll("#target", ScrollOptions(max_tries=1))

    planned = gestures[0]
    intended = sum(e.delta_time for e in planned)
    span = d.sent[-1][0] - d.sent[0][0]
    assert intended * 0.7 < span < intended * 1.3
    # Sends overlap rather than waiting on each ack, and lose no distance.
    assert d.max_in_flight > 1
    assert abs(sum(dy for _, dy in d.sent) - sum(e.delta_y for e in planned)) <= 1


@pytest.mark.asyncio
async def test_scroll_uses_the_profile_speed_factor(monkeypatch):
    # scroll() without options must pace by the seed's profile, like JS does
    # (it used to fall back to 1, ignoring the profile).
    gestures = []
    generate = scroll_model.generate_scroll_path

    def record(*args, **kwargs):
        events = generate(*args, **kwargs)
        gestures.append(events)
        return events

    monkeypatch.setattr(scroll_model, "generate_scroll_path", record)
    d = SlowWheelDriver()
    cursor = Cursor(d, seed=3)  # profile speed_factor ~0.81
    speed_factor = cursor.get_settings().scroll.speed_factor
    assert abs(speed_factor - 1) > 0.1
    await cursor.scroll("#target", ScrollOptions(max_tries=1))

    intended = sum(e.delta_time for e in gestures[0]) / speed_factor
    span = d.sent[-1][0] - d.sent[0][0]
    # Tight enough to tell the profile's pace (~1.24x the raw model) from 1x.
    assert intended * 0.9 < span < intended * 1.3


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
