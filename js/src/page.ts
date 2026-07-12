import { type ResolvedDriver } from './drivers/types.js'
import { type BoundingBox, type ViewportSize } from './math.js'

/**
 * Driver-agnostic DOM query layer. Every geometry read myuri performs goes
 * through one of these helpers, which run a self-contained page-function via
 * `driver.evaluate`. Selector resolution (CSS, deep/shadow-piercing, and XPath)
 * happens *inside the page*, so no driver-specific selector engine is required —
 * only `evaluate`. The resolver is a plain nested function in each payload (no
 * `eval`/`new Function`), so it works under strict page CSP.
 *
 * Supported selector dialects:
 *   - CSS (default), transparently pierced through open shadow roots
 *   - `a >> b`: descend into a's open shadow root for the next segment
 *   - `a >>> b`: descend into a's same-origin iframe document (cross-origin
 *     frames resolve to null). Geometry is translated into top-page viewport
 *     coordinates, since mouse input is dispatched at page level.
 *   - XPath: prefix with `xpath=`, or a string beginning with `/` or `(`
 */

export interface ScrollMetrics {
  /** Scroll offset of the window (or container, if a selector is given). */
  offset: number
  /** Max scrollable offset (scrollHeight - clientHeight). */
  maxOffset: number
}

/** Viewport dimensions, robust to quirks mode and null-viewport fingerprints. */
export async function viewportOf(driver: ResolvedDriver): Promise<ViewportSize> {
  const vp = await driver.evaluate(
    () => ({
      // Prefer window.inner* (the rendered viewport regardless of doctype).
      width: window.innerWidth || document.documentElement.clientWidth,
      height: window.innerHeight || document.documentElement.clientHeight,
    }),
    null,
  )
  if (!vp || !vp.width || !vp.height) throw new Error('myuri: could not read viewport size')
  return vp
}

