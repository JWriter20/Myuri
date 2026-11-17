/**
 * What the operating system a browser claims changes about its input.
 *
 * A person's timing does not depend on it. Recordings of the same tasks on a
 * Mac with a mouse, on a MacBook trackpad and on a Windows touchpad differ by
 * device, not by OS (a click is held as long on all of them), so the timing
 * models are shared, and so is the mouse's report rate. `os` changes only what
 * the OS itself does: the modifier of shortcuts, whether a move may repeat the
 * position the pointer already had (macOS reports every mouse report, 9% of
 * them at the same pixel while moving; Windows sends none), how a notched mouse
 * wheel reaches the page, and how Shift turns the wheel sideways (see
 * `planWheel`).
 */

/** The operating system a browser claims. */
export type Os = 'macos' | 'windows' | 'linux'

const OSES: readonly string[] = ['macos', 'windows', 'linux']

/** Throws unless `os` is undefined or one of {@link Os}. */
export function checkOs(os: Os | undefined): void {
  if (os !== undefined && !OSES.includes(os)) {
    throw new Error(`myuri: unknown os ${JSON.stringify(os)}; use 'macos', 'windows' or 'linux'`)
  }
}

/** The modifier of select-all, copy and paste on `os`: Cmd on macOS, Ctrl elsewhere. */
export function primaryModifier(os: Os): 'Meta' | 'Control' {
  checkOs(os)
  return os === 'macos' ? 'Meta' : 'Control'
}
