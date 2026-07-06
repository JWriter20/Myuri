// Copy the shared trajectory dataset into dist/ so the published package is
// self-contained. The asset lives at repo-root /assets and is the single
// source of truth shared with the Python package.
import { mkdirSync, copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../assets/trajectories.json.gz')
const destDir = resolve(here, '../dist/assets')
mkdirSync(destDir, { recursive: true })
copyFileSync(src, resolve(destDir, 'trajectories.json.gz'))
console.log('copied trajectories.json.gz -> dist/assets/')
