"""Smart actions: clicking, scrolling and typing as a person does, on any host.

:class:`Actions` owns the timing and motion of every input, and the decisions
around a click: scroll the element into view, choose a point a person would,
check that a press there reaches the element, and try again when it does not.
The host owns the shape of each event: it sends a move, press or key however
its browser takes them.

Each action is a flow, a generator that yields the host's calls. :func:`run_sync`
runs it on a host whose calls return their results; :func:`run_async` awaits
them. ``Actions.run`` picks the one the host needs.

The parts (:data:`PARTS`) are the steps a flow is built from. Pass ``parts`` to
replace any of them; the rest, and the flows that call them, stay myuri's. A
part is called as ``fn(host, *args, default=, rng=, play=)``:

- ``move(x, y)``: move the cursor to (x, y).
- ``press(button, click_count)``: press where the cursor is.
- ``point(box, attempt)``: the ``(x, y)`` in a :class:`BoundingBox` to press.
- ``reaches(target, x, y, pressing)``: why a press at (x, y) would miss
  ``target``, or None.
- ``into_view(target)``: scroll ``target`` into view.
- ``wheel(dx, dy)``: turn the wheel.
- ``type(text)`` and ``key(key)``: type text, or press a key or chord.

``default(*args)`` runs myuri's part (with the same arguments when given none),
``rng`` is the action stream, and ``play(steps)`` plays a timeline (see
:func:`validate_steps`). In an async host each returns an awaitable, and the
part may return one.
"""
from __future__ import annotations

import inspect
import itertools
import math
from typing import Any, Callable, Dict, Generator, List, Mapping, Optional, Protocol, Sequence, Tuple, Union

from .geometry import get_random_box_point, should_overshoot
from .page_functions import HIT_TEST_JS, SCROLL_EDGE, SCROLL_FINISH_POSITION, SCROLL_PAD, SCROLL_PLAN_JS
from .plan import CLICK_RUN_MS, WheelSpec, move_with, plan_click, plan_point, plan_press, plan_type, wheel_steps, wheel_style_for
from .rng import Rng
from .settings import MyuriSettings, resolve_settings
from .target_os import check_os
from .types import BoundingBox, Vector

Flow = Generator[Any, Any, Any]

PARTS = ("move", "press", "point", "reaches", "into_view", "wheel", "type", "key")

RETRY_MS = (0, 20, 100, 100, 500)
"""The waits between attempts at a click, as Playwright waits between attempts at an action."""

SCROLL_PASSES = 3
"""Scroll plans played before an element is taken as in view (one that moves as it scrolls needs more than one)."""

LANDING_MS = (50, 1000)
"""How often a wheel's scroll is checked for having landed, and how long it may take."""

_BUTTONS = ("left", "right", "middle")


class Host(Protocol):
    """What :class:`Actions` drives. Each call returns its result, or an
    awaitable of it on an async host; ``now`` is always synchronous."""

    def move(self, x: float, y: float) -> Any: ...
    def click(self, button: str, click_count: int, hold_ms: float) -> Any:
        """Press and release, holding the button ``hold_ms``; ``click_count`` is the press's place in a run."""
    def down(self, button: str) -> Any: ...
    def up(self, button: str) -> Any: ...
    def wheel(self, dx: float, dy: float) -> Any: ...
    def key_down(self, key: str) -> Any: ...
    def key_up(self, key: str) -> Any: ...
    def insert_text(self, text: str) -> Any: ...
    def evaluate(self, target: Any, fn: str, arg: Any) -> Any:
        """Run the page function ``(el, arg) => ...`` on the target's element, in its own window."""
    def offset(self, target: Any) -> Any:
        """``(dx, dy)`` from the target's window to the page, or None when the target has no element."""
    def viewport(self) -> Any:
        """``(width, height)`` of the page."""
    def now(self) -> float:
        """Milliseconds on a monotonic clock."""
    def sleep(self, ms: float) -> Any: ...


