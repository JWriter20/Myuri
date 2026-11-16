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

// Seed -> behavioral profile (the "behavioral fingerprint").
export { generateProfile } from './profile.js'

// Action option types.
export type {
  BoxOptions,
  PathOptions,
  MoveOptions,
  ClickOptions,
  MoveToOptions,
  ScrollOptions,
  TypeOptions,
  RandomMoveOptions,
} from './options.js'

// Typing engine (advanced/standalone use).
export { HumanTyper, realClock, type TyperInput, type HumanTyperOptions, type TypingClock } from './typing/typer.js'
export { KeystrokeTiming, strokesForText, needsShift, type Stroke, type KeyAction } from './typing/timing.js'
export { generateWheelPath, type WheelStyle, type WheelOptions } from './motion/wheel-model.js'
