"""Driver-agnostic DOM query layer for Python.

Mirrors the TS ``page.ts``: every geometry read runs a self-contained JS
arrow-function (as a source string) via ``driver.evaluate``. Selector resolution
(CSS, shadow-piercing, XPath) happens inside the page, so no driver-specific
selector engine is needed. The resolver is a plain nested function (no ``eval``),
so it works under strict page CSP.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

from .drivers.base import Driver
from .types import BoundingBox, Vector, ViewportSize

# In-page selector resolver, embedded into each query payload.
_RESOLVER = """
  function resolve(s){
    if(s==null) return null;
    if(s.indexOf('xpath=')===0||s[0]==='/'||s[0]==='('){
      var expr=s.indexOf('xpath=')===0?s.slice(6):s;
      try{return document.evaluate(expr,document,null,9,null).singleNodeValue;}catch(e){return null;}
    }
    var direct=document.querySelector(s); if(direct) return direct;
    var stack=[document];
    while(stack.length){
      var root=stack.pop();
      var f=root.querySelector(s); if(f) return f;
      var all=root.querySelectorAll('*');
      for(var i=0;i<all.length;i++){ if(all[i].shadowRoot) stack.push(all[i].shadowRoot); }
    }
    return null;
  }
"""

_VIEWPORT_JS = (
    "() => ({width: window.innerWidth || document.documentElement.clientWidth,"
    " height: window.innerHeight || document.documentElement.clientHeight})"
)

_BOUNDING_BOX_JS = (
    "(sel) => {" + _RESOLVER + "var el=resolve(sel); if(!el) return null;"
    " var r=el.getBoundingClientRect();"
    " if(r.width===0 && r.height===0) return null;"
    " return {x:r.x,y:r.y,width:r.width,height:r.height};}"
)

_SCROLL_METRICS_JS = (
    "(sel) => {" + _RESOLVER
    + "if(!sel){var d=document.documentElement;"
    " return {offset: window.scrollY, maxOffset: Math.max(0,(d.scrollHeight||0)-window.innerHeight)};}"
    " var el=resolve(sel); if(!el) return {offset:-1,maxOffset:-1};"
    " return {offset: el.scrollTop, maxOffset: Math.max(0, el.scrollHeight-el.clientHeight)};}"
)

_WAIT_JS = (
    "(arg) => {" + _RESOLVER + "var el=resolve(arg.selector); if(!el) return false;"
    " if(!arg.requireVisible) return true;"
    " var r=el.getBoundingClientRect(); return r.width>0 && r.height>0;}"
)

_POINT_HITS_JS = (
    "(arg) => {" + _RESOLVER
    + "function deepFromPoint(x,y){var root=document; var el=root.elementFromPoint(x,y);"
    "   while(el && el.shadowRoot){var inner=el.shadowRoot.elementFromPoint(x,y);"
    "     if(!inner||inner===el) break; el=inner;} return el;}"
    " function containsDeep(anc,node){var cur=node; while(cur){ if(cur===anc) return true;"
    "   cur = cur.assignedSlot || cur.parentNode || cur.host || null;} return false;}"
    " var target=resolve(arg.selector); if(!target) return true;"
    " var hit=deepFromPoint(arg.x,arg.y); if(!hit) return false;"
    " return hit===target || containsDeep(target,hit) || containsDeep(hit,target);}"
)


@dataclass(frozen=True)
class ScrollMetrics:
    offset: float
    max_offset: float


async def viewport_of(driver: Driver) -> ViewportSize:
    vp = await driver.evaluate(_VIEWPORT_JS, None)
    if not vp or not vp.get("width") or not vp.get("height"):
        raise RuntimeError("myuri: could not read viewport size")
    return ViewportSize(width=vp["width"], height=vp["height"])


async def bounding_box_of(driver: Driver, selector: str) -> Optional[BoundingBox]:
    box = await driver.evaluate(_BOUNDING_BOX_JS, selector)
    if box is None:
        return None
    return BoundingBox(x=box["x"], y=box["y"], width=box["width"], height=box["height"])


async def scroll_metrics_of(driver: Driver, container_selector: Optional[str] = None) -> ScrollMetrics:
    m = await driver.evaluate(_SCROLL_METRICS_JS, container_selector)
    return ScrollMetrics(offset=m["offset"], max_offset=m["maxOffset"])


async def wait_for_element(
    driver: Driver, selector: str, state: str = "visible", timeout: float = 10000.0
) -> bool:
    require_visible = state == "visible"
    deadline = time.monotonic() + timeout / 1000.0
    while True:
        if driver.is_closed():
            return False
        ok = await driver.evaluate(_WAIT_JS, {"selector": selector, "requireVisible": require_visible})
        if ok:
            return True
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.05)


async def point_hits_target(driver: Driver, point: Vector, selector: str) -> bool:
    return await driver.evaluate(_POINT_HITS_JS, {"selector": selector, "x": point.x, "y": point.y})