class Missed(RuntimeError):
    """A click could not reach its element; the message says why."""


def run_sync(flow: Flow) -> Any:
    """Run a flow on a host whose calls return their results."""
    value: Any = None
    while True:
        try:
            value = flow.send(value)
        except StopIteration as stop:
            return stop.value


async def run_async(flow: Flow) -> Any:
    """Run a flow on a host whose calls return awaitables. A call's error is
    raised in the flow, where it was made."""
    value: Any = None
    error: Optional[BaseException] = None
    while True:
        try:
            item = flow.throw(error) if error is not None else flow.send(value)
        except StopIteration as stop:
            return stop.value
        value, error = None, None
        try:
            value = (await item) if inspect.isawaitable(item) else item
        except BaseException as e:  # noqa: BLE001 -- raised in the flow
            error = e


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_steps(steps: Any) -> List[Tuple[str, Tuple, float]]:
    """
    The steps of a timeline as ``(kind, args, t)``, or ValueError naming the
    first bad step. Nothing is played unless every step is valid.

        ('move', x, y, t)   ('down', button, t)   ('up', button, t)
        ('wheel', dx, dy, t)   ('key', key, 'down' | 'up', t)   ('text', text, t)

    t is milliseconds from the start of the timeline, non-decreasing.
    """
    if isinstance(steps, (str, bytes, Mapping)) or not hasattr(steps, "__iter__"):
        raise ValueError(f"play() takes a list of steps, got {steps!r}")
    plan: List[Tuple[str, Tuple, float]] = []
    last = 0.0
    for i, step in enumerate(steps):
        def bad(why: str) -> ValueError:
            return ValueError(f"play() step {i} {step!r}: {why}")

        if not isinstance(step, (tuple, list)) or not step or not isinstance(step[0], str):
            raise bad('a step is a tuple such as ("move", x, y, t)')
        kind, *args = step
        arity = {"move": 3, "down": 2, "up": 2, "wheel": 3, "key": 3, "text": 2}.get(kind)
        if arity is None:
            raise bad("the kind must be move, down, up, wheel, key or text")
        if len(args) != arity:
            raise bad(f"{kind} takes {arity} values after the kind")
        *values, t = args
        if not _number(t) or t < 0:
            raise bad("t must be a finite number of milliseconds, at least 0")
        if t < last:
            raise bad(f"t goes back in time ({t} after {last})")
        last = t
        if kind in ("move", "wheel") and not all(_number(v) for v in values):
            raise bad(f"{kind} takes finite numbers")
        if kind in ("down", "up") and values[0] not in _BUTTONS:
            raise bad(f"the button must be one of {_BUTTONS}")
        if kind == "key" and (not isinstance(values[0], str) or not values[0] or values[1] not in ("down", "up")):
            raise bad('key takes a key name and "down" or "up"')
        if kind == "text" and not isinstance(values[0], str):
            raise bad("text takes a string")
        plan.append((kind, tuple(values), float(t)))
    return plan


def _js_round(v: float) -> int:
    return math.floor(v + 0.5)


def _key_steps(steps: Sequence[Tuple[float, str, str]]) -> List[Tuple]:
    return [("text", key, t) if action == "insert" else ("key", key, action, t) for t, action, key in steps]


