"""Mouse-wheel model tests mirroring js/test/wheel.spec.ts."""
import json
import statistics

from myuri.motion.wheel_model import generate_wheel_path
from myuri.rng import make_rng


def test_notched_whole_notches():
    for d, n in [(1000, 10), (-340, 3), (30, 1), (-60, 1), (149, 1), (151, 2)]:
        ev = generate_wheel_path(d, make_rng(1))
        assert sum(e.delta_y for e in ev) == (n if d > 0 else -n) * 100
        assert all(e.delta_y % 100 == 0 and (e.delta_y > 0) == (d > 0) for e in ev)
    assert generate_wheel_path(0.3, make_rng(1)) == []


def test_notched_flicks_in_frames():
    regrips, events, batched = [], 0, 0
    for seed in range(40):
        for e in generate_wheel_path(3000, make_rng(seed)):
            if e.delta_time >= 40:
                regrips.append(e.delta_time)
            else:
                assert e.delta_time in (16, 17, 33, 34)
            events += 1
            batched += abs(e.delta_y) > 100
    assert 0.4 < batched / events < 0.7
    assert 60 < statistics.median(regrips) < 100


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
GOLDEN = json.loads('{"notched":[[17,100],[16,300],[17,200],[17,100],[16,200],[17,100],[17,100],[53,100]],"macos":[[88,-16],[20,-16],[20,-96],[20,-112],[20,-144],[20,-160],[20,-160],[20,-160],[423,-32]]}')


def test_matches_typescript():
    a = [[e.delta_time, e.delta_y] for e in generate_wheel_path(1234, make_rng(42))]
    b = [[e.delta_time, e.delta_y] for e in generate_wheel_path(-900, make_rng(7), style="macos")]
    assert a == GOLDEN["notched"]
    assert b == GOLDEN["macos"]
