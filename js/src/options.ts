/** Public option types for Cursor actions. */

/** Padding controls for choosing a point inside a target box. */
export interface BoxOptions {
  /** Horizontal inset as a % of width (split across left/right unless overridden). */
  widthPaddingPercentage?: number
  /** Vertical inset as a % of height (split across top/bottom unless overridden). */
  heightPaddingPercentage?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
}

export interface PathOptions {
  /** >1 is faster, <1 slower. Default 1. */
  moveSpeed?: number
}

export interface MoveOptions extends BoxOptions, PathOptions {
  /** Tries before a miss is thrown. Default: try again until `timeout`. */
  maxTries?: number
  /** Straight-line distance beyond which the move overshoots then corrects. */
  overshootThreshold?: number
  /** Delay after the move completes (ms). */
  moveDelay?: number
  randomizeMoveDelay?: boolean
  /** ms to keep trying (waiting for the element, scrolling, retrying a miss). Default 10000. */
  timeout?: number
  /** Selectors whose boxes the destination point must avoid. */
  excludeSelectors?: string | readonly string[]
}

export interface ClickOptions extends MoveOptions {
  button?: 'left' | 'right' | 'middle'
  /** 2 for a double click, 3 for a triple click. Default 1. */
  clickCount?: number
  /**
   * ms to hold the button down (each click of a multi-click). Default: drawn
   * per click from recorded people (median ~97 ms). Set it for a long press.
   */
  holdMs?: number
  /** ms to wait after the click before the next action. */
  waitForClick?: number
}

export interface DragOptions extends MoveOptions {
  button?: 'left' | 'right' | 'middle'
  /** ms to wait after releasing before the next action. Default 50. */
  waitForRelease?: number
}

export interface MoveToOptions extends PathOptions {
  moveDelay?: number
  randomizeMoveDelay?: boolean
}

export interface RandomMoveOptions {
  moveDelay?: number
  randomizeMoveDelay?: boolean
  moveSpeed?: number
}

export interface ScrollOptions {
  speedFactor?: number
  /** Where the element lands in the viewport: 0=top, 0.5=center, 1=bottom. */
  finishPosition?: number
  realism?: { speedIrregularity?: number }
  /** ms to wait for the element. Default 10000. */
  timeout?: number
  /** Scroll passes before giving up. Default 3. */
  maxTries?: number
}

export interface TypeOptions {
  /** ms to keep trying to click the field. Default 10000. */
  timeout?: number
  maxTries?: number
  /** Select-all + delete existing content before typing. */
  clearExisting?: boolean
}
