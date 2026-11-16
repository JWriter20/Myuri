from myuri.motion.click_model import click_hold_ms, drag_carry_speed, drag_end_ms, drag_start_ms, multi_click_gap_ms, pre_click_dwell_ms
from myuri.rng import make_rng


def test_cross_language_parity():
    # Same values as js/test/click.spec.ts.
    rng = make_rng(7)
    assert [click_hold_ms(rng) for _ in range(5)] == [199, 96, 76, 100, 94]
    assert [pre_click_dwell_ms(rng) for _ in range(5)] == [68, 15, 9, 7, 123]
    assert [multi_click_gap_ms(rng) for _ in range(5)] == [120, 118, 77, 90, 146]
    r2 = make_rng(11)
    assert [drag_start_ms(r2) for _ in range(5)] == [50, 59, 69, 27, 55]
    assert [drag_end_ms(r2) for _ in range(5)] == [78, 16, 61, 24, 11]
    assert [round(drag_carry_speed(r2), 6) for _ in range(2)] == [0.89843, 0.598639]


def test_hold_median_matches_recordings():
    rng = make_rng(3)
    hold = sorted(click_hold_ms(rng) for _ in range(4000))
    assert 88 < hold[2000] < 106
