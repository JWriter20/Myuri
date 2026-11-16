/**
 * Typing model configuration: what gets mistyped and corrected.
 * Ported from HumanTyping (https://github.com/Lax3n/HumanTyping).
 * Timing lives in `timing.ts`.
 */

// Default average typing speed (words per minute)
export const DEFAULT_WPM = 80
/** Session-to-session spread of a typist's speed around their WPM. */
export const WPM_STD = 10

// Probabilities
export const PROB_ERROR = 0.04
export const PROB_SWAP_ERROR = 0.015
export const PROB_NOTICE_ERROR = 0.85

// Correction probabilities
export const DRIFT_CORRECTION_PROB = 0.8

// Error multipliers by context
export const COMPLEX_WORD_ERROR_MULT = 1.5
export const COMMON_WORD_ERROR_MULT = 0.5
export const COMPOSED_ACCENT_ERROR_MULT = 2.0
