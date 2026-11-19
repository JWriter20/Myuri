"""Planner goldens, shared with js/test/plan.spec.ts: the same seed must plan
the same in both languages. Times are rounded to 1 us."""
import asyncio
import time

import pytest

from myuri import (
    Cursor,
    make_rng,
    plan_click,
    plan_move,
    plan_point,
    plan_press,
    plan_select_all,
    plan_type,
    plan_wheel,
    primary_modifier,
)
from myuri.options import MoveToOptions
from myuri.types import BoundingBox, Vector
from myuri.drivers.base import define_driver


def r3(x):
    return round(x * 1000) / 1000


def digest(pts):
    return [len(pts), r3(sum(p.x for p in pts)), r3(sum(p.y for p in pts)), r3(sum(p.t for p in pts))]


def keys(steps):
    return [[r3(t), kind, key] for t, kind, key in steps]


def wheel_digest(planned):
    steps = [[r3(v) if isinstance(v, (int, float)) else v for v in s] for s in planned]
    return [
        len(steps),
        [[s[2], s[3]] for s in steps if s[0] == "key"],
        r3(sum(s[1] for s in steps if s[0] == "wheel")),
        r3(sum(s[2] for s in steps if s[0] == "wheel")),
        r3(sum(s[3] for s in steps)),
    ]


OSES = [None, "macos", "windows", "linux"]

GOLDEN = {
    "move": [106, 68640.738, 36725.706, 58499.625],
    "move_short": [11, 501.518, 372.564, 669.904],
    "click": {"dwell_ms": 600, "presses": [(0, 92), (162, 246), (323, 425)]},
    # plan_type('Hi, Bob!'): the release time of each key.
    "type_ups": [92.695, 159.955, 162.228, 447.436, 525.877, 1008.267, 1024.293, 1129.194, 1214.201, 2169.225, 2195.42],
    "press": [[0, "down", "Control"], [74.196, "down", "Shift"], [242.174, "down", "z"], [266.711, "up", "Control"], [310.145, "up", "z"], [349.908, "up", "Shift"]],
    # Per OS in OSES order: the wheel is what the OS changes.
    "wheel_mouse": [
        [10, [["down", 360], ["up", 8348.707]], 0, 800, 14278.601],
        [11, [["down", 191], ["up", 1895.11]], 304, 496, 5965.91],
        [10, [["down", 360], ["up", 8348.707]], 0, 800, 14278.601],
        [10, [["down", 360], ["up", 8348.707]], 0, 800, 14278.601],
    ],
    "wheel_pad": [
        [15, [["down", 0], ["up", 2427.008]], 0, -200, 14223.494],
        [15, [["down", 0], ["up", 2427.008]], -200, 0, 14223.494],
        [15, [["down", 0], ["up", 2427.008]], 0, -200, 14223.494],
        [15, [["down", 0], ["up", 2427.008]], 0, -200, 14223.494],
    ],
}


@pytest.mark.parametrize("i,os", list(enumerate(OSES)))
def test_planners(i, os):
    move = plan_move(Vector(10, 20), Vector(800, 450), make_rng(5), os=os)
    assert digest(move) == GOLDEN["move"]
    assert (move[-1].x, move[-1].y) == (800, 450)
    assert all(b.t > a.t for a, b in zip(move, move[1:]))
    assert digest(plan_move(Vector(10, 20), Vector(60, 40), make_rng(5), os=os, move_speed=2)) == GOLDEN["move_short"]

    assert plan_click(make_rng(7), os=os, click_count=3) == GOLDEN["click"]

    steps = keys(plan_type("Hi, Bob!", make_rng(9), os=os))
    assert [k for _, kind, k in steps if kind == "down"] == ["Shift", "H", "i", ",", " ", "Shift", "B", "o", "b", "Shift", "!"]
    assert [t for t, kind, _ in steps if kind == "up"] == GOLDEN["type_ups"]

    assert keys(plan_press("Control+Shift+z", make_rng(3), os=os)) == GOLDEN["press"]

    assert wheel_digest(plan_wheel(300, 500, make_rng(13), os=os, device="mouse")) == GOLDEN["wheel_mouse"][i]
    assert wheel_digest(plan_wheel(-200, 0, make_rng(13), os=os, device="trackpad")) == GOLDEN["wheel_pad"][i]


