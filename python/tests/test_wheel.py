"""Mouse-wheel model tests mirroring js/test/wheel.spec.ts."""
import json
import statistics

from myuri.motion.wheel_model import generate_wheel_path
from myuri.rng import make_rng


def test_notched_whole_notches():
    for d, n in [(1000, 10), (-340, 3), (30, 1), (-60, 1), (149, 1), (151, 2)]:
        ev = generate_wheel_path(d, make_rng(1))
        assert len(ev) == n
        assert all(e.delta_y == (100 if d > 0 else -100) for e in ev)
    assert generate_wheel_path(0.3, make_rng(1)) == []


def test_notched_strokes_and_regrips():
    in_stroke, regrips = [], []
    for seed in range(40):
        for e in generate_wheel_path(3000, make_rng(seed)):
            (regrips if e.delta_time >= 100 else in_stroke).append(e.delta_time)
    assert 20 < statistics.median(in_stroke) < 80
    assert 110 < statistics.median(regrips) < 220


def test_macos_lines_ramp_from_one():
    for seed in range(30):
        ev = generate_wheel_path(-2000, make_rng(seed), style="macos")
        assert sum(e.delta_y for e in ev) == -125 * 16
        start = True
        for e in ev:
            assert e.delta_y % 16 == 0 and abs(e.delta_y) <= 13 * 16
            if start:
                assert e.delta_y == -16
            start = e.delta_time not in (20, 40)


# Cross-language parity: printed by js generateWheelPath(1234, makeRng(42)) and
# generateWheelPath(-900, makeRng(7), { style: 'macos' }).
GOLDEN = json.loads('{"notched":[[43,100],[35,100],[44,100],[109,100],[48,100],[29,100],[34,100],[48,100],[96,100],[102,100],[48,100],[50,100]],"macos":[[88,-16],[20,-16],[20,-96],[20,-112],[20,-144],[20,-160],[20,-160],[20,-160],[423,-32]]}')


def test_matches_typescript():
    a = [[e.delta_time, e.delta_y] for e in generate_wheel_path(1234, make_rng(42))]
    b = [[e.delta_time, e.delta_y] for e in generate_wheel_path(-900, make_rng(7), style="macos")]
    assert a == GOLDEN["notched"]
    assert b == GOLDEN["macos"]
