"""Typing-engine tests mirroring the TypeScript suite (js/test/typing.spec.ts)."""
import json
import statistics

import pytest

from myuri.cursor import Cursor
from myuri.drivers import Driver
from myuri.rng import make_rng
from myuri.typing_engine.markov import MarkovTyper
from myuri.typing_engine.timing import (
    REFERENCE_MEAN_GAP_MS,
    KeystrokeTiming,
    Stroke,
    log_gap_mean,
    needs_shift,
    strokes_for_text,
)
from myuri.typing_engine.typer import HumanTyper

PARAGRAPH = (
    "Hello Sarah, thanks for getting back to me so quickly. I have attached the "
    "updated draft (version 4) and would love your thoughts before Monday. The "
    "main change is in section two, where we now explain how the numbers were "
    "collected. Let me know if anything is unclear!"
)


class VirtualClock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    async def sleep(self, ms):
        self.t += ms


class RecordingInput:
    """Records (t, op, key); each call can cost ``latency`` ms like a real driver."""

    def __init__(self, clock, latency=0.0):
        self.clock = clock
        self.latency = latency
        self.log = []

    def _at(self, op, key):
        self.log.append((self.clock.t, op, key))
        self.clock.t += self.latency

    async def down(self, key):
        self._at("down", key)

    async def up(self, key):
        self._at("up", key)

    async def insert_text(self, text):
        self._at("insert", text)


def make_typer(seed, mistake_multiplier=0, wpm=80, latency=0.0):
    clock = VirtualClock()
    inp = RecordingInput(clock, latency)
    typer = HumanTyper(
        inp, mistake_multiplier=mistake_multiplier, wpm=wpm, rng=make_rng(seed), clock=clock
    )
    return typer, inp.log


def reconstruct(log):
    out = []
    for _, op, key in log:
        if op == "insert":
            out.append(key)
        if op != "down" or key == "Shift":
            continue
        if key == "Enter":
            out.append("\n")
        elif key == "Tab":
            out.append("\t")
        elif key == "Backspace":
            out = out[:-1]
        else:
            out.append(key)
    return "".join(out)


def assert_balanced(log):
    held = set()
    for t, op, key in log:
        if op == "down":
            assert key not in held, f"{key} pressed twice at {t}"
            held.add(key)
        elif op == "up":
            assert key in held, f"{key} released while up at {t}"
            held.discard(key)
    assert not held


@pytest.mark.asyncio
async def test_types_plain_text_exactly_without_mistakes():
    typer, log = make_typer(1)
    await typer.type("hello world")
    assert reconstruct(log) == "hello world"
    assert_balanced(log)


@pytest.mark.asyncio
async def test_emoji_is_a_single_insert():
    typer, log = make_typer(2)
    await typer.type("a👍b")
    assert [k for _, op, k in log if op == "insert"] == ["👍"]
    assert reconstruct(log) == "a👍b"


@pytest.mark.asyncio
async def test_newline_tab_mapped_to_keys():
    typer, log = make_typer(3)
    await typer.type("a\nb\tc")
    keys = [k for _, _, k in log]
    assert "Enter" in keys and "Tab" in keys
    assert "\n" not in keys and "\t" not in keys
    assert reconstruct(log) == "a\nb\tc"


@pytest.mark.asyncio
async def test_never_types_wrong_text_under_high_mistakes():
    for seed in range(30):
        typer, log = make_typer(seed, mistake_multiplier=5)
        await typer.type("Correctness, mostly!")
        assert reconstruct(log) == "Correctness, mostly!"
        assert_balanced(log)


@pytest.mark.asyncio
async def test_shift_held_exactly_for_shifted_keys():
    for seed in range(20):
        typer, log = make_typer(seed, mistake_multiplier=2)
        await typer.type('Hi NASA team: "Q4" results (50% up) are IN! ok?')
        shift = False
        for _, op, key in log:
            if key == "Shift":
                shift = op == "down"
            elif op == "down":
                assert shift == needs_shift(key), key
        assert_balanced(log)


@pytest.mark.asyncio
async def test_rollover_and_holds():
    typer, log = make_typer(7)
    await typer.type(PARAGRAPH)
    downs = [(t, k) for t, op, k in log if op == "down" and k != "Shift"]
    holds, overlaps = [], 0
    for i, (t, k) in enumerate(downs):
        up = next(ut for ut, op, uk in log if op == "up" and uk == k and ut >= t)
        holds.append(up - t)
        if i + 1 < len(downs) and up > downs[i + 1][0]:
            overlaps += 1
    # Recorded: letters ~100 ms, space ~80; rollover 35% of pairs.
    assert 65 < statistics.median(holds) < 140
    assert 0.15 < overlaps / (len(downs) - 1) < 0.6


@pytest.mark.asyncio
async def test_absolute_clock_absorbs_driver_latency():
    plain, plain_log = make_typer(11)
    await plain.type(PARAGRAPH)
    slow, slow_log = make_typer(11, latency=4)
    await slow.type(PARAGRAPH)

    def span(log):
        return log[-1][0] - log[0][0]

    # ~500 actions x 4 ms would add ~2 s if latency stacked.
    assert span(slow_log) - span(plain_log) < 200


@pytest.mark.asyncio
async def test_delete_all_with_modifier():
    typer, log = make_typer(5)
    await typer.delete_all(0, "Control")
    seq = [f"{op}:{k}" for _, op, k in log]
    assert seq[0] == "down:Control"
    assert 0 < seq.index("down:a") < seq.index("up:Control") < seq.index("down:Backspace")
    assert_balanced(log)


