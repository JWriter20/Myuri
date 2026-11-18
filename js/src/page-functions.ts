import type { BoundingBox, Vector } from './math.js'

/**
 * The functions the smart actions run in the page (actions.ts). They are
 * self-contained, so each can be serialized into an `evaluate`; the Python
 * package runs the same source, from page_functions.json (scripts/page-functions.mjs).
 * Coordinates are in the viewport of the window that runs them.
 */

/**
 * The element a selector names: CSS (through open shadow roots), `xpath=` or
 * a bare XPath, `a >> b` to descend into a's shadow root and `a >>> b` into
 * a's same-origin iframe. Null when nothing matches.
 */
export const RESOLVE_SELECTOR_JS = (selector: string): Element | null => {
  function resolve(s: string): Element | null {
    // `a >> b`: descend into a's shadow root; `a >>> b`: descend into a's
    // same-origin iframe document.
    if (s.includes('>>')) {
      const tokens = s.split(/\s*(>>>|>>)\s*/).filter(Boolean)
      let root: Document | ShadowRoot | Element = document
      let el: Element | null = null
      let hop = ''
      for (const t of tokens) {
        if (t === '>>' || t === '>>>') {
          hop = t
          continue
        }
        if (el) {
          if (hop === '>>>') {
            let doc: Document | null = null
            try {
              doc = (el as HTMLIFrameElement).contentDocument
            } catch {
              doc = null // cross-origin
            }
            if (!doc) return null
            root = doc
          } else {
            root = (el as Element).shadowRoot || (el as Element)
          }
        }
        el = (root as ParentNode).querySelector(t)
        if (!el) return null
      }
      return el
    }
    if (s.indexOf('xpath=') === 0 || s[0] === '/' || s[0] === '(') {
      const expr = s.indexOf('xpath=') === 0 ? s.slice(6) : s
      try {
        return document.evaluate(expr, document, null, 9, null).singleNodeValue as Element | null
      } catch {
        return null
      }
    }
    const direct = document.querySelector(s)
    if (direct) return direct
    const stack: Array<Document | ShadowRoot> = [document]
    while (stack.length) {
      const root = stack.pop() as Document | ShadowRoot
      const found = root.querySelector(s)
      if (found) return found
      root.querySelectorAll('*').forEach((e) => {
        if ((e as Element).shadowRoot) stack.push((e as Element).shadowRoot as ShadowRoot)
      })
    }
    return null
  }
  return resolve(selector)
}

export interface HitTestArgs {
  x: number
  y: number
  /** A press also misses a disabled target. */
  pressing: boolean
}

/**
 * Why a press at a point would miss the element, or null when it lands on the
 * element, its label's control, or the button or link it is in. The point is
 * the element's middle when `at` is null.
 */
export const HIT_TEST_JS = (e: Element, at: HitTestArgs | null): string | null => {
  const field = (e.closest('label') as HTMLLabelElement | null)?.control || e
  const target = e.matches('input, textarea, select') ? e : e.closest('button, [role=button], a, [role=link]') || e
  if (at?.pressing && (target.matches(':disabled') || target.closest('[aria-disabled="true"]')))
    return 'element is not enabled'
  // The point is in this window; elementFromPoint takes it in the element's own frame.
  let x = 0
  let y = 0
  if (at) {
    x = at.x
    y = at.y
    for (let win: Window | null = e.ownerDocument.defaultView; win && win !== window && win.frameElement; win = win.parent) {
      const fe = win.frameElement as HTMLElement
      const fr = fe.getBoundingClientRect()
      x -= fr.x + fe.clientLeft
      y -= fr.y + fe.clientTop
    }
  } else {
    const r = e.getBoundingClientRect()
    x = r.left + r.width / 2
    y = r.top + r.height / 2
  }
  let hit = e.ownerDocument.elementFromPoint(x, y)
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === hit) break
    hit = inner
  }
  for (let n: Node | null = hit; n; n = n.parentNode || (n as ShadowRoot).host || null) {
    if (n === e || n === target || n === field || (n as HTMLLabelElement).control === field) return null
  }
  return hit ? `<${hit.localName}> intercepts pointer events` : 'element is not at the point'
}

/** The element's border box in the top page's viewport, or null when it has no size. */
export const BOX_JS = (el: Element): BoundingBox | null => {
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  let x = r.x
  let y = r.y
  for (let win: Window | null = el.ownerDocument.defaultView; win && win !== window && win.frameElement; win = win.parent) {
    const fe = win.frameElement as HTMLElement
    const fr = fe.getBoundingClientRect()
    x += fr.x + fe.clientLeft
    y += fr.y + fe.clientTop
  }
  return { x, y, width: r.width, height: r.height }
}

