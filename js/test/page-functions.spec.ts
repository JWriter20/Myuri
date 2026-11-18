import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('page_functions.json', () => {
  it('is the built page functions (run `node scripts/page-functions.mjs` after changing them)', () => {
    // In plain Node, not through vitest, which rewrites the source a function prints.
    const read = "import('./scripts/page-functions.mjs').then((m) => process.stdout.write(JSON.stringify([m.PAGE_FUNCTIONS_PATH, m.pageFunctions()])))"
    const [path, built] = JSON.parse(execFileSync(process.execPath, ['-e', read], { cwd: root, encoding: 'utf8' }))
    expect(readFileSync(path, 'utf8')).toBe(built)
  })
})