def test_presses_what_a_key_needs():
    assert keys(plan_press("A", make_rng(3))) == [[0, "down", "Shift"], [74.196, "down", "A"], [130.144, "up", "Shift"], [199.231, "up", "A"]]
    assert [s[2] for s in plan_press("Control++", make_rng(3))] == ["Control", "Shift", "+", "Control", "+", "Shift"]
    assert keys(plan_select_all(make_rng(3), os="macos")) == [[0, "down", "Meta"], [74.196, "down", "a"], [130.144, "up", "Meta"], [199.231, "up", "a"]]
    assert plan_select_all(make_rng(3), os="linux")[0] == (0, "down", "Control")


def test_picks_a_point_in_a_box():
    box = BoundingBox(100, 200, 120, 40)
    assert plan_point(box, make_rng(4)) == Vector(156, 224)
    assert plan_point(box, make_rng(4), start=Vector(0, 0)) == Vector(128, 215)


def test_presses_where_the_pointer_is_when_it_is_already_on_the_box():
    assert plan_point(BoundingBox(100, 200, 120, 40), make_rng(4), start=Vector(101.5, 238)) == Vector(101.5, 238)


def _median(xs):
    return sorted(xs)[len(xs) // 2]


def _plans(**kw):
    rng = make_rng(1)
    return [plan_click(rng, **kw) for _ in range(2000)]


def test_holds_a_later_press_of_a_run_as_people_do():
    holds = [[up - down for down, up in p["presses"]] for p in _plans(click_count=3)]
    # People: a first press held 96 ms (median), a later one in a run 83.
    assert _median([h[0] for h in holds]) > 88
    assert 78 <= _median([h[1] for h in holds]) <= 88
    assert _median([h[2] for h in holds]) <= 88


def test_continues_a_run_after_a_recent_release_in_place():
    plans = _plans(since_release_ms=20)
    assert 50 <= _median([p["dwell_ms"] for p in plans]) <= 66
    assert min(p["dwell_ms"] for p in plans) >= 0
    assert _median([p["presses"][0][1] - p["presses"][0][0] for p in plans]) <= 88


def test_presses_at_once_after_a_release_past_the_double_click_time():
    plans = _plans(since_release_ms=800)
    assert all(p["dwell_ms"] == 0 for p in plans)
    assert _median([p["presses"][0][1] - p["presses"][0][0] for p in plans]) > 88


def key_driver(downs):
    """A driver that records the keys it is sent; its page claims a Windows platform."""

    async def record(key, *_):
        downs.append(key)

    async def nothing(*_):
        return False

    return define_driver(move=nothing, click=nothing, down=record, up=nothing, wheel=nothing, press=record, evaluate=nothing, set_clipboard=nothing)


def test_rejects_an_unknown_os():
    with pytest.raises(ValueError, match="unknown os 'Windows'"):
        primary_modifier("Windows")
    with pytest.raises(ValueError, match="unknown os"):
        plan_click(make_rng(1), os="win")
    with pytest.raises(ValueError, match="unknown os"):
        Cursor(key_driver([]), os="Mac")


def test_moves_at_a_mouse_report_rate_and_repeats_a_pixel_only_on_macos():
    def run(os):
        moves = []

        async def move(x, y):
            moves.append((x, y, time.monotonic() * 1000))

        async def viewport(*_):
            return {"width": 1200, "height": 800}

        async def nothing(*_):
            return None

        driver = define_driver(move=move, click=nothing, down=nothing, up=nothing, wheel=nothing, press=nothing, evaluate=viewport)
        cursor = Cursor(driver, os=os, seed=4, start=Vector(100, 100))
        asyncio.run(cursor.move_to(Vector(300, 160), MoveToOptions(move_speed=0.5)))
        gaps = sorted(b[2] - a[2] for a, b in zip(moves, moves[1:]))
        repeats = sum(a[:2] == b[:2] for a, b in zip(moves, moves[1:]))
        return gaps, repeats

    gaps, repeats = run("macos")
    assert repeats > 0
    assert 9 <= gaps[len(gaps) // 2] <= 12
    for os in (None, "windows", "linux"):
        assert run(os)[1] == 0


def test_refuses_a_select_all_modifier_the_os_does_not_use():
    with pytest.raises(ValueError, match="not select-all on windows"):
        Cursor(key_driver([]), os="windows", select_all_modifier="Meta")
    Cursor(key_driver([]), os="macos", select_all_modifier="Meta")


def test_pastes_with_the_modifier_of_os_not_the_page_one():
    # Issue #10.
    downs = []
    driver = key_driver(downs)
    driver.os = "macos"
    asyncio.run(driver.insert_text("é"))
    assert downs == ["Meta", "v"]
