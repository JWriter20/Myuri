// Drive the human-input recorder page with myuri, so its output can be compared
// with recordings of a person doing the same 45 tasks (see compare.py).
//
// usage: node fidelity/replay.mjs RECORDER_HTML OUT_DIR [--firefox PATH] [--seed N]
//        [--os macos|windows|linux] [--dpr N] [--width W --height H]
//
// RECORDER_HTML is record_human_input.html. OUT_DIR gets events.ndjson.gz and
// device.json in the recorder's own format. Needs js/ built (npm run build).
// Tasks myuri has no action for are skipped with the page's Skip button and
// listed in device.json under "skipped".
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const js = path.join(here, '..', 'js')
const { firefox } = await import(path.join(js, 'node_modules', 'playwright-core', 'index.mjs'))
const myuri = await import(path.join(js, 'dist', 'index.js'))

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv.splice(i, 2)[1] : dflt
}
const firefoxPath = flag('firefox', undefined)
const seed = Number(flag('seed', '1'))
const os = flag('os', 'macos')
const dpr = Number(flag('dpr', '2'))
const width = Number(flag('width', '1280'))
const height = Number(flag('height', '955'))
const [pagePath, outDir] = argv
if (!pagePath || !outDir) {
  console.error('usage: replay.mjs RECORDER_HTML OUT_DIR [options]')
  process.exit(2)
}
fs.mkdirSync(outDir, { recursive: true })
const raw = path.join(outDir, 'events.ndjson')
fs.rmSync(raw, { force: true })
const PAGE = fs.readFileSync(pagePath)
const device = {
  driver: { tool: 'myuri', seed, os, dpr, viewport: [width, height] },
  prefs: { 'privacy.reduceTimerPrecision': false },
  skipped: [],
}
const writeDevice = () => fs.writeFileSync(path.join(outDir, 'device.json'), JSON.stringify(device, null, 1) + '\n')
let finish
/** Task ids in the order the page started them (its #task marks, flushed each second). */
const started = []
const finished = new Promise((r) => (finish = r))

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(PAGE)
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const data = JSON.parse(body)
    if (req.url === '/events') {
      fs.appendFileSync(raw, data.map((e) => JSON.stringify(e) + '\n').join(''))
      for (const e of data) if (e.type === '#task') started.push(e.id)
    }
    else if (req.url === '/specs') device.browser = data
    else if (req.url === '/done') finish()
    writeDevice()
    res.writeHead(200, { 'Content-Length': '0' })
    res.end()
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await firefox.launch({
  headless: false,
  executablePath: firefoxPath,
  firefoxUserPrefs: { 'privacy.reduceTimerPrecision': false },
})
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr })
const page = await context.newPage()
const cursor = myuri.createCursor(page, {
  seed,
  os,
  settings: { scroll: { device: 'mouse' } },
})
const rng = myuri.makeRng(seed + 7)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (lo, hi) => lo + rng() * (hi - lo)
const say = () => page.evaluate(() => document.getElementById('say').textContent)
const nextEnabled = () => page.evaluate(() => !document.getElementById('next').disabled)
async function until(pred, ms = 60000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await pred()) return true
    await sleep(50)
  }
  return false
}

/** A wheel gesture from planWheel, sideways with Shift held: sent on its clock without awaiting each event, as Cursor.scroll does. */
async function wheel(px, sideways) {
  const sent = []
  const start = Date.now()
  for (const step of myuri.planWheel(sideways ? px : 0, sideways ? 0 : px, rng, { os, device: 'mouse' })) {
    await sleep(start + step[3] - Date.now())
    if (step[0] === 'key') sent.push(step[2] === 'down' ? page.keyboard.down(step[1]) : page.keyboard.up(step[1]))
    else sent.push(page.mouse.wheel(step[1], step[2]))
  }
  await Promise.all(sent)
}

async function notches(n, notchPx, { nested = false, shift = false } = {}) {
  if (nested) await cursor.move('#scroller')
  else await cursor.moveTo({ x: rand(0.3, 0.7) * width, y: rand(0.35, 0.75) * height })
  for (let rep = 1; rep <= n; rep++) {
    await until(async () => (await say()).includes(`(${rep} of ${n})`))
    await sleep(rand(250, 700))
    await wheel(rng() < 0.5 || rep % 2 ? notchPx : -notchPx, shift)
    await until(async () => !(await say()).includes(`(${rep} of ${n})`), 6000)
  }
}

