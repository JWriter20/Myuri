from myuri.motion.click_model import click_hold_ms, drag_carry_speed, drag_end_ms, drag_start_ms, multi_click_gap_ms, pre_click_dwell_ms
from myuri.rng import make_rng


def test_cross_language_parity():
    # Same values as js/test/click.spec.ts.
    rng = make_rng(7)
    assert [click_hold_ms(rng) for _ in range(5)] == [166, 92, 76, 95, 90]
    assert [pre_click_dwell_ms(rng) for _ in range(5)] == [141, 15, 8, 5, 327]
    assert [multi_click_gap_ms(rng) for _ in range(5)] == [89, 88, 74, 78, 97]
    r2 = make_rng(11)
    assert [drag_start_ms(r2) for _ in range(5)] == [11, 15, 21, 4, 14]
    assert [drag_end_ms(r2) for _ in range(5)] == [99, 6, 64, 13, 3]
    assert [round(drag_carry_speed(r2), 6) for _ in range(2)] == [0.89843, 0.598639]


def test_hold_median_matches_recordings():
    rng = make_rng(3)
    hold = sorted(click_hold_ms(rng) for _ in range(4000))
    assert 85 < hold[2000] < 101
