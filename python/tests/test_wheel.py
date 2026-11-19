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


def test_notched_scroll_to_a_target():
    # Recorded scrolls to a target (find-and-click, scroll-box-accept, shop-flow):
    # strokes of 5/8/12 notches (p10/50/90), re-grips median 125 ms, a third of
    # events carry 2+ notches, and 68-69 notches took 1.7-1.9 s.
    strokes, regrips, durations, events, batched = [], [], [], 0, 0
    for seed in range(40):
        ev = generate_wheel_path(6800, make_rng(seed))
        durations.append(sum(e.delta_time for e in ev[:-1]))
        notches = 0
        for e in ev:
            notches += abs(e.delta_y) // 100
            if e.delta_time >= 40:
                regrips.append(e.delta_time)
                strokes.append(notches)
                notches = 0
            else:
                assert e.delta_time in (16, 17, 33, 34)
            events += 1
            batched += abs(e.delta_y) > 100
    assert 6 <= statistics.median(strokes) <= 11
    assert 100 < statistics.median(regrips) < 160
    assert 0.2 < batched / events < 0.45
    assert 1400 < statistics.median(durations) < 2600


def test_notched_short_scroll_is_nudged():
    gaps = []
    for seed in range(200):
        ev = generate_wheel_path(500, make_rng(seed))
        # Recorded short scrolls all open with one notch, then a re-grip.
        assert ev[0].delta_y == 100 and ev[0].delta_time >= 45
        gaps += [e.delta_time for e in ev[:-1]]
    # Recorded bursts of 4-6 notches: event gaps p10/50/90 16/47/78 ms.
    assert sorted(gaps)[len(gaps) // 10] <= 17
    assert 40 < statistics.median(gaps) < 75


def test_macos_regrip_keeps_speed():
    carried = restarted = 0
    for seed in range(30):
        ev = generate_wheel_path(-4000, make_rng(seed), style="macos")
        assert sum(e.delta_y for e in ev) == -250 * 16
        assert ev[0].delta_y == -16
        for i in range(len(ev) - 1):
            assert ev[i].delta_y % 16 == 0 and abs(ev[i].delta_y) <= 13 * 16
            if ev[i].delta_time in (20, 40):
                continue
            # Recorded on macOS: after <= 140 ms the next stroke starts at the
            # last frame's lines or one fewer; after 160+ ms, at one line.
            if ev[i].delta_time <= 150:
                carried += 1
                # The scroll's last event sends only what is left.
                if i + 2 < len(ev):
                    assert abs(ev[i + 1].delta_y) >= abs(ev[i].delta_y) - 16
            else:
                restarted += 1
                assert ev[i + 1].delta_y == -16
    assert carried and restarted


# Cross-language parity: printed by js generateWheelPath(1234, makeRng(42)) and
# generateWheelPath(-900, makeRng(7), { style: 'macos' }).
GOLDEN = json.loads('{"notched":[[17,100],[16,100],[17,200],[33,100],[50,100],[17,100],[17,100],[16,100],[17,100],[317,100],[77,100]],"macos":[[88,-16],[20,-16],[20,-48],[20,-64],[20,-112],[20,-128],[20,-160],[40,-160],[20,-160],[229,-32]]}')


def test_matches_typescript():
    a = [[e.delta_time, e.delta_y] for e in generate_wheel_path(1234, make_rng(42))]
    b = [[e.delta_time, e.delta_y] for e in generate_wheel_path(-900, make_rng(7), style="macos")]
    assert a == GOLDEN["notched"]
    assert b == GOLDEN["macos"]