const line = os === 'macos' ? 16 : 100
const TASKS = {
  async about() {
    await cursor.type('USB mouse', '#mouse')
    await cursor.type('USB keyboard', '#keyboard')
  },
  async idle() {},
  async wander() {
    const end = Date.now() + 13500
    while (Date.now() < end) {
      await cursor.moveTo({ x: rand(40, width - 40), y: rand(90, height - 40) })
      await sleep(rand(80, 700))
    }
  },
  async targets() {
    for (let i = 0; i < 32; i++) {
      await page.waitForSelector('.target')
      await cursor.click('.target')
    }
  },
  async 'hover-menu'() {
    for (let k = 0; k < 5; k++) {
      const m = `#menu-${k % 3}`
      await cursor.move(m)
      await sleep(rand(150, 450))
      await cursor.click(`${m} li:nth-child(${1 + ((k * 2) % 3)})`)
    }
  },
  async tooltips() {
    for (const i of [1, 2, 3, 4, 5]) {
      await cursor.move(`#tip-${i}`)
      await sleep(rand(1100, 1600))
    }
  },
  async buttons() {
    await cursor.click('#b-disabled')
    const ids = ['#b-plain', '#b-link', '#b-input', '#b-span']
    for (let i = 0; i < 15; i++) await cursor.click(ids[i % 4])
  },
  async 'double-click'() {
    for (let i = 0; i < 5; i++) {
      await cursor.click('#dbl', { clickCount: 2 })
      await sleep(rand(300, 700))
    }
  },
  async 'triple-click'() {
    for (let i = 0; i < 3; i++) {
      await cursor.click('#tpl', { clickCount: 3 })
      await sleep(rand(300, 700))
    }
  },
  async hold() {
    for (let i = 0; i < 3; i++) await cursor.click('#hold', { holdMs: rand(1800, 2400) })
  },
  async 'right-click'() {
    for (let i = 0; i < 5; i++) await cursor.click('#right', { button: 'right' })
  },
  async 'middle-click'() {
    for (let i = 0; i < 3; i++) await cursor.click('#middle', { button: 'middle' })
  },
  async 'rapid-click'() {
    for (let i = 0; i < 15; i++) await cursor.click('#rapid')
  },
  async choices() {
    await cursor.click('label:has(#c1)')
    await cursor.click('#c2')
    await cursor.click('label:has(#c3)')
    await cursor.click('#c4')
    await cursor.click('#r-Blue')
  },
  async form() {
    const values = { name: 'Alex Example', email: 'alex@example.com', phone: '555-0100', city: 'Springfield', password: 'correct-horse-7' }
    for (const [id, v] of Object.entries(values)) await cursor.type(v, `#${id}`)
    await cursor.click('#send')
  },
  async 'type-short'() {
    await cursor.type(await page.textContent('#text'), '#field')
  },
  async 'type-long'() {
    await cursor.type(await page.textContent('#text'), '#field')
  },
  async 'type-symbols'() {
    await cursor.type(await page.textContent('#text'), '#field')
  },
  async 'type-corrections'() {
    await cursor.type('helo wrold', '#field')
    await sleep(rand(300, 700))
    await cursor.type('hello world', '#field', { clearExisting: true })
  },
  async 'type-own-words'() {
    await cursor.type('It rained all morning, so we had hot soup and bread for lunch.', '#field')
  },
  'notch-down': () => notches(10, line),
  'notch-up': () => notches(10, -line),
  'notch-pixels': () => notches(5, line),
  'notch-nested': () => notches(5, line, { nested: true }),
  'wheel-burst': () => notches(5, 5 * line),
  'wheel-spin': () => notches(5, 40 * line),
  'wheel-horizontal': () => notches(5, line, { shift: true }),
  async 'drag-cards'() {
    for (let i = 1; i <= 6; i++) {
      await cursor.drag(`#card-${i}`, i % 2 ? '#bin-odd' : '#bin-even')
      await sleep(rand(200, 500))
    }
  },
  async 'drag-box'() {
    for (let i = 0; i < 5; i++) {
      // The dock is larger than the square: aim the grab point so the square lands inside it.
      const m = await page.locator('#mover').boundingBox()
      const d = await page.locator('#dock').boundingBox()
      const gx = rand(0.3, 0.7) * m.width
      const gy = rand(0.3, 0.7) * m.height
      const tx = d.x + (d.width - m.width) * rand(0.35, 0.65) + gx
      const ty = d.y + (d.height - m.height) * rand(0.35, 0.65) + gy
      await cursor.drag({ x: m.x + gx, y: m.y + gy }, { x: tx, y: ty })
      await sleep(rand(250, 600))
    }
  },
  async 'drag-slider'() {
    for (let i = 0; i < 4; i++) {
      await page.waitForFunction(() => document.getElementById('knob').offsetLeft < 5)
      const t = await page.locator('#track').boundingBox()
      await cursor.drag('#knob', { x: t.x + t.width + rand(10, 60), y: t.y + t.height / 2 + rand(-8, 8) })
      await sleep(rand(300, 600))
    }
  },
  async 'select-text'() {
    for (let i = 0; i < 3; i++) {
      // Drag from just before "The second" to just after "select."
      const r = await page.evaluate(() => {
        const n = document.getElementById('prose').firstChild
        const t = n.textContent
        const a = t.indexOf('The second')
        const b = t.indexOf('select.') + 'select.'.length
        const range = document.createRange()
        range.setStart(n, a); range.setEnd(n, a + 1)
        const s = range.getBoundingClientRect()
        range.setStart(n, b - 1); range.setEnd(n, b)
        const e = range.getBoundingClientRect()
        return { sx: s.left - 1, sy: s.top + s.height / 2, ex: e.right + 2, ey: e.top + e.height / 2 }
      })
      await cursor.drag({ x: r.sx, y: r.sy }, { x: r.ex, y: r.ey })
      await sleep(rand(400, 800))
      await cursor.moveTo({ x: rand(0.3, 0.7) * width, y: height - rand(80, 160) })
      await cursor.click()
      await sleep(rand(300, 600))
    }
  },
  async 'resize-box'() {
    const corner = async () => {
      const b = await page.locator('#field').boundingBox()
      return { x: b.x + b.width - 4, y: b.y + b.height - 4 }
    }
    const a = await corner()
    await cursor.drag(a, { x: a.x + rand(20, 80), y: a.y + rand(220, 300) })
    await sleep(rand(400, 800))
    const b = await corner()
    await cursor.drag(b, { x: b.x - rand(0, 40), y: b.y - rand(180, 240) })
  },
  async 'read-article'() {
    await cursor.scroll('#end')
    await cursor.click('#end')
  },
  async 'find-and-click'() {
    await cursor.scroll('#top-b')
    await cursor.click('#top-b')
    await cursor.scroll('#bottom-b')
    await cursor.click('#bottom-b')
  },
  async 'scroll-box-accept'() {
    await cursor.scroll('#agree')
    await cursor.click('#agree')
    await cursor.click('#accept')
  },
  async 'shop-flow'() {
    await cursor.type('blue shoes\n', '#q')
    await page.waitForSelector('#item-12')
    await cursor.scroll('#item-12')
    await cursor.click('#item-12')
    await page.waitForSelector('#size')
    // A <select> popup is drawn by the parent process, outside the page: pick by keyboard.
    await cursor.click('#size')
    await sleep(rand(300, 600))
    await cursor.type('42\n')
    await cursor.click('#add')
    await cursor.type('SAVE10', '#code')
    await cursor.click('#apply')
    await cursor.click('#place')
  },
}

page.on('pageerror', (e) => console.error('page error:', e.message))
await page.goto(url)
let last = -1
for (;;) {
  if (!(await until(async () => started.length - 1 > last, 30000))) break
  const i = started.length - 1
  const id = started[i]
  const total = 45
  last = i
  const task = TASKS[id]
  const t0 = Date.now()
  let action = 'skip'
  if (task) {
    try {
      await task()
      action = (await until(nextEnabled, 20000)) ? 'next' : 'skip'
    } catch (e) {
      console.error(`${id}: ${e.message.split('\n')[0]}`)
    }
  }
  if (action === 'skip') device.skipped.push(id)
  console.log(`${String(i + 1).padStart(2)}/${total} ${id}: ${action} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
  await sleep(rand(300, 900))
  await cursor.click(action === 'next' ? '#next' : '#skip')
  if (i + 1 === total) break
}
await Promise.race([finished, sleep(10000)])
writeDevice()
await browser.close()
server.close()
fs.writeFileSync(path.join(outDir, 'events.ndjson.gz'), zlib.gzipSync(fs.readFileSync(raw), { level: 9 }))
fs.rmSync(raw)
console.log(`wrote ${outDir}; skipped ${device.skipped.length}: ${device.skipped.join(' ')}`)