/** Bounding box of a selector relative to the top-page viewport, or null if not found. */
export async function boundingBoxOf(
  driver: ResolvedDriver,
  selector: string,
): Promise<BoundingBox | null> {
  return await driver.evaluate((sel: string): BoundingBox | null => {
    function resolve(s: string): Element | null {
      if (s == null) return null
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
    // Offset of el's document viewport in top-page coordinates (same-origin frames).
    function frameOffset(el: Element): { x: number; y: number } {
      let x = 0
      let y = 0
      let win = el.ownerDocument ? el.ownerDocument.defaultView : null
      while (win && win !== window && win.frameElement) {
        const fe = win.frameElement as HTMLElement
        const r = fe.getBoundingClientRect()
        x += r.x + fe.clientLeft
        y += r.y + fe.clientTop
        win = win.parent as Window & typeof globalThis
      }
      return { x, y }
    }
    const el = resolve(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    const o = frameOffset(el)
    return { x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height }
  }, selector)
}

/**
 * Scroll offset + max offset for the window (no selector) or a scroll container.
 * Uses `window.scrollY` for page-level scroll because Firefox/Camoufox report
 * `documentElement.scrollTop` as 0 — the same applies to iframe document roots,
 * which read through their own `defaultView`.
 */
export async function scrollMetricsOf(
  driver: ResolvedDriver,
  containerSelector?: string,
): Promise<ScrollMetrics> {
  return await driver.evaluate((sel: string | null): ScrollMetrics => {
    function resolve(s: string): Element | null {
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
    if (!sel) {
      const doc = document.documentElement
      return {
        offset: window.scrollY,
        maxOffset: Math.max(0, (doc.scrollHeight || 0) - window.innerHeight),
      }
    }
    const el = resolve(sel)
    if (!el) return { offset: -1, maxOffset: -1 }
    // A document root scrolls through its window (Gecko reports scrollTop 0).
    if (el.ownerDocument && el === el.ownerDocument.documentElement && el.ownerDocument.defaultView) {
      const w = el.ownerDocument.defaultView
      return { offset: w.scrollY, maxOffset: Math.max(0, el.scrollHeight - w.innerHeight) }
    }
    return { offset: el.scrollTop, maxOffset: Math.max(0, el.scrollHeight - el.clientHeight) }
  }, containerSelector ?? null)
}

/**
 * Whether the viewport point maps onto the target element (or a descendant),
 * i.e. the target is not occluded by an overlay at that point. Uses an
 * `elementFromPoint` that pierces open shadow roots and same-origin iframes.
 * Returns true if the target can't be resolved (fail-open), matching the
 * previous behavior.
 */
export async function pointHitsTarget(
  driver: ResolvedDriver,
  point: { x: number; y: number },
  selector: string,
): Promise<boolean> {
  return await driver.evaluate(
    (arg: { selector: string; x: number; y: number }): boolean => {
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
            return document.evaluate(expr, document, null, 9, null)
              .singleNodeValue as Element | null
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
      // Deepest element at the point, piercing open shadow roots and descending
      // into same-origin iframes (translating the point into each frame's
      // viewport coordinates as it goes).
      function deepFromPoint(x: number, y: number): Element | null {
        let root: Document | ShadowRoot = document
        let el = root.elementFromPoint(x, y)
        for (;;) {
          if (!el) return null
          if ((el as Element).shadowRoot) {
            const inner = (el as Element).shadowRoot!.elementFromPoint(x, y)
            if (!inner || inner === el) return el
            root = (el as Element).shadowRoot!
            el = inner
            continue
          }
          if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
            let doc: Document | null = null
            try {
              doc = (el as HTMLIFrameElement).contentDocument
            } catch {
              doc = null
            }
            if (!doc) return el
            const r = el.getBoundingClientRect()
            x -= r.x + (el as HTMLElement).clientLeft
            y -= r.y + (el as HTMLElement).clientTop
            const inner = doc.elementFromPoint(x, y)
            if (!inner) return el
            root = doc
            el = inner
            continue
          }
          return el
        }
      }
      function containsDeep(ancestor: Element, node: Element | null): boolean {
        let cur: Node | null = node
        while (cur) {
          if (cur === ancestor) return true
          let parent: Node | null =
            (cur as Element).assignedSlot ??
            cur.parentNode ??
            ((cur as Node & { host?: Node }).host ?? null)
          if (!parent && cur.nodeType === 9) {
            try {
              parent = (cur as Document).defaultView?.frameElement ?? null
            } catch {
              parent = null
            }
          }
          cur = parent
        }
        return false
      }
      const target = resolve(arg.selector)
      if (!target) return true // fail-open when the target can't be resolved
      const hit = deepFromPoint(arg.x, arg.y)
      if (!hit) return false
      return hit === target || containsDeep(target, hit) || containsDeep(hit, target)
    },
    { selector, x: point.x, y: point.y },
  )
}

/**
 * Poll until the selector resolves (and, for `state:'visible'`, has a non-zero
 * box) or the timeout elapses. Returns whether the element was found.
 * Implemented on `evaluate` alone, so no driver needs a native waitForSelector.
 */
export async function waitForElement(
  driver: ResolvedDriver,
  selector: string,
  options: { state?: 'attached' | 'visible'; timeout?: number } = {},
): Promise<boolean> {
  const timeout = options.timeout ?? 10000
  const requireVisible = (options.state ?? 'visible') === 'visible'
  const deadline = Date.now() + timeout
  for (;;) {
    if (driver.isClosed()) return false
    const ok = await driver.evaluate(
      (arg: { selector: string; requireVisible: boolean }): boolean => {
        function resolve(s: string): Element | null {
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
              return document.evaluate(expr, document, null, 9, null)
                .singleNodeValue as Element | null
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
        const el = resolve(arg.selector)
        if (!el) return false
        if (!arg.requireVisible) return true
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      },
      { selector, requireVisible },
    )
    if (ok) return true
    if (Date.now() >= deadline) return false
    await new Promise((res) => setTimeout(res, 50))
  }
}
