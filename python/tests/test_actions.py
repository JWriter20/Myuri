"""The smart actions on a fake host with a virtual clock (mirror of ``js/test/actions.spec.ts``)."""
import pytest

from myuri import RETRY_MS, Actions, Missed, make_rng
from myuri.page_functions import HIT_TEST_JS, SCROLL_PLAN_JS

BOX = {"x": 100, "y": 400, "width": 120, "height": 40}
IN_VIEW = {"inView": True, "deltaY": 0, "hoverX": 0, "hoverY": 0, "isPage": True, "region": BOX, "box": BOX, "borders": [0, 0]}
BELOW = {**IN_VIEW, "inView": False, "deltaY": 900, "hoverX": 640, "hoverY": 360, "region": None}


class FakeHost:
    """Every call is recorded with the time it was made, each move takes
    ``latency`` ms, and the page answers from scripted queues (the last answer
    repeats)."""

    def __init__(self, plans=(IN_VIEW,), hits=(None,), latency=0):
        self.t = 0.0
        self.calls = []
        self.plans, self.hits, self.latency = list(plans), list(hits), latency

    @staticmethod
    def _next(queue):
        return queue.pop(0) if len(queue) > 1 else queue[0]

    def move(self, x, y):
        self.calls.append(("move", x, y, self.t))
        self.t += self.latency

    def click(self, button, click_count, hold_ms):
        self.calls.append(("click", button, click_count, self.t))
        self.t += hold_ms

    def down(self, button):
        self.calls.append(("down", button, self.t))

    def up(self, button):
        self.calls.append(("up", button, self.t))

    def wheel(self, dx, dy):
        self.calls.append(("wheel", dx, dy, self.t))

    def key_down(self, key):
        self.calls.append(("key_down", key, self.t))

    def key_up(self, key):
        self.calls.append(("key_up", key, self.t))

    def insert_text(self, text):
        self.calls.append(("insert_text", text, self.t))

    def evaluate(self, target, fn, arg):
        if fn == SCROLL_PLAN_JS:
            plan = self._next(self.plans)
            return None if plan is None else {k: dict(v) if isinstance(v, dict) else v for k, v in plan.items()}
        if fn == HIT_TEST_JS:
            return self._next(self.hits)
        raise AssertionError("unexpected page function")

    def offset(self, target):
        return None if target == "#gone" else (0, 0)

    def viewport(self):
        return (1280, 720)

    def now(self):
        return self.t

    def sleep(self, ms):
        self.t += ms

    def kinds(self):
        return [c[0] for c in self.calls]


def actions(host, seed=1, **options):
    return Actions(host, make_rng(seed), os="windows", **options)


def test_play_sends_each_step_at_its_time_and_a_late_step_delays_only_itself():
    host = FakeHost(latency=30)
    a = actions(host)
    a.run(a.play([("move", 1, 1, 0), ("move", 2, 2, 10), ("move", 3, 3, 100)]))
    assert host.calls == [("move", 1, 1, 0), ("move", 2, 2, 30), ("move", 3, 3, 100)]


def test_play_plays_nothing_when_a_step_is_bad():
    host = FakeHost()
    a = actions(host)
    with pytest.raises(ValueError, match="step 1 .*goes back in time"):
        a.run(a.play([("move", 1, 1, 5), ("move", 2, 2, 1)]))
    assert host.calls == []


def test_click_wheels_into_view_then_moves_onto_it_and_clicks_once():
    host = FakeHost(plans=[BELOW, IN_VIEW])
    a = actions(host)
    a.run(a.click("#t"))
    kinds = host.kinds()
    assert "wheel" in kinds
    assert kinds.count("click") == 1
    _, x, y, _ = [c for c in host.calls if c[0] == "move"][-1]
    assert BOX["x"] <= x <= BOX["x"] + BOX["width"]
    assert BOX["y"] <= y <= BOX["y"] + BOX["height"]


def test_click_tries_a_miss_again_after_a_wait():
    host = FakeHost(hits=["<div> intercepts pointer events", None])
    a = actions(host)
    a.run(a.click("#t"))
    assert host.kinds().count("click") == 1


def test_click_raises_the_reason_once_its_attempts_are_spent():
    host = FakeHost(hits=["<div> intercepts pointer events"])
    a = actions(host)
    with pytest.raises(Missed, match="^<div> intercepts pointer events$"):
        a.run(a.click("#t", attempts=2))
    assert "click" not in host.kinds()


def test_click_stops_trying_at_the_timeout():
    host = FakeHost(hits=["<div> intercepts pointer events"])
    a = actions(host)
    with pytest.raises(Missed):
        a.run(a.click("#t", timeout=2000))
    assert 2000 <= host.t < 2000 + max(RETRY_MS) + 1000


def test_click_does_not_count_an_element_that_is_gone_as_reached():
    a = actions(FakeHost())
    with pytest.raises(Missed, match="element is not visible"):
        a.run(a.click("#gone", attempts=1))


def test_click_is_deterministic_for_a_seed():
    first, second = FakeHost(plans=[BELOW, IN_VIEW]), FakeHost(plans=[BELOW, IN_VIEW])
    for host in (first, second):
        a = actions(host, 9)
        a.run(a.click("#t"))
    assert first.calls == second.calls


def test_a_part_replaces_myuris_and_can_call_it_through_default():
    host = FakeHost()
    seen = []

    def move(host, x, y, *, default, rng, play):
        seen.append((x, y))
        return default()

    a = actions(host, parts={"move": move})
    a.run(a.click("#t"))
    assert len(seen) == 1
    _, x, y, _ = [c for c in host.calls if c[0] == "move"][-1]
    assert (x, y) == tuple(round(v) for v in seen[0])


def test_a_scroll_part_is_the_scroll_the_click_uses():
    host = FakeHost(plans=[BELOW, IN_VIEW])
    scrolled = []

    def into_view(_host, target, *, default, rng, play):
        # This scroll part brings the element straight into view.
        scrolled.append(target)
        host.plans.pop(0)

    a = actions(host, parts={"into_view": into_view})
    a.run(a.click("#t"))
    assert scrolled == ["#t"]
    assert "wheel" not in host.kinds()


def test_point_and_reaches_decide_where_to_press_and_whether_it_lands():
    host = FakeHost(hits=["would miss"])
    a = actions(host, parts={
        "point": lambda *_, **__: (130, 410),
        "reaches": lambda *_, **__: None,
    })
    a.run(a.click("#t"))
    assert [c for c in host.calls if c[0] == "move"][-1][1:3] == (130, 410)
    assert "click" in host.kinds()


def test_names_the_parts_when_one_is_unknown():
    with pytest.raises(TypeError, match="'scroll' is not a part; the parts are move, press"):
        actions(FakeHost(), parts={"scroll": lambda *_, **__: None})
