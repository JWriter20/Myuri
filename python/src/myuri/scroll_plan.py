"""The in-page scroll planner (mirror of ``js/src/scroll-plan.ts``).

``SCROLL_PLAN_JS`` is a page function ``(el, arg) => plan | None`` taking the
target element and ``{finishPosition, pad, edge, fromX, fromY}``; run it with
the ``SCROLL_*`` defaults the Cursor uses.
"""
from __future__ import annotations

from .geometry import VIEWPORT_PADDING
from .page import _RESOLVER

SCROLL_FINISH_POSITION = 0.5
"""Where the planner puts the target: 0 top, 0.5 middle, 1 bottom of the clear band."""
SCROLL_PAD = max(20, VIEWPORT_PADDING + 5)
"""Top and bottom margin (px) of the band the target is scrolled into."""
SCROLL_EDGE = VIEWPORT_PADDING
"""Left and right margin (px) of the region the cursor may land in."""

# Container-aware scroll plan (mirror of ``SCROLL_PLAN_JS`` in js/src/scroll-plan.ts;
# see it for the full design commentary). One pass computes:
#   - the CLEAR BAND: viewport minus pinned (fixed/sticky) bars, probed at the
#     target's column;
#   - the CHOSEN SCROLLER: innermost scrollable ancestor that can actually move
#     the target toward finishPosition inside its visible band, escalating
#     outward past exhausted scrollers; a position:fixed ancestor drops the page
#     step entirely (window scroll cannot move anything inside it);
#   - the CLICK REGION: the target's on-screen clip, with occlusion judged
#     across the region rather than the center point;
#   - the HOVER point: nearest point from which a wheel reaches the chosen
#     scroller, modeling Chromium's routing (a wrapper at its scroll limit in
#     the wheel's direction bubbles the wheel up, so it is not a trap), with
#     equal-distance probes breaking toward the roomier gutter.
SCROLL_PLAN_JS = """(el, arg) => {
  function stepUp(node){
    if (node.parentElement) return node.parentElement;
    var r = node.getRootNode ? node.getRootNode() : null;
    return r && r.host ? r.host : null;
  }
  var vh = window.innerHeight || document.documentElement.clientHeight;
  var vw = window.innerWidth || document.documentElement.clientWidth;
  var elRect = el.getBoundingClientRect();

  var chain = [];
  var pageCanMoveTarget = true;
  var cur = stepUp(el);
  var depth = 0;
  while (cur && depth < 60 && cur !== document.documentElement) {
    var st = getComputedStyle(cur);
    var scrollable = cur.scrollHeight > cur.clientHeight + 1 &&
      (st.overflowY === 'scroll' || st.overflowY === 'auto');
    if (cur === document.body) {
      if (scrollable && !(document.documentElement.scrollHeight > vh + 10)) chain.push(cur);
      break;
    }
    if (scrollable) chain.push(cur);
    if (st.position === 'fixed') { pageCanMoveTarget = false; break; }
    cur = stepUp(cur);
    depth++;
  }

  function pinnedRectAt(x, y) {
    var hit = document.elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
    var n = hit;
    while (n && n !== document.body && n !== document.documentElement) {
      var pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return n.contains(el) ? null : n.getBoundingClientRect();
      n = stepUp(n);
    }
    return null;
  }

  var clearTop = arg.pad;
  var clearBottom = vh - arg.pad;
  var probeX = Math.min(Math.max(elRect.left + elRect.width / 2, 5), vw - 5);
  var i, r;
  for (i = 0; i < 4; i++) {
    r = pinnedRectAt(probeX, clearTop + 1);
    if (r && r.bottom > clearTop) clearTop = Math.min(r.bottom + 2, vh); else break;
  }
  for (i = 0; i < 4; i++) {
    r = pinnedRectAt(probeX, clearBottom - 1);
    if (r && r.top < clearBottom) clearBottom = Math.max(r.top - 2, 0); else break;
  }
  if (clearBottom - clearTop < 40) { clearTop = arg.pad; clearBottom = vh - arg.pad; }

  var clipTop = clearTop, clipBottom = clearBottom, clipLeft = arg.edge, clipRight = vw - arg.edge;
  var cr;
  for (i = 0; i < chain.length; i++) {
    cr = chain[i].getBoundingClientRect();
    clipTop = Math.max(clipTop, cr.top); clipBottom = Math.min(clipBottom, cr.bottom);
    clipLeft = Math.max(clipLeft, cr.left); clipRight = Math.min(clipRight, cr.right);
  }
  var regionLeft = Math.max(elRect.left, clipLeft);
  var regionTop = Math.max(elRect.top, clipTop);
  var regionRight = Math.min(elRect.right, clipRight);
  var regionBottom = Math.min(elRect.bottom, clipBottom);
  var region = (regionRight - regionLeft >= 6 && regionBottom - regionTop >= 6)
    ? { x: regionLeft, y: regionTop, width: regionRight - regionLeft, height: regionBottom - regionTop }
    : null;

  var occluded = false;
  if (region) {
    var ccx = region.x + region.width / 2, ccy = region.y + region.height / 2;
    var samples = [
      [ccx, ccy],
      [ccx - region.width * 0.3, ccy], [ccx + region.width * 0.3, ccy],
      [ccx, ccy - region.height * 0.3], [ccx, ccy + region.height * 0.3]
    ];
    for (i = 0; i < samples.length; i++) {
      if (pinnedRectAt(Math.round(samples[i][0]), Math.round(samples[i][1])) != null) { occluded = true; break; }
    }
  }

  var bandHeight = clipBottom - clipTop;
  var fullyVisible = elRect.top >= clipTop && elRect.bottom <= clipBottom;
  var tallTarget = elRect.height > bandHeight - 4;
  var inView = region != null && !occluded &&
    (fullyVisible || (tallTarget && region.height >= bandHeight * 0.6));

  var chosen = null, chosenDelta = 0, chosenIsPage = false;
  var hoverTop = clearTop, hoverBottom = clearBottom, hoverLeft = 5, hoverRight = vw - 5;
  var steps = chain.length + (pageCanMoveTarget ? 1 : 0);
  for (i = 0; i < steps; i++) {
    var isPageStep = i === chain.length;
    var node = isPageStep ? document.documentElement : chain[i];
    var bTop = clearTop, bBottom = clearBottom, bLeft = 5, bRight = vw - 5;
    if (!isPageStep) {
      var nr = node.getBoundingClientRect();
      bTop = Math.max(bTop, nr.top); bBottom = Math.min(bBottom, nr.bottom);
      bLeft = Math.max(bLeft, nr.left); bRight = Math.min(bRight, nr.right);
      for (var j = i + 1; j < chain.length; j++) {
        var outer = chain[j].getBoundingClientRect();
        bTop = Math.max(bTop, outer.top); bBottom = Math.min(bBottom, outer.bottom);
        bLeft = Math.max(bLeft, outer.left); bRight = Math.min(bRight, outer.right);
      }
    }
    var bH = bBottom - bTop;
    if (bH < Math.min(elRect.height, 24) + 6) continue;
    var desiredTop = bTop + Math.max(0, bH - elRect.height) * arg.finishPosition;
    var current = isPageStep ? window.scrollY : node.scrollTop;
    var maxScroll = isPageStep
      ? Math.max(0, document.documentElement.scrollHeight - vh)
      : Math.max(0, node.scrollHeight - node.clientHeight);
    var target = Math.max(0, Math.min(current + (elRect.top - desiredTop), maxScroll));
    var delta = target - current;
    if (Math.abs(delta) >= 1) {
      chosen = node; chosenDelta = delta; chosenIsPage = isPageStep;
      hoverTop = bTop; hoverBottom = bBottom; hoverLeft = bLeft; hoverRight = bRight;
      break;
    }
  }

  function clampHX(x){ return Math.min(Math.max(x, Math.max(hoverLeft + 5, 5)), Math.min(hoverRight - 5, vw - 5)); }
  function clampHY(y){ return Math.min(Math.max(y, Math.max(hoverTop + 5, 5)), Math.min(hoverBottom - 5, vh - 5)); }
  function consumesWheel(n){
    var st = getComputedStyle(n);
    if (st.overflowY !== 'auto' && st.overflowY !== 'scroll') return false;
    if (n.scrollHeight <= n.clientHeight + 1) return false;
    return chosenDelta > 0
      ? n.scrollTop + n.clientHeight < n.scrollHeight - 1
      : n.scrollTop > 1;
  }
  function wheelReaches(x, y){
    var hit = document.elementFromPoint(x, y);
    if (!hit) return chosenIsPage;
    var n = hit;
    while (n && n !== document.documentElement && n !== document.body) {
      if (!chosenIsPage && n === chosen) return true;
      if (consumesWheel(n)) return false;
      n = stepUp(n);
    }
    return chosenIsPage;
  }
  var hoverX = clampHX(arg.fromX);
  var hoverY = clampHY(arg.fromY);
  if (chosen) {
    var roomLeft = arg.fromX - Math.max(hoverLeft + 5, 5);
    var roomRight = Math.min(hoverRight - 5, vw - 5) - arg.fromX;
    var lateral = roomRight > roomLeft
      ? [0, 60, -60, 120, -120, 200, -200]
      : [0, -60, 60, -120, 120, -200, 200];
    var dys = [0, -40, 40, -90, 90];
    var baseY = hoverY;
    var found = false;
    for (var a = 0; a < dys.length && !found; a++) {
      var y = clampHY(baseY + dys[a]);
      for (var b = 0; b < lateral.length; b++) {
        var x = clampHX(arg.fromX + lateral[b]);
        if (wheelReaches(x, y)) { hoverX = x; hoverY = y; found = true; break; }
      }
    }
  }
  return { inView: inView, deltaY: chosenDelta, hoverX: hoverX, hoverY: hoverY, isPage: chosenIsPage, region: region };
}"""

# The planner for the element a selector resolves to (open shadow roots and
# same-origin iframes included), as the Cursor runs it.
SCROLL_PLAN_FOR_SELECTOR = (
    "(arg) => {" + _RESOLVER + "\n  var el = resolve(arg.selector);\n  return el ? (" + SCROLL_PLAN_JS + ")(el, arg) : null;\n}"
)
