"""Compare human-input recordings side by side: people and myuri replays.

usage: python3 fidelity/compare.py DIR [DIR ...]

Each DIR holds events.ndjson.gz from record_human_input.html (a person) or from
fidelity/replay.mjs (myuri). Prints, per metric, one column per DIR. A metric
reads only the tasks that exercise it, so a replay that skipped a task shows a
blank instead of a wrong number. Standard library only.
"""

from __future__ import annotations

import collections
import gzip
import json
import statistics
import sys
from pathlib import Path

MOVE_NOISE = {"pointermove", "mousemove", "pointerover", "pointerout", "pointerenter", "pointerleave",
              "mouseover", "mouseout", "mouseenter", "mouseleave", "selectionchange", "selectstart",
              "focusin", "focusout", "blur", "gotpointercapture", "lostpointercapture", "scroll", "scrollend"}
CLICK_TASKS = {"targets", "buttons", "hover-menu", "choices", "rapid-click"}
TYPE_TASKS = {"type-short", "type-long", "type-symbols", "type-own-words"}
WHEEL_TASKS = {"notch-down", "notch-up", "notch-pixels", "notch-nested", "wheel-burst", "wheel-spin", "wheel-horizontal"}


def load(d: Path):
    task = None
    rep = None
    out = []
    with gzip.open(d / "events.ndjson.gz", "rt") as f:
        for line in f:
            e = json.loads(line)
            if e["type"] == "#task":
                task, rep = e["id"], None
                continue
            if e["type"] == "#rep":
                rep = e["rep"]
                continue
            if e["type"].startswith("#"):
                continue
            e["task"], e["rep"] = task, rep
            out.append(e)
    return out


def pct(xs, *ps):
    xs = sorted(xs)
    if not xs:
        return None
    return [xs[min(len(xs) - 1, int(p / 100 * len(xs)))] for p in ps]


def fmt(v):
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.3g}"
    if isinstance(v, list):
        return "/".join(fmt(x) for x in v)
    return str(v)


def frac(x):
    return x is not None and abs(x - round(x)) > 1e-6


def top(counter, n=3):
    total = sum(counter.values())
    if not total:
        return None
    return ", ".join(f"{k} {100 * c / total:.0f}%" for k, c in counter.most_common(n))


