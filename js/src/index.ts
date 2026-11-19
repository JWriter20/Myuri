// myuri — API-agnostic human-like browser cursor, keyboard, and scroll.

export { Cursor, createCursor, type CursorOptions, type CursorDriverConfig } from './cursor.js'

// Driver interface, defaults, and prebuilt wrappers.
export {
  type Driver,
  type ResolvedDriver,
  type MouseButton,
  type PressOptions,
  type PageFunction,
  type WaitForElementOptions,
  defineDriver,
  playwrightDriver,
  type PlaywrightLikePage,
  cdpDriver,
  type CdpCapablePage,
  type CdpSession,
  puppeteerDriver,
  type PuppeteerLikePage,
  fromPlaywright,
  fromCDP,
  fromPuppeteer,
  driverFromPage,
} from './drivers/index.js'

// Geometry + math types.
export type { Vector, TimedVector, BoundingBox, ViewportSize } from './math.js'
export { path, getRandomBoxPoint, getBetterStartingPosition } from './geometry.js'

// Determinism.
export { type Rng, SeededRng, makeRng, generateRandomSeed, gaussian } from './rng.js'

// Behavioral settings.
export {
  type MyuriSettings,
  type DeepPartial,
  defaultSettings,
  resolveSettings,
} from './settings.js'

// The OS the browser claims: the shortcut modifier, the move cadence and the wheel.
export { type Os, primaryModifier } from './target-os.js'

// Pure planners: what a Cursor would do, without a browser.
export {
  planMove,
  planPoint,
  planClick,
  planType,
  planPress,
  planSelectAll,
  planWheel,
  wheelSteps,
  type PlannedPoint,
  type PlanMoveOptions,
  type ClickPlan,
  type PlanClickOptions,
  type KeyStep,
  type PlanTypeOptions,
  type WheelStep,
  type PlanWheelOptions,
} from './plan.js'

// The smart actions on any host (see actions.ts): each part can be swapped.
export {
  Actions,
  Missed,
  validateSteps,
  PARTS,
  LANDING_MS,
  RETRY_MS,
  SCROLL_PASSES,
  type Host,
  type Step,
  type Button,
  type Parts,
  type PartContext,
  type Measured,
  type ActionsOptions,
  type ClickOptions as ActionClickOptions,
} from './actions.js'

// Page functions the actions evaluate, one source for every language (page_functions.json).
export { RESOLVE_SELECTOR_JS, HIT_TEST_JS, onSelector, type HitTestArgs } from './page-functions.js'
export {
  SCROLL_PLAN_JS,
  SCROLL_PAD,
  SCROLL_EDGE,
  type ScrollPlan,
  type ScrollPlanArgs,
} from './scroll-plan.js'

// Seed -> behavioral profile (the "behavioral fingerprint").
export { generateProfile } from './profile.js'

// Action option types.
export type {
  BoxOptions,
  PathOptions,
  MoveOptions,
  ClickOptions,
  DragOptions,
  MoveToOptions,
  ScrollOptions,
  TypeOptions,
  RandomMoveOptions,
} from './options.js'

// Typing engine (advanced/standalone use).
export { HumanTyper, realClock, type TyperInput, type HumanTyperOptions, type TypingClock } from './typing/typer.js'
export { KeystrokeTiming, strokesForText, needsShift, type Stroke, type KeyAction } from './typing/timing.js'
export { generateWheelPath, type WheelStyle, type WheelOptions } from './motion/wheel-model.js'
export { clickHoldMs, preClickDwellMs, multiClickGapMs, dragStartMs, dragEndMs, dragCarrySpeed } from './motion/click-model.js'
