"""Tests for seed -> behavioral profile derivation (mirror of profile.spec.ts)."""
import dataclasses

from myuri.profile import profile_from_seed


def _flat(settings):
    return dataclasses.asdict(settings)


def test_deterministic_same_seed():
    assert _flat(profile_from_seed(1234)) == _flat(profile_from_seed(1234))


def test_differs_across_seeds():
    assert _flat(profile_from_seed(1234)) != _flat(profile_from_seed(9999))


def test_seed_normalized_mod_2_32():
    assert _flat(profile_from_seed(5)) == _flat(profile_from_seed(5 + 0x100000000))


def test_fields_in_range():
    for seed in [0, 1, 7, 42, 1234, 9999, 2 ** 31]:
        p = profile_from_seed(seed)
        assert 35 <= p.typing.wpm <= 130
        assert 0.4 <= p.typing.mistake_multiplier <= 2.0
        assert 0.75 <= p.scroll.speed_factor <= 1.4
        assert 0.3 <= p.scroll.finish_position <= 0.7
        assert 0.02 <= p.scroll.realism.speed_irregularity <= 0.18
        assert 60 <= p.overshoot.radius <= 200
        assert 300 <= p.overshoot.threshold <= 800
        assert p.overshoot.dwell.max_ms > p.overshoot.dwell.min_ms


# Reference values captured from the built TypeScript package (`generateProfile`).
# Because both languages share the Mulberry32 PRNG + Box-Muller draw, the same
# seed must yield identical profiles — this pins that cross-language contract.
_TS_REFERENCE = {
    0: {
        "wpm": 109,
        "mistake_multiplier": 1.3678485454764795,
        "scroll_speed_factor": 0.867959840859132,
        "overshoot_radius": 93.71148117954584,
        "dwell_min": 23,
        "dwell_max": 58,
    },
    1234: {
        "wpm": 68,
        "mistake_multiplier": 1.1555298233236206,
        "scroll_speed_factor": 1.174181314833933,
        "overshoot_radius": 183.22427128843862,
        "dwell_min": 13,
        "dwell_max": 33,
    },
    9999: {
        "wpm": 106,
        "mistake_multiplier": 0.7842296801487086,
        "scroll_speed_factor": 1.044618877620454,
        "overshoot_radius": 103.3084586449093,
        "dwell_min": 29,
        "dwell_max": 74,
    },
}


def test_cross_language_parity_with_typescript():
    for seed, ref in _TS_REFERENCE.items():
        p = profile_from_seed(seed)
        assert p.typing.wpm == ref["wpm"], seed
        assert abs(p.typing.mistake_multiplier - ref["mistake_multiplier"]) < 1e-9, seed
        assert abs(p.scroll.speed_factor - ref["scroll_speed_factor"]) < 1e-9, seed
        assert abs(p.overshoot.radius - ref["overshoot_radius"]) < 1e-9, seed
        assert p.overshoot.dwell.min_ms == ref["dwell_min"], seed
        assert p.overshoot.dwell.max_ms == ref["dwell_max"], seed
