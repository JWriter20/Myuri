// Writes the page functions the Python package runs (python/src/myuri/page_functions.json)
// from this package's build, so both languages run the same source.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BOX_JS, FOCUSED_FIELD_JS, HIT_TEST_JS, RESOLVE_SELECTOR_JS } from '../dist/page-functions.js'
import { SCROLL_PLAN_JS } from '../dist/scroll-plan.js'

export const PAGE_FUNCTIONS_PATH = fileURLToPath(new URL('../../python/src/myuri/page_functions.json', import.meta.url))

export function pageFunctions() {
  const source = { RESOLVE_SELECTOR_JS, HIT_TEST_JS, SCROLL_PLAN_JS, BOX_JS, FOCUSED_FIELD_JS }
  return `${JSON.stringify(Object.fromEntries(Object.entries(source).map(([k, fn]) => [k, String(fn)])), null, 2)}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(PAGE_FUNCTIONS_PATH, pageFunctions())