@pytest.mark.asyncio
async def test_releases_held_keys_when_driver_fails():
    clock = VirtualClock()
    inp = RecordingInput(clock)
    calls = {"n": 0}
    real_down = inp.down

    async def failing_down(key):
        calls["n"] += 1
        if calls["n"] == 4:
            raise RuntimeError("page closed")
        await real_down(key)

    inp.down = failing_down
    typer = HumanTyper(inp, mistake_multiplier=0, rng=make_rng(1), clock=clock)
    with pytest.raises(RuntimeError, match="page closed"):
        await typer.type("ABCDEF")
    assert_balanced(inp.log)


def test_hits_requested_wpm():
    text = PARAGRAPH * 4
    for wpm in (40, 80, 120):
        gaps = []
        for seed in range(10):
            _, down_at = KeystrokeTiming(wpm, make_rng(seed)).plan(strokes_for_text(text))
            gaps.append((down_at[-1] - down_at[0]) / (len(down_at) - 1))
        mean = sum(gaps) / len(gaps)
        target = 12000 / wpm
        assert abs(mean - target) / target < 0.12, (wpm, mean)


def test_common_bigrams_are_faster_and_contexts_pause():
    def g(a, b):
        return log_gap_mean(Stroke(a), Stroke(b))

    assert g("t", "h") < g("t", "k")
    assert g("i", "n") < g("i", "j")
    assert g(" ", "t") > g("e", "t")
    assert g("e", ",") > g("e", "t")
    assert g("e", "Backspace") > g("Backspace", "Backspace")


# Cross-language parity: the same seed must give the TypeScript timeline
# (printed by js `new KeystrokeTiming(80, makeRng(1234)).plan(...)`, at rounded to 1 us).
GOLDEN_PLAN = json.loads(
    '[[0,"down","Shift"],[150.138,"down","H"],[263.151,"up","Shift"],[271.151,"down","i"],'
    '[293.428,"up","H"],[353.834,"up","i"],[492.417,"down"," "],[580.318,"up"," "],'
    '[819.842,"down","Shift"],[1001.93,"down","B"],[1029.454,"up","Shift"],[1066.322,"down","o"],'
    '[1084.714,"up","B"],[1117.961,"up","o"],[1196.196,"down","b"],[1279.598,"down",","],'
    '[1291.409,"up","b"],[1359.691,"up",","],[1387.867,"down"," "],[1447.326,"up"," "],'
    '[1541.419,"down","4"],[1652.544,"down","2"],[1661.337,"up","4"],[1738.821,"down"," "],'
    '[1740.77,"up","2"],[1797.731,"up"," "],[1905.154,"down","a"],[1967.755,"up","a"],'
    '[1987.854,"down","p"],[2108.033,"up","p"],[2150.38,"down","p"],[2250.689,"up","p"],'
    '[2299.399,"down","l"],[2384.725,"up","l"],[2397.021,"down","e"],[2455.089,"down","s"],'
    '[2467.832,"up","e"],[2519.629,"up","s"],[2754.242,"down","Shift"],[2981.747,"down","!"],'
    '[3047.762,"up","!"],[3061.731,"up","Shift"]]'
)


def test_timing_plan_matches_typescript():
    assert REFERENCE_MEAN_GAP_MS == pytest.approx(198.3783812468994, rel=1e-12)
    actions, _ = KeystrokeTiming(80, make_rng(1234)).plan(strokes_for_text("Hi Bob, 42 apples!"))
    assert [(a.type, a.key) for a in actions] == [(t, k) for _, t, k in GOLDEN_PLAN]
    for a, (at, _, _) in zip(actions, GOLDEN_PLAN):
        assert a.at == pytest.approx(at, abs=1e-3)


def test_markov_matches_typescript():
    rng = make_rng(99)
    history = MarkovTyper("the quick brown fox", 3, rng).run().history
    typed = "".join("<" if e.kind == "backspace" else e.chars for e in history)
    assert typed == "thd<e 1<quick brown fox"
    assert rng() == pytest.approx(0.7014950935263187, rel=1e-15)


# Regression: an AZERTY typo slip generated 'é', Playwright's press() threw
# "Unknown key" and typing aborted mid-field ("jane@" instead of the full email).
class _StrictKeyboardDriver(Driver):
    """Mimics Playwright: only named keys + printable US-layout ASCII are keys."""

    _NAMED = {"Enter", "Tab", "Backspace", "Shift"}

    def __init__(self):
        self.text = ""

    async def move(self, x, y):
        pass

    async def click(self, button="left"):
        pass

    async def down(self, key):
        if key in self._NAMED:
            if key == "Backspace":
                self.text = self.text[:-1]
            return
        if not (len(key) == 1 and 0x20 <= ord(key) <= 0x7E):
            raise RuntimeError(f'keyboard.down: Unknown key: "{key}"')
        self.text += key

    async def up(self, key):
        pass

    async def wheel(self, delta_x, delta_y):
        pass

    async def press(self, key, delay=None):
        raise AssertionError("typing should use down/up")

    async def insert_text(self, text):
        self.text += text

    async def evaluate(self, js, arg=None):
        return None


@pytest.mark.asyncio
async def test_cursor_type_completes_accented_text_on_strict_keyboard():
    driver = _StrictKeyboardDriver()
    cursor = Cursor(
        driver,
        seed=42,
        settings={"typing": {"mistake_multiplier": 4, "wpm": 2000}},
    )
    await cursor.type("josé@example.com")
    assert driver.text == "josé@example.com"
