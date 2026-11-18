import { VIEWPORT_PADDING } from './geometry.js'
import type { BoundingBox } from './math.js'

/** One pass of the container-aware scroll planner (see SCROLL_PLAN_JS). */
export interface ScrollPlan {
  /** Target's click region is on-screen, inside the clear band, and unoccluded. */
  inView: boolean
  /** Wheel delta for the chosen scroller this pass; 0 when nothing can move the target. */
  deltaY: number
  hoverX: number
  hoverY: number
  /** The chosen scroller is the page (drives wheel-multiplier calibration). */
  isPage: boolean
  /**
   * Visible, clickable clip of the target: element rect ∩ ancestor scroller
   * rects ∩ pinned-bar clear band. Null when nothing usable is on-screen —
   * callers must NOT move toward the element in that case (that is the
   * edge-riding failure mode this exists to prevent).
   */
  region: BoundingBox | null
  /** The target's border box. */
  box: BoundingBox
  /** The target's left and top border widths, which Playwright's `position` is offset by. */
  borders: [number, number]
}

/** Where the scroll planner puts the target: 0 top, 0.5 middle, 1 bottom of the clear band. */
export const SCROLL_FINISH_POSITION = 0.5
/** Top and bottom margin (px) of the band the target is scrolled into. */
export const SCROLL_PAD = Math.max(20, VIEWPORT_PADDING + 5)
/** Left and right margin (px) of the region the cursor may land in. */
export const SCROLL_EDGE = VIEWPORT_PADDING

export interface ScrollPlanArgs {
  finishPosition: number
  pad: number
  edge: number
  /** Where the cursor is now: the hover point is chosen near it. */
  fromX: number
  fromY: number
}

/**
 * Container-aware scroll plan. One pass computes:
 *
 *  - the CLEAR BAND: the viewport minus pinned (fixed/sticky) top/bottom bars,
 *    probed at the target's column — a target behind a sticky action footer is
 *    only reachable inside this band, so all positioning targets it rather
 *    than raw viewport fractions (finishPosition·vh lands exactly on a 50vh
 *    footer's edge);
 *  - the CHOSEN SCROLLER: the innermost scrollable ancestor that can actually
 *    MOVE the target toward finishPosition inside its own visible band. An
 *    exhausted scroller (a top-anchored first option in a list already at
 *    scrollTop 0) yields delta 0 and we ESCALATE to the next ancestor up the
 *    chain, ending at the page. A position:fixed ancestor caps the chain:
 *    window scroll cannot move anything inside it, so such targets are only
 *    ever revealed by scrolling their own containers (via wheel over them);
 *  - the CLICK REGION: the target's on-screen clip (element ∩ scroller rects
 *    ∩ clear band), with occlusion judged across the region — not just the
 *    center point, which passed for targets straddling a footer edge.
 *
 * Self-contained so it can be serialized into the page: pass it to an
 * `evaluate` with the target element, e.g. Playwright's
 * `handle.evaluate(SCROLL_PLAN_JS, args)`. Null when the element is not visible.
 */