export interface FocusedField {
  /** Viewport box in top-page coordinates. */
  box: BoundingBox
  empty: boolean
  /** Whether the field's whole content is selected. */
  selection: 'all' | 'partial'
  /** Paragraph count; triple-click selects one paragraph at a time. */
  lines: number
  /** An <input>: triple-click selects it all wherever it lands. */
  singleLine: boolean
  /**
   * The first line's text span (x from..to, y band), in top-page coordinates.
   * Firefox selects nothing when a triple-click in a textarea or editor lands
   * in the blank space after the text.
   */
  firstLineSpan: { left: number; right: number; top: number; bottom: number }
  /** Rendered line count (wrapped paragraphs span several). */
  visualLines: number
  scrollTop: number
  /** A point on the first line of text (near its start), in top-page coordinates. */
  firstLine: Vector
}

/**
 * The Cursor's clearExisting: the focused field, found by following focus
 * through open shadow roots and same-origin iframes. Null when no field has
 * focus (or it sits in a cross-origin frame). Tag names, not instanceof, since
 * elements in an iframe belong to that frame's realm.
 */
export const FOCUSED_FIELD_JS = (): FocusedField | null => {
  let el = document.activeElement as HTMLElement | null
  let ox = 0
  let oy = 0
  for (;;) {
    if (!el) return null
    if (el.shadowRoot?.activeElement) {
      el = el.shadowRoot.activeElement as HTMLElement
    } else if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      let doc: Document | null = null
      try {
        doc = (el as HTMLIFrameElement).contentDocument
      } catch {
        doc = null
      }
      if (!doc) return null
      const fr = el.getBoundingClientRect()
      ox += fr.x + el.clientLeft
      oy += fr.y + el.clientTop
      el = doc.activeElement as HTMLElement | null
    } else {
      break
    }
  }
  const doc = el.ownerDocument
  // A frame's body only counts when it is itself the editor (designMode or
  // contenteditable), as rich-text editors built on iframes do.
  if (el === doc.body && !el.isContentEditable) return null
  const r = el.getBoundingClientRect()
  const cs = (doc.defaultView ?? window).getComputedStyle(el)
  const isTextControl = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
  const control = el as HTMLInputElement
  const text = isTextControl ? control.value : el.innerText.replace(/\n+$/, '')
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
  let firstLine = {
    x: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + 6,
    y: r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - el.scrollTop + lineHeight / 2,
  }
  const contentLeft = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)
  const lineTop = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - el.scrollTop
  let span = { left: contentLeft, right: contentLeft, top: lineTop, bottom: lineTop + lineHeight }
  if (el.tagName === 'TEXTAREA') {
    const ctx = doc.createElement('canvas').getContext('2d')
    if (ctx) {
      ctx.font = cs.font
      span.right = contentLeft + ctx.measureText(text.split('\n')[0]).width
    }
  }
  let selection: 'all' | 'partial'
  if (isTextControl) {
    // email/number inputs expose no selection range; they are single-line,
    // which triple-click always selects whole.
    selection =
      control.selectionStart == null || (control.selectionStart === 0 && control.selectionEnd === text.length)
        ? 'all'
        : 'partial'
  } else {
    selection = String(doc.getSelection()).trim() === el.innerText.trim() ? 'all' : 'partial'
    // Rich content: aim at the first visible character instead.
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent ?? '').search(/\S/)
      if (i < 0) continue
      const range = doc.createRange()
      range.setStart(n, i)
      range.setEnd(n, i + 1)
      const c = range.getBoundingClientRect()
      firstLine = { x: c.left + c.width / 2 + 4, y: c.top + c.height / 2 }
      range.setEnd(n, (n.textContent ?? '').length)
      const line = range.getClientRects()[0] ?? c
      span = { left: c.left, right: line.right, top: line.top, bottom: line.bottom }
      break
    }
  }
  return {
    box: { x: r.x + ox, y: r.y + oy, width: r.width, height: r.height },
    empty: text.trim() === '',
    selection,
    lines: text === '' ? 1 : text.split('\n').length,
    singleLine: el.tagName === 'INPUT',
    firstLineSpan: { left: span.left + ox, right: span.right + ox, top: span.top + oy, bottom: span.bottom + oy },
    visualLines: Math.ceil(el.scrollHeight / lineHeight),
    scrollTop: el.scrollTop,
    firstLine: { x: firstLine.x + ox, y: firstLine.y + oy },
  }
}

type PageFunction = (el: any, arg: any) => unknown
const onSelectorCache = new Map<PageFunction, (arg: { selector: string; arg: unknown }) => unknown>()

/**
 * A page function `(el, arg) => ...` run on the element a selector names,
 * taking `{ selector, arg }`; null when nothing matches. Composed here, not
 * in the page, so the page needs no `eval` under a strict CSP.
 */
export function onSelector<A, R>(fn: (el: Element, arg: A) => R): (arg: { selector: string; arg: A }) => R | null {
  let composed = onSelectorCache.get(fn as PageFunction)
  if (!composed) {
    composed = new Function(
      'a',
      `const el = (${RESOLVE_SELECTOR_JS})(a.selector); return el ? (${fn})(el, a.arg) : null`,
    ) as (arg: { selector: string; arg: unknown }) => unknown
    onSelectorCache.set(fn as PageFunction, composed)
  }
  return composed as (arg: { selector: string; arg: A }) => R | null
}
