"""Pure-module tests mirroring the TypeScript core suite."""
from myuri.rng import make_rng
from myuri.settings import default_settings, resolve_settings
from myuri.motion.scroll_model import scroll_model
from myuri.geometry import get_random_box_point
from myuri.types import BoundingBox


# Reference streams generated from the TS implementation — proves cross-language
# determinism (same seed -> same numbers in JS and Python).
TS_REFERENCE = {
    0: [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111],
    1: [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741],
    12345: [0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203],
}


def test_rng_cross_language_parity():
    for seed, expected in TS_REFERENCE.items():
        r = make_rng(seed)
        got = [r() for _ in range(4)]
        for g, e in zip(got, expected):
            assert abs(g - e) < 1e-12, f"seed {seed}: {g} != {e}"


def test_rng_seed_0_1_no_collision():
    z = make_rng(0)
    o = make_rng(1)
    assert [z() for _ in range(5)] != [o() for _ in range(5)]


def test_settings_deep_copy_isolation():
    s = resolve_settings(None)
    s.scroll.delay = 9999
    assert default_settings().scroll.delay != 9999


def test_scroll_model_never_empty_for_nonzero():
    for d in (2, 3, 4, 5, -3, 1):
        path = scroll_model.generate_scroll_path(d, make_rng(1))
        assert len(path) > 0


def test_scroll_model_integer_signed_sum():
    for d in (3, 37, 250, -180, 5, 42.6):
        path = scroll_model.generate_scroll_path(d, make_rng(2))
        for ev in path:
            assert isinstance(ev.delta_y, int)
        assert sum(ev.delta_y for ev in path) == round(d)


def test_scroll_model_no_sign_flip_downward():
    path = scroll_model.generate_scroll_path(300, make_rng(42))
    assert all(ev.delta_y >= 0 for ev in path)


def test_get_random_box_point_inside_bounds():
    rng = make_rng(99)
    box = BoundingBox(x=100, y=200, width=300, height=80)
    for _ in range(50):
        p = get_random_box_point(box, None, None, None, rng)
        assert box.x <= p.x <= box.x + box.width
        assert box.y <= p.y <= box.y + box.height