export const SCROLL_PLAN_JS = (el: HTMLElement, arg: ScrollPlanArgs): ScrollPlan | null => {
  // Offset of a node's document viewport in top-page coordinates: mouse
  // input is page-level, so every rect from inside a same-origin iframe
  // is translated before any band/clip math.
  const frameOffset = (node: Element): { x: number; y: number } => {
    let x = 0
    let y = 0
    let win = node.ownerDocument ? node.ownerDocument.defaultView : null
    while (win && win !== window && win.frameElement) {
      const fe = win.frameElement as HTMLElement
      const fr = fe.getBoundingClientRect()
      x += fr.x + fe.clientLeft
      y += fr.y + fe.clientTop
      win = win.parent as Window & typeof globalThis
    }
    return { x, y }
  }
  type Rect = { x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number }
  const rectOf = (node: Element): Rect => {
    const r = node.getBoundingClientRect()
    const o = frameOffset(node)
    return {
      x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height,
      top: r.top + o.y, bottom: r.bottom + o.y, left: r.left + o.x, right: r.right + o.x,
    }
  }
  const styleOf = (node: Element): CSSStyleDeclaration =>
    ((node.ownerDocument && node.ownerDocument.defaultView) || window).getComputedStyle(node)
  // Is this node the root of a scrollable (i.e. window-scrolled) iframe doc?
  const isFrameDocRoot = (node: Element): boolean =>
    !!node.ownerDocument &&
    node === node.ownerDocument.documentElement &&
    node.ownerDocument.defaultView !== window
  // Walk up through shadow hosts AND same-origin frame boundaries.
  const stepUp = (node: Element): Element | null => {
    if (node.parentElement) return node.parentElement
    const r = node.getRootNode() as ShadowRoot | Document
    if ((r as ShadowRoot).host) return (r as ShadowRoot).host as Element
    try {
      return ((r as Document).defaultView?.frameElement as Element | null) ?? null
    } catch {
      return null
    }
  }
  const vh = window.innerHeight || document.documentElement.clientHeight
  const vw = window.innerWidth || document.documentElement.clientWidth
  const elRect = rectOf(el)
  const elStyle = styleOf(el)
  // Not visible, as Playwright defines it: nothing to scroll to or press.
  if (!(elRect.width > 0 && elRect.height > 0) || elStyle.visibility === 'hidden') return null

  // Every scrollable ancestor, innermost first. A position:fixed ancestor
  // is a hard barrier: neither the page nor anything above it can move the
  // target (fixed boxes don't move with window scroll), so the chain stops
  // there — but the fixed element itself may be the scroller (sticky-bar
  // form layouts), so it's tested for scrollability before the cut.
  const chain: HTMLElement[] = []
  let pageCanMoveTarget = true
  let cur = stepUp(el)
  let depth = 0
  while (cur && depth < 60 && cur !== document.documentElement) {
    if (isFrameDocRoot(cur)) {
      // An iframe's document scrolls through its own window — a page-step
      // scoped to the frame. Continue past it into the host document.
      const w = cur.ownerDocument.defaultView!
      if (cur.scrollHeight > w.innerHeight + 1) chain.push(cur as HTMLElement)
      cur = stepUp(cur)
      depth++
      continue
    }
    const st = styleOf(cur)
    const scrollable =
      cur.scrollHeight > cur.clientHeight + 1 &&
      (st.overflowY === 'scroll' || st.overflowY === 'auto')
    if (cur.ownerDocument && cur === cur.ownerDocument.body) {
      // body-as-scroller only matters when its document doesn't scroll.
      const docRoot = cur.ownerDocument.documentElement
      const docVh = cur.ownerDocument.defaultView?.innerHeight ?? vh
      if (scrollable && !(docRoot.scrollHeight > docVh + 10)) {
        chain.push(cur as HTMLElement)
      }
      if (cur === document.body) break
      cur = stepUp(cur)
      depth++
      continue
    }
    if (scrollable) chain.push(cur as HTMLElement)
    if (st.position === 'fixed') {
      // Fixed pins to its OWN frame's viewport. Only a top-document fixed
      // ancestor defeats the page-step — the host page still moves a whole
      // iframe. Inside a frame, skip to the frame element: nothing above
      // `cur` in this frame can move the target, but host scrollers can.
      if (cur.ownerDocument === document) {
        pageCanMoveTarget = false
        break
      }
      try {
        cur = (cur.ownerDocument.defaultView?.frameElement as Element | null) ?? null
      } catch {
        cur = null
      }
      depth++
      continue
    }
    cur = stepUp(cur)
    depth++
  }

  // Pinned occluder under a point: the nearest fixed/sticky ancestor of
  // whatever elementFromPoint hits there — unless it's the target itself,
  // one of its descendants, or one of its ancestors (a fixed scroll
  // container is the thing we scroll, not an occluder). Only pinned
  // occluders count: anything that scrolls WITH the target (open dropdown
  // layers, decorative wrappers) would re-occlude after every scroll and
  // wedge the retry loop into its timeout.
  // elementFromPoint that descends into same-origin iframes at the point,
  // translating into each frame's viewport coordinates as it goes.
  const hitAtPoint = (x: number, y: number): Element | null => {
    let hit = document.elementFromPoint(x, y)
    for (;;) {
      if (!hit || (hit.tagName !== 'IFRAME' && hit.tagName !== 'FRAME')) return hit
      let inner: Document | null = null
      try {
        inner = (hit as HTMLIFrameElement).contentDocument
      } catch {
        inner = null // cross-origin
      }
      if (!inner) return hit
      const fr = hit.getBoundingClientRect()
      x -= fr.x + (hit as HTMLElement).clientLeft
      y -= fr.y + (hit as HTMLElement).clientTop
      const next = inner.elementFromPoint(x, y)
      if (!next) return hit
      hit = next
    }
  }
  // `contains` across shadow and same-origin frame boundaries.
  const containsDeep = (ancestor: Element, node: Element | null): boolean => {
    let n: Element | null = node
    while (n) {
      if (n === ancestor) return true
      n = stepUp(n)
    }
    return false
  }
  const pinnedRectAt = (x: number, y: number): { top: number; bottom: number } | null => {
    const hit = hitAtPoint(x, y)
    if (!hit || hit === el || containsDeep(el, hit) || containsDeep(hit, el)) return null
    let n: Element | null = hit
    while (n && n !== document.body && n !== document.documentElement) {
      if (isFrameDocRoot(n) || (n.ownerDocument && n === n.ownerDocument.body)) {
        n = stepUp(n)
        continue
      }
      const pos = styleOf(n).position
      if (pos === 'fixed' || pos === 'sticky') {
        return containsDeep(n, el) ? null : rectOf(n)
      }
      n = stepUp(n)
    }
    return null
  }

  // Clear band: the viewport minus pinned bars, probed at the target's
  // column. Iterates a few levels for stacked bars (banner over header).
  let clearTop = arg.pad
  let clearBottom = vh - arg.pad
  const probeX = Math.min(Math.max(elRect.left + elRect.width / 2, 5), vw - 5)
  for (let i = 0; i < 4; i++) {
    const r = pinnedRectAt(probeX, clearTop + 1)
    if (r && r.bottom > clearTop) clearTop = Math.min(r.bottom + 2, vh)
    else break
  }
  for (let i = 0; i < 4; i++) {
    const r = pinnedRectAt(probeX, clearBottom - 1)
    if (r && r.top < clearBottom) clearBottom = Math.max(r.top - 2, 0)
    else break
  }
  if (clearBottom - clearTop < 40) {
    // Band collapsed (e.g. a full-screen fixed overlay): fall back to the
    // padded viewport so scroll math stays sane; the region occlusion
    // check below still reports the target unreachable if it truly is.
    clearTop = arg.pad
    clearBottom = vh - arg.pad
  }

  // Visible band of a chain scroller: for an iframe doc root that's the
  // frame ELEMENT's box (the content box is taller than the viewport).
  const scrollerRectOf = (c: Element): Rect => {
    if (isFrameDocRoot(c)) {
      try {
        const fe = c.ownerDocument.defaultView?.frameElement as Element | null
        if (fe) return rectOf(fe)
      } catch { /* cross-origin — fall through */ }
    }
    return rectOf(c)
  }
  // Click region: the target's on-screen clip. Element rect ∩ every
  // ancestor scroller's rect ∩ clear band ∩ viewport edges.
  let clipTop = clearTop
  let clipBottom = clearBottom
  let clipLeft = arg.edge
  let clipRight = vw - arg.edge
  for (const c of chain) {
    const cr = scrollerRectOf(c)
    clipTop = Math.max(clipTop, cr.top)
    clipBottom = Math.min(clipBottom, cr.bottom)
    clipLeft = Math.max(clipLeft, cr.left)
    clipRight = Math.min(clipRight, cr.right)
  }
  const regionLeft = Math.max(elRect.left, clipLeft)
  const regionTop = Math.max(elRect.top, clipTop)
  const regionRight = Math.min(elRect.right, clipRight)
  const regionBottom = Math.min(elRect.bottom, clipBottom)
  const region =
    regionRight - regionLeft >= 6 && regionBottom - regionTop >= 6
      ? {
          x: regionLeft,
          y: regionTop,
          width: regionRight - regionLeft,
          height: regionBottom - regionTop,
        }
      : null

  // Occlusion across the click region (center + 4 interior points), not
  // just the element center — a target straddling a footer edge has a
  // clear center but a covered click region.
  let occluded = false
  if (region) {
    const cx = region.x + region.width / 2
    const cy = region.y + region.height / 2
    const samples: Array<[number, number]> = [
      [cx, cy],
      [cx - region.width * 0.3, cy],
      [cx + region.width * 0.3, cy],
      [cx, cy - region.height * 0.3],
      [cx, cy + region.height * 0.3],
    ]
    occluded = samples.some(([px, py]) => pinnedRectAt(Math.round(px), Math.round(py)) != null)
  }

  const bandHeight = clipBottom - clipTop
  const fullyVisible = elRect.top >= clipTop && elRect.bottom <= clipBottom
  // A target taller than its band can never be fully contained; it's in
  // view once it fills most of the band.
  const tallTarget = elRect.height > bandHeight - 4
  const inView =
    region != null &&
    !occluded &&
    (fullyVisible || (tallTarget && region.height >= bandHeight * 0.6))

  // Chosen scroller: innermost ancestor whose scroll can actually MOVE the
  // target toward finishPosition inside ITS visible band (its rect ∩ outer
  // scroller rects ∩ clear band). delta 0 = exhausted (or already placed):
  // escalate to the next ancestor, ending at the page when permitted.
  let chosen: HTMLElement | null = null
  let chosenDelta = 0
  let chosenIsPage = false
  let hoverTop = clearTop
  let hoverBottom = clearBottom
  let hoverLeft = 5
  let hoverRight = vw - 5
  const steps = chain.length + (pageCanMoveTarget ? 1 : 0)
  for (let i = 0; i < steps; i++) {
    const isPageStep = i === chain.length
    const node = isPageStep ? (document.documentElement as HTMLElement) : chain[i]
    let bTop = clearTop
    let bBottom = clearBottom
    let bLeft = 5
    let bRight = vw - 5
    if (!isPageStep) {
      const r = scrollerRectOf(node)
      bTop = Math.max(bTop, r.top)
      bBottom = Math.min(bBottom, r.bottom)
      bLeft = Math.max(bLeft, r.left)
      bRight = Math.min(bRight, r.right)
      for (let j = i + 1; j < chain.length; j++) {
        const outer = scrollerRectOf(chain[j])
        bTop = Math.max(bTop, outer.top)
        bBottom = Math.min(bBottom, outer.bottom)
        bLeft = Math.max(bLeft, outer.left)
        bRight = Math.min(bRight, outer.right)
      }
    }
    const bH = bBottom - bTop
    // A band too small to ever show the target can't help — skip outward.
    if (bH < Math.min(elRect.height, 24) + 6) continue
    const desiredTop = bTop + Math.max(0, bH - elRect.height) * arg.finishPosition
    // An iframe doc root scrolls through its own window (Gecko reports
    // scrollTop 0 on document roots).
    const frameWin = isFrameDocRoot(node) ? node.ownerDocument.defaultView! : null
    const current = isPageStep ? window.scrollY : frameWin ? frameWin.scrollY : node.scrollTop
    const maxScroll = isPageStep
      ? Math.max(0, document.documentElement.scrollHeight - vh)
      : frameWin
        ? Math.max(0, node.scrollHeight - frameWin.innerHeight)
        : Math.max(0, node.scrollHeight - node.clientHeight)
    const target = Math.max(0, Math.min(current + (elRect.top - desiredTop), maxScroll))
    const delta = target - current
    if (Math.abs(delta) >= 1) {
      chosen = node
      chosenDelta = delta
      chosenIsPage = isPageStep
      hoverTop = bTop
      hoverBottom = bBottom
      hoverLeft = bLeft
      hoverRight = bRight
      break
    }
  }

  // Hover: the NEAREST point to the cursor from which a wheel actually
  // reaches the chosen scroller. Humans scroll from wherever the mouse
  // sits and nudge toward a gutter when an inner scroller (open dropdown
  // list, overflowing textarea) would swallow the wheel — so probe small
  // lateral offsets first, then small vertical ones. For a container the
  // walk up from the hit must MEET the scroller: a point over a fixed
  // footer never scrolls the container behind it. The hover stays inside
  // the scroller's visible band ∩ clear band, never over a pinned bar.
  const clampHX = (x: number) =>
    Math.min(Math.max(x, Math.max(hoverLeft + 5, 5)), Math.min(hoverRight - 5, vw - 5))
  const clampHY = (y: number) =>
    Math.min(Math.max(y, Math.max(hoverTop + 5, 5)), Math.min(hoverBottom - 5, vh - 5))
  // Wheel routing matches Chromium: a wheel is consumed by the nearest
  // scrollable ancestor that can still MOVE in the wheel's direction, and
  // bubbles past one already at its limit. Treating every overflow:auto
  // wrapper as a trap (the old probe) nudged the cursor sideways on
  // layouts full of decorative scroll wrappers even though the wheel
  // would have landed fine where it sat.
  const consumesWheel = (n: Element): boolean => {
    if (isFrameDocRoot(n)) {
      // A wheel over a scrollable iframe doc is consumed by the frame's
      // window until it hits its limit, then bubbles to the host.
      const w = n.ownerDocument.defaultView!
      return chosenDelta > 0
        ? w.scrollY + w.innerHeight < n.scrollHeight - 1
        : w.scrollY > 1
    }
    const st = styleOf(n)
    if (st.overflowY !== 'auto' && st.overflowY !== 'scroll') return false
    if (n.scrollHeight <= n.clientHeight + 1) return false
    return chosenDelta > 0
      ? n.scrollTop + n.clientHeight < n.scrollHeight - 1
      : n.scrollTop > 1
  }
  const wheelReaches = (x: number, y: number): boolean => {
    const hit = hitAtPoint(x, y)
    if (!hit) return chosenIsPage
    let n: Element | null = hit
    while (n && n !== document.documentElement && n !== document.body) {
      if (!chosenIsPage && n === chosen) return true
      if (consumesWheel(n)) return false
      n = stepUp(n)
    }
    return chosenIsPage
  }
  let hoverX = clampHX(arg.fromX)
  let hoverY = clampHY(arg.fromY)
  if (chosen) {
    // Equal-distance probes break toward the side with more gutter room,
    // so asymmetric layouts don't accumulate a systematic drift from a
    // fixed left-first order.
    const roomLeft = arg.fromX - Math.max(hoverLeft + 5, 5)
    const roomRight = Math.min(hoverRight - 5, vw - 5) - arg.fromX
    const lateral =
      roomRight > roomLeft
        ? [0, 60, -60, 120, -120, 200, -200]
        : [0, -60, 60, -120, 120, -200, 200]
    const baseY = hoverY
    probe: for (const dy of [0, -40, 40, -90, 90]) {
      const y = clampHY(baseY + dy)
      for (const dx of lateral) {
        const x = clampHX(arg.fromX + dx)
        if (wheelReaches(x, y)) {
          hoverX = x
          hoverY = y
          break probe
        }
      }
    }
  }
  return {
    inView,
    deltaY: chosenDelta,
    hoverX,
    hoverY,
    isPage: chosenIsPage,
    region,
    box: { x: elRect.x, y: elRect.y, width: elRect.width, height: elRect.height },
    borders: [parseInt(elStyle.borderLeftWidth, 10), parseInt(elStyle.borderTopWidth, 10)],
  }
}
