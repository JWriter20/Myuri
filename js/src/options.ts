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
  /** Retries if the cursor misses the element. Default 3. */
  maxTries?: number
  /** Straight-line distance beyond which the move overshoots then corrects. */
  overshootThreshold?: number
  /** ms to wait for the selector before failing. Default 10000. */
  waitForSelector?: number
  /** Delay after the move completes (ms). */
  moveDelay?: number
  randomizeMoveDelay?: boolean
  /** Overall move timeout (ms); aborts the whole attempt. */
  timeout?: number
  /** Selectors whose boxes the destination point must avoid. */
  excludeSelectors?: string | readonly string[]
}

export interface ClickOptions extends MoveOptions {
  button?: 'left' | 'right' | 'middle'
  /** ms to hold the button. */
  waitForClick?: number
  /** Nudge 1px right before clicking. */
  microJitter?: boolean
  /** Re-check the target box just before clicking and correct if it moved. */
  dynamicAdjustment?: boolean
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
  delay?: number
  speedFactor?: number
  overshoot?: number
  /** Where the element lands in the viewport: 0=top, 0.5=center, 1=bottom. */
  finishPosition?: number
  realism?: { speedIrregularity?: number }
  waitForSelector?: number
  maxTries?: number
}

export interface TypeOptions {
  /** Per-key delay hint (ms); the Markov model is the primary timing source. */
  delay?: number
  waitForSelector?: number
  maxTries?: number
  /** Select-all + delete existing content before typing. */
  clearExisting?: boolean
}
