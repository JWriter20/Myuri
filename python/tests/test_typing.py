"""Typing-engine tests mirroring the TypeScript suite."""
import pytest

from myuri.rng import make_rng
from myuri.typing_engine.typer import HumanTyper


class RecordingInput:
    def __init__(self):
        self.keys = []

    async def press(self, key, delay=None):
        self.keys.append(key)

    async def down(self, key):
        self.keys.append(f"down:{key}")

    async def up(self, key):
        self.keys.append(f"up:{key}")


def reconstruct(keys):
    out = ""
    for k in keys:
        if k == "Enter":
            out += "\n"
        elif k == "Tab":
            out += "\t"
        elif k == "Backspace":
            out = out[:-1]
        elif k.startswith("down:") or k.startswith("up:"):
            continue
        else:
            out += k
    return out


@pytest.mark.asyncio
async def test_types_plain_text_exactly_without_mistakes():
    inp = RecordingInput()
    typer = HumanTyper(inp, mistake_multiplier=0, rng=make_rng(1))
    await typer.type("hello world")
    assert reconstruct(inp.keys) == "hello world"


@pytest.mark.asyncio
async def test_emoji_stays_single_press():
    inp = RecordingInput()
    typer = HumanTyper(inp, mistake_multiplier=0, rng=make_rng(2))
    await typer.type("a👍b")
    for k in inp.keys:
        if len(k) == 1:
            assert not (0xD800 <= ord(k) <= 0xDFFF)
    assert reconstruct(inp.keys) == "a👍b"


@pytest.mark.asyncio
async def test_newline_tab_mapped_to_keys():
    inp = RecordingInput()
    typer = HumanTyper(inp, mistake_multiplier=0, rng=make_rng(3))
    await typer.type("a\nb\tc")
    assert "Enter" in inp.keys
    assert "Tab" in inp.keys
    assert "\n" not in inp.keys
    assert "\t" not in inp.keys
    assert reconstruct(inp.keys) == "a\nb\tc"


@pytest.mark.asyncio
async def test_never_types_wrong_text_under_high_mistakes():
    inp = RecordingInput()
    typer = HumanTyper(inp, mistake_multiplier=5, rng=make_rng(4))
    await typer.type("correctness")
    assert reconstruct(inp.keys) == "correctness"


@pytest.mark.asyncio
async def test_delete_all_with_modifier():
    inp = RecordingInput()
    typer = HumanTyper(inp, rng=make_rng(5))
    await typer.delete_all(0, "Control")
    assert "down:Control" in inp.keys
    assert "a" in inp.keys
    assert "up:Control" in inp.keys
    assert "Backspace" in inp.keys