def metrics(ev):
    m = {}
    by_task = collections.defaultdict(list)
    for e in ev:
        by_task[e["task"]].append(e)

    # ---- pointer -------------------------------------------------------------
    moves = [e for e in ev if e["type"] == "pointermove" and e["task"] in ("wander", "targets")]
    mm = [e for e in ev if e["type"] == "mousemove" and e["task"] in ("wander", "targets")]
    gaps = [b["t"] - a["t"] for a, b in zip(moves, moves[1:]) if 0 < b["t"] - a["t"] < 100]
    m["pointermove gap ms p10/50/90"] = pct(gaps, 10, 50, 90)
    m["coalesced per pointermove p50/90"] = pct([len(e.get("coalesced") or []) for e in moves], 50, 90)
    m["pointermove fractional clientX %"] = 100 * sum(frac(e.get("clientX")) for e in moves) / len(moves) if moves else None
    m["mousemove fractional clientX %"] = 100 * sum(frac(e.get("clientX")) for e in mm) / len(mm) if mm else None
    steps = [abs(e.get("movementX") or 0) + abs(e.get("movementY") or 0) for e in mm]
    m["mousemove |dx|+|dy| px p50/90/99"] = pct(steps, 50, 90, 99)
    m["mousemove with zero movement %"] = 100 * sum(s == 0 for s in steps) / len(steps) if steps else None
    m["pointermoves per mousemove"] = len(moves) / len(mm) if mm else None
    for field in ("pointerType", "width", "height", "ppressure", "inputSource", "pressure", "buttons", "twist", "altitude"):
        m[f"pointermove {field}"] = top(collections.Counter(str(e.get(field)) for e in moves))
    m["mousemove screenX-clientX const"] = (
        len({round(e["screenX"] - e["clientX"], 3) for e in mm}) == 1 if mm else None)

    # Movement episodes: runs of mousemove separated by > 150 ms of stillness.
    durs, dists, peak = [], [], []
    run = []
    for e in mm + [None]:
        if run and (e is None or e["t"] - run[-1]["t"] > 150):
            if len(run) > 3:
                d = sum(abs(a.get("movementX") or 0) + abs(a.get("movementY") or 0) for a in run)
                durs.append(run[-1]["t"] - run[0]["t"])
                dists.append(d)
                v = [((b["clientX"] - a["clientX"]) ** 2 + (b["clientY"] - a["clientY"]) ** 2) ** 0.5 / max(b["t"] - a["t"], 1)
                     for a, b in zip(run, run[1:])]
                peak.append(max(v))
            run = []
        if e is not None:
            run.append(e)
    m["move episode ms p10/50/90"] = pct(durs, 10, 50, 90)
    m["move episode path px p50"] = pct(dists, 50)
    m["move peak speed px/ms p50"] = pct(peak, 50)

    # ---- clicks ----------------------------------------------------------------
    holds, pre, slip, orders, between = [], [], [], collections.Counter(), []
    last_click = None
    for task in CLICK_TASKS:
        es = by_task.get(task, [])
        for i, e in enumerate(es):
            if e["type"] != "pointerdown" or e.get("button") != 0:
                continue
            up = next((u for u in es[i:] if u["type"] == "pointerup"), None)
            if up:
                holds.append(up["t"] - e["t"])
                slip.append(abs(up["clientX"] - e["clientX"]) + abs(up["clientY"] - e["clientY"]))
            mv = next((p for p in reversed(es[:i]) if p["type"] == "pointermove"), None)
            if mv:
                pre.append(e["t"] - mv["t"])
            seq = []
            for f in es[i:i + 40]:
                if f["type"] in MOVE_NOISE:
                    continue
                seq.append(f["type"])
                if f["type"] == "click":
                    break
            orders[",".join(seq)] += 1
    for e in by_task.get("rapid-click", []):
        if e["type"] == "pointerdown":
            if last_click is not None:
                between.append(e["t"] - last_click)
            last_click = e["t"]
    m["click hold ms p10/50/90"] = pct(holds, 10, 50, 90)
    m["rapid-click down-to-down ms p50"] = pct(between, 50)
    m["last move -> pointerdown ms p50"] = pct(pre, 50)
    m["movement down->up px p50/90"] = pct(slip, 50, 90)
    m["click order (top)"] = top(orders, 2)

    other = collections.Counter()
    for task, btn in (("right-click", 2), ("middle-click", 1)):
        for i, e in enumerate(by_task.get(task, [])):
            if e["type"] == "pointerdown" and e.get("button") == btn:
                seq = [f["type"] for f in by_task[task][i:i + 30] if f["type"] not in MOVE_NOISE]
                cut = "contextmenu" if btn == 2 else "auxclick"
                other[f"{task}: " + ",".join(seq[: seq.index(cut) + 1] if cut in seq else seq[:6])] += 1
    for k, v in other.most_common(2):
        m[f"order {k.split(':')[0]}"] = k.split(": ", 1)[1]

    # ---- wheel -----------------------------------------------------------------
    for task in ("notch-down", "notch-nested", "wheel-burst", "wheel-spin", "wheel-horizontal"):
        ws = [e for e in by_task.get(task, []) if e["type"] == "wheel"]
        if not ws:
            continue
        reps = collections.defaultdict(list)
        for e in ws:
            reps[e["rep"]].append(e)
        m[f"{task}: wheel events per rep p50"] = pct([len(v) for v in reps.values()], 50)
        m[f"{task}: deltaMode"] = top(collections.Counter(e.get("deltaMode") for e in ws), 2)
        key = "deltaX" if task == "wheel-horizontal" else "deltaY"
        m[f"{task}: |{key}| p50/max"] = (lambda v: v and [v[0], max(abs(e.get(key) or 0) for e in ws)])(
            pct([abs(e.get(key) or 0) for e in ws], 50))
        m[f"{task}: wheelDelta/delta"] = top(collections.Counter(
            round((e.get("wheelDeltaY") if key == "deltaY" else e.get("wheelDeltaX")) / -e[key], 1) if e.get(key) else None
            for e in ws), 2)
        g = [b["t"] - a["t"] for v in reps.values() for a, b in zip(v, v[1:])]
        m[f"{task}: gap ms p10/50/90"] = pct(g, 10, 50, 90)
        legacy = [e for e in by_task[task] if e["type"] in ("DOMMouseScroll", "MozMousePixelScroll")]
        m[f"{task}: legacy events per wheel"] = len(legacy) / len(ws)
        if task == "wheel-horizontal":
            m[f"{task}: shiftKey on wheel %"] = 100 * sum(bool(e.get("shift")) for e in ws) / len(ws)

    # ---- keyboard --------------------------------------------------------------
    holds, gaps, orders = [], [], collections.Counter()
    fields = collections.Counter()
    for task in TYPE_TASKS:
        es = by_task.get(task, [])
        downs = [e for e in es if e["type"] == "keydown" and not e.get("repeat")]
        for i, e in enumerate(es):
            if e["type"] != "keydown" or e.get("repeat"):
                continue
            up = next((u for u in es[i:] if u["type"] == "keyup" and u.get("code") == e.get("code")), None)
            if up:
                holds.append(up["t"] - e["t"])
            if len(e.get("key", "")) == 1 and e["key"].isalpha() and e["key"].islower():
                seq = []
                for f in es[i:i + 12]:
                    if f["type"] in ("keydown",) and f is not e:
                        break
                    if f["type"] in ("keydown", "keypress", "beforeinput", "input", "selectionchange", "keyup") and (
                            f["type"] not in ("keyup",) or f.get("code") == e.get("code")):
                        seq.append(f["type"])
                orders[",".join(seq)] += 1
                fields[(e.get("location"), e.get("keyCode") == ord(e["key"].upper()), e.get("charCode"), e.get("which"))] += 1
        gaps += [b["t"] - a["t"] for a, b in zip(downs, downs[1:]) if b["t"] - a["t"] < 2000]
    m["key hold ms p10/50/90"] = pct(holds, 10, 50, 90)
    m["keydown gap ms p10/50/90"] = pct(gaps, 10, 50, 90)
    m["key order, lowercase letter (top)"] = top(orders, 2)
    m["keydown (location, keyCode ok, charCode, which)"] = top(fields, 2)
    shifts = [e for t in TYPE_TASKS for e in by_task.get(t, []) if e["type"] == "keydown" and e.get("key") == "Shift" and not e.get("repeat")]
    caps = [e for t in TYPE_TASKS for e in by_task.get(t, []) if e["type"] == "keydown" and len(e.get("key", "")) == 1 and e["key"].isupper()]
    m["Shift keydowns per capital"] = len(shifts) / len(caps) if caps else None
    m["Shift location"] = top(collections.Counter(e.get("location") for e in shifts), 2)
    rolled = 0
    total = 0
    for task in TYPE_TASKS:
        es = by_task.get(task, [])
        held = set()
        for e in es:
            if e["type"] == "keydown" and not e.get("repeat") and e.get("key") != "Shift":
                total += 1
                rolled += bool(held - {"ShiftLeft", "ShiftRight"})
                held.add(e.get("code"))
            elif e["type"] == "keyup":
                held.discard(e.get("code"))
    m["keydowns with another key held %"] = 100 * rolled / total if total else None

    # ---- whole-run grammar -------------------------------------------------------
    types = collections.Counter(e["type"] for e in ev)
    m["event types seen"] = len(types)
    m["isTrusted false %"] = 100 * sum(not e.get("trusted", True) for e in ev) / len(ev) if ev else None
    return m, set(types)


def main():
    dirs = [Path(a) for a in sys.argv[1:]]
    results = [metrics(load(d)) for d in dirs]
    names = [d.name for d in dirs]
    keys = list(dict.fromkeys(k for r, _ in results for k in r))
    w = max(len(k) for k in keys) + 2
    cols = [max(len(n), 14) for n in names]
    print("".ljust(w) + "  ".join(n.ljust(c) for n, c in zip(names, cols)))
    for k in keys:
        cells = [fmt(r.get(k)) for r, _ in results]
        cols = [max(c, len(x)) for c, x in zip(cols, cells)]
        print(k.ljust(w) + "  ".join(x.ljust(c) for x, c in zip(cells, cols)))
    if len(results) > 1:
        ref = results[0][1]
        for name, (_, seen) in zip(names[1:], results[1:]):
            print(f"\n{name}: types {names[0]} has and it lacks: {sorted(ref - seen)}")
            print(f"{name}: types it has and {names[0]} lacks: {sorted(seen - ref)}")


if __name__ == "__main__":
    main()
