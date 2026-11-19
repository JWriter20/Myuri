"""Tests for seed -> behavioral profile (mirror of profile.spec.ts)."""
import dataclasses

from myuri.profile import profile_from_seed
from myuri.settings import resolve_settings


def _leaves(o, path=""):
    """Every numeric leaf, by path."""
    out = {}
    for k, v in (o.items() if isinstance(o, dict) else dataclasses.asdict(o).items()):
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[path + k] = v
        elif isinstance(v, dict):
            out.update(_leaves(v, f"{path}{k}."))
    return out


def test_deterministic_and_normalizes_the_seed():
    assert profile_from_seed(1234) == profile_from_seed(1234)
    assert profile_from_seed(5) == profile_from_seed(5 + 0x100000000)
    assert profile_from_seed(1234) != profile_from_seed(9999)


def test_draws_each_trait_within_variation_of_the_configured_value():
    settings = {"variation": 0.1, "mouse": {"speed_factor": 3}, "typing": {"wpm": 40}}
    base = _leaves(resolve_settings(settings))
    for seed in [0, 1, 7, 42, 1234, 9999, 2 ** 31]:
        for path, value in _leaves(profile_from_seed(seed, settings)).items():
            assert base[path] * 0.9 - 1e-9 <= value <= base[path] * 1.1 + 1e-9, path


def test_runs_the_settings_exactly_at_variation_0():
    settings = {"variation": 0, "typing": {"wpm": 120, "pauses": {"rate": 0.5}}}
    assert profile_from_seed(42, settings) == resolve_settings(settings)


def test_keeps_a_scrolls_finish_position_inside_the_viewport():
    for seed in range(50):
        assert profile_from_seed(seed, {"scroll": {"finish_position": 1}}).scroll.finish_position <= 1


# From the built TypeScript package (`generateProfile`): both languages draw
# with Mulberry32 and Box-Muller, so a seed must give the same profile.
_TS_REFERENCE = {
    0: (1.1626432308190267, 86.14107250989854, 1.0672724081568574, 1.1279311687843425, 0.9622229155441594, 0.4782775318858031, 132.61195013062218, 68.20541450814099),
    1234: (0.9340308850494072, 81.6000448882113, 1.1169158843923896, 1.0032505031734065, 0.989651989431932, 0.4296680652307818, 125.33245108538128, 57.22369931537004),
    9999: (1.1440882755195008, 72.24667955808583, 0.9692973829533924, 0.8817423901817629, 0.8, 0.542588841295806, 112.60216046224144, 48.18913491576139),
}


def test_cross_language_parity_with_typescript():
    for seed, ref in _TS_REFERENCE.items():
        p = profile_from_seed(seed)
        got = (p.mouse.speed_factor, p.typing.wpm, p.typing.mistake_multiplier, p.typing.pauses.rate,
               p.scroll.speed_factor, p.scroll.finish_position, p.overshoot.radius, p.overshoot.dwell.max_ms)
        assert all(abs(a - b) < 1e-9 for a, b in zip(got, ref)), (seed, got)


def test_uses_the_oss_wheel_style_unless_settings_name_one():
    assert profile_from_seed(1, None, "macos").scroll.wheel.style == "macos"
    assert profile_from_seed(1, None, "windows").scroll.wheel.style == "notched"
    assert profile_from_seed(1, {"scroll": {"wheel": {"style": "notched"}}}, "macos").scroll.wheel.style == "notched"