class Actions:
    """
    The smart actions on one host, for a person on ``os`` (the OS the browser
    claims). ``rng`` is the random stream every draw comes from, so one seed
    replays the same actions. ``device`` is what the wheel is ('mouse' or
    'trackpad'; ``settings.scroll.device`` by default), ``wpm`` the typing speed (``settings.typing.wpm`` by default),
    and ``parts`` replaces parts by name (see the module).

    The tuning attributes apply to the actions that follow: ``move_speed``
    (a multiplier), ``overshoot_threshold`` (px; a longer move overshoots and
    corrects), ``hold_ms`` (a fixed hold for each press), ``finish_position``
    (where a scroll leaves the element) and ``scroll_passes``.
    """

    def __init__(
        self,
        host: Host,
        rng: Rng,
        *,
        os: Optional[str] = None,
        settings: Union[MyuriSettings, Dict[str, Any], None] = None,
        device: Optional[str] = None,
        wpm: Optional[float] = None,
        asynchronous: bool = False,
        parts: Optional[Mapping[str, Callable[..., Any]]] = None,
    ) -> None:
        check_os(os)
        unknown = sorted(set(parts or ()) - set(PARTS))
        if unknown:
            raise TypeError(f"myuri: {unknown[0]!r} is not a part; the parts are {', '.join(PARTS)}")
        if not isinstance(settings, MyuriSettings):
            resolved = resolve_settings(settings)
            resolved.scroll.wheel.style = wheel_style_for(os, settings)
            settings = resolved
        self.host = host
        self.rng = rng
        self.os = os
        self.settings = settings
        self.device = device or settings.scroll.device
        self.wpm = settings.typing.wpm if wpm is None else wpm
        self.asynchronous = asynchronous
        self.parts: Dict[str, Callable[..., Any]] = dict(parts or {})
        self.move_speed: Optional[float] = None
        self.overshoot_threshold: float = settings.overshoot.threshold
        self.hold_ms: Optional[float] = None
        self.finish_position: float = SCROLL_FINISH_POSITION
        self.scroll_passes: int = SCROLL_PASSES
        # Where the cursor is, in page px; None until known. Before the first
        # move it is only where the person's hand is taken to be.
        self.cursor: Optional[Vector] = None
        self._placed = False
        self._moved_at = -math.inf
        self._released_at = -math.inf

    def run(self, flow: Flow) -> Any:
        """Run a flow as the host needs: its result, or an awaitable of it."""
        return run_async(flow) if self.asynchronous else run_sync(flow)

    def moved(self, x: float, y: float) -> None:
        """Record a move the host made outside these flows."""
        self.cursor = Vector(x, y)
        self._placed = True
        self._moved_at = self.host.now()

    def _part(self, name: str, *args: Any) -> Flow:
        default = getattr(self, "_default_" + name)
        fn = self.parts.get(name)
        if fn is None:
            return (yield from default(*args))
        return (yield fn(
            self.host,
            *args,
            default=lambda *a: self.run(default(*(a or args))),
            rng=self.rng,
            play=lambda steps: self.run(self.play(steps)),
        ))

    def _wait(self, ms: float) -> Flow:
        if ms > 0:
            yield self.host.sleep(ms)

    def _here(self) -> Flow:
        if self.cursor is None:
            width, height = yield self.host.viewport()
            self.cursor = Vector(self.rng() * width, self.rng() * height)
        return self.cursor

    # ---- flows ----------------------------------------------------------------

    def play(self, steps: Any) -> Flow:
        """Play a timeline, each step at its time from the start; a late step
        delays only itself."""
        host = self.host
        timeline = validate_steps(steps)
        start = host.now()
        for kind, values, t in timeline:
            # A timer may fire early, so wait until the step is due.
            while start + t - host.now() > 0:
                yield host.sleep(start + t - host.now())
            if kind == "move":
                yield host.move(*values)
                self.moved(*values)
            elif kind == "down":
                yield host.down(values[0])
            elif kind == "up":
                yield host.up(values[0])
                self._released_at = host.now()
            elif kind == "wheel":
                yield host.wheel(*values)
            elif kind == "key":
                yield (host.key_down if values[1] == "down" else host.key_up)(values[0])
            else:
                yield host.insert_text(values[0])

    def move(self, x: float, y: float) -> Flow:
        """Move the cursor to (x, y)."""
        return (yield from self._part("move", x, y))

    def press(self, button: str = "left", click_count: int = 1, modifiers: Sequence[str] = ()) -> Flow:
        """Press where the cursor is, ``click_count`` times, holding ``modifiers``."""
        for key in modifiers:
            yield self.host.key_down(key)
        yield from self._part("press", button, click_count)
        self._released_at = self.host.now()
        for key in reversed(modifiers):
            yield self.host.key_up(key)

    def click_at(self, x: float, y: float, button: str = "left", click_count: int = 1) -> Flow:
        """Move to (x, y) and press there."""
        yield from self._part("move", x, y)
        yield from self.press(button, click_count)

    def wheel(self, dx: float, dy: float) -> Flow:
        """Scroll ``dy`` px down, then ``dx`` px right."""
        return (yield from self._part("wheel", dx, dy))

    def type(self, text: str) -> Flow:
        """Type ``text`` into what has focus."""
        return (yield from self._part("type", text))

    def key(self, key: str) -> Flow:
        """Press a key or chord in Playwright's notation ('Enter', 'Control+a')."""
        return (yield from self._part("key", key))

    def into_view(self, target: Any) -> Flow:
        """Scroll ``target`` into view with the wheel."""
        return (yield from self._part("into_view", target))

    def measure(self, target: Any) -> Flow:
        """The scroll plan of ``target`` in page px (``SCROLL_PLAN_JS``), or
        None when it is not visible."""
        offset = yield self.host.offset(target)
        if offset is None:
            return None
        dx, dy = offset
        here = yield from self._here()
        plan = yield self.host.evaluate(target, SCROLL_PLAN_JS, {
            "finishPosition": self.finish_position, "pad": SCROLL_PAD, "edge": SCROLL_EDGE,
            "fromX": here.x - dx, "fromY": here.y - dy,
        })
        if plan is None:
            return None
        plan["hoverX"] += dx
        plan["hoverY"] += dy
        for rect in (plan["region"], plan["box"]):
            if rect is not None:
                rect["x"] += dx
                rect["y"] += dy
        return plan

    def click(
        self,
        target: Any,
        *,
        button: str = "left",
        click_count: int = 1,
        modifiers: Sequence[str] = (),
        position: Optional[Mapping[str, float]] = None,
        force: bool = False,
        press: bool = True,
        timeout: Optional[float] = None,
        attempts: Optional[int] = None,
    ) -> Flow:
        """
        Scroll ``target`` into view, move onto it and press. ``position`` is a
        point from the element's padding box, as Playwright takes it; without
        it, the point is chosen in the element's visible part. Unless ``force``,
        the press must reach the element. A miss is tried again, until
        ``attempts`` tries or ``timeout`` ms (0 or None: no limit), then raises
        :class:`Missed`. With ``press=False`` the cursor stops on the element.
        """
        host = self.host
        deadline = host.now() + timeout if timeout else math.inf
        for attempt in itertools.count():
            try:
                yield from self._part("into_view", target)
                plan = yield from self.measure(target)
                if plan is None:
                    raise Missed("element is not visible")
                if position is not None:
                    box, (left, top) = plan["box"], plan["borders"]
                    x, y = box["x"] + left + position["x"], box["y"] + top + position["y"]
                elif plan["region"] is None:
                    raise Missed("element is outside of the viewport or covered")
                else:
                    x, y = yield from self._part("point", BoundingBox(**plan["region"]), attempt)
                yield from self._part("move", x, y)
                if not force:
                    at = self.cursor if self._placed else Vector(x, y)
                    reason = yield from self._part("reaches", target, at.x, at.y, press)
                    if reason:
                        raise Missed(reason)
                if press:
                    yield from self.press(button, click_count, modifiers)
                return None
            except Missed:
                if (attempts is not None and attempt + 1 >= attempts) or host.now() >= deadline:
                    raise
                yield from self._wait(RETRY_MS[min(attempt, len(RETRY_MS) - 1)])

    # ---- default parts --------------------------------------------------------

    def _default_move(self, x: float, y: float) -> Flow:
        width, height = yield self.host.viewport()

        def settle(p: Vector) -> Vector:
            return Vector(min(max(_js_round(p.x), 0), width - 1), min(max(_js_round(p.y), 0), height - 1))

        end = settle(Vector(x, y))
        if self._placed and self.cursor == end:
            return None
        start = yield from self._here()
        points = move_with(
            start, end, self.rng,
            move_speed=self.move_speed,
            overshoot=should_overshoot(start, end, self.overshoot_threshold),
            settings=self.settings.overshoot,
            settle=settle,
        )
        steps = []
        last = self.cursor if self._placed else None
        for p in points:
            pos = settle(Vector(p.x, p.y))
            # Only macOS reports a mouse that has not left its pixel; elsewhere it sends nothing.
            if pos == last and self.os != "macos":
                continue
            steps.append(("move", pos.x, pos.y, p.t))
            last = pos
        return (yield from self.play(steps))

    def _default_press(self, button: str, click_count: int) -> Flow:
        host = self.host
        now = host.now()
        resting = self._moved_at < self._released_at
        since = now - self._released_at if resting else None
        planned = plan_click(self.rng, os=self.os, click_count=click_count, since_release_ms=since)
        yield from self._wait(planned["dwell_ms"] if resting else self._moved_at + planned["dwell_ms"] - now)
        # A press continuing a run is the run's next click.
        first = 2 if since is not None and since < CLICK_RUN_MS else 1
        presses = planned["presses"]
        for i, (down, up) in enumerate(presses):
            if i:
                yield from self._wait(down - presses[i - 1][1])
            yield host.click(button, first + i, up - down if self.hold_ms is None else self.hold_ms)

    def _default_point(self, box: BoundingBox, attempt: int) -> Flow:
        here = yield from self._here()
        # Another attempt aims somewhere new, not again where the last one missed.
        p = plan_point(box, self.rng, start=here) if attempt == 0 else get_random_box_point(box, None, here, None, self.rng)
        return (p.x, p.y)

    def _default_reaches(self, target: Any, x: float, y: float, pressing: bool) -> Flow:
        offset = yield self.host.offset(target)
        if offset is None:
            return "element is not visible"
        return (yield self.host.evaluate(target, HIT_TEST_JS, {"x": x - offset[0], "y": y - offset[1], "pressing": pressing}))

    def _default_into_view(self, target: Any) -> Flow:
        for _ in range(self.scroll_passes):
            plan = yield from self.measure(target)
            if plan is None or plan["inView"] or abs(plan["deltaY"]) < 1:
                return None
            # Over the scroller the plan chose, so the wheel scrolls it.
            yield from self._part("move", plan["hoverX"], plan["hoverY"])
            yield from self._part("wheel", 0, plan["deltaY"])
            yield from self._landed(target)
        return None

    def _landed(self, target: Any) -> Flow:
        """Wait until the element stops moving, as a person waits for a scroll
        to land before aiming; a page that never stops is given ``LANDING_MS``."""
        every, limit = LANDING_MS
        deadline = self.host.now() + limit
        last = yield from self.measure(target)
        while self.host.now() < deadline:
            yield from self._wait(every)
            plan = yield from self.measure(target)
            if (plan and plan["box"]) == (last and last["box"]):
                return None
            last = plan
        return None

    def _default_wheel(self, dx: float, dy: float) -> Flow:
        s = self.settings.scroll
        spec = WheelSpec(self.device, s.wheel, s.realism.speed_irregularity)
        return (yield from self.play(wheel_steps(dx, dy, self.rng, os=self.os, spec=spec)))

    def _default_type(self, text: str) -> Flow:
        steps = plan_type(text, self.rng, os=self.os, wpm=self.wpm, mistake_multiplier=self.settings.typing.mistake_multiplier)
        return (yield from self.play(_key_steps(steps)))

    def _default_key(self, key: str) -> Flow:
        return (yield from self.play(_key_steps(plan_press(key, self.rng, os=self.os, wpm=self.wpm))))


__all__ = ["Actions", "Host", "LANDING_MS", "Missed", "PARTS", "RETRY_MS", "SCROLL_PASSES", "run_async", "run_sync", "validate_steps"]
