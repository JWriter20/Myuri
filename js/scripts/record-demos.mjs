// Record the README demo GIFs: mouse movement, typing, and scrolling.
//
//   npm run build && node scripts/record-demos.mjs [mouse] [typing] [scroll]
//
// With no names, records all three. Needs a Playwright Chromium
// (`npx playwright-core install chromium`) and ffmpeg on PATH. Writes
// ../docs/media/<name>.gif.
//
// Nothing here fakes the motion: the cursor, trail, and charts are drawn from
// the real mousemove/wheel/scroll/key events myuri dispatches. Two rules keep
// the recording from changing what it records:
//   - Frames come from Chromium's screencast, which costs the page nothing
//     (Playwright's recordVideo is lossy and blurs text).
//   - The recording adds no work to the page being measured: the overlays use
//     compositor-only CSS animations, and the scroll demo's chart panel is
//     drawn onto the frames afterwards from a timestamped event log. (Before
//     myuri 3.0.1, which stopped awaiting each wheel event, per-frame repaints
//     or per-event DOM updates made scrolls play back ~1.7x slower.)
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { createCursor } from '../dist/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../../docs/media')
const SIZE = { width: 960, height: 600 }
const SEED = 20260925
const FPS = 20

// Visible cursor, a fading trail with one dot per mousemove event (so dots
// bunch up where the hand slows down), click ripples, and a recent-keys HUD.
// All animation is CSS on the compositor; the DOM only changes on mouse and
// key events, never on wheel/scroll events or per frame.
const overlay = () => {
  addEventListener('DOMContentLoaded', () => {
    const cursor = document.createElement('div')
    const hud = document.createElement('div')
    cursor.id = '__cursor'
    hud.id = '__hud'
    document.body.append(cursor, hud)
    const style = document.createElement('style')
    style.textContent = `
      #__cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; z-index: 99999;
        transform: translate(-100px, -100px);
        background: url("data:image/svg+xml,${encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><path d="M3 2l14 9.5-6.2 1.3 3.6 6.8-2.7 1.4-3.6-6.9L3 18.6z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>',
        )}") no-repeat; }
      .__dot { position: fixed; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px; border-radius: 50%; background: #ff5a36;
        pointer-events: none; z-index: 99998; animation: __fade 1.6s linear forwards }
      @keyframes __fade { to { opacity: 0 } }
      .__ripple { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
        border: 2px solid #ff5a36; pointer-events: none; z-index: 99997; animation: __r .5s ease-out forwards; }
      @keyframes __r { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
      #__hud { position: fixed; right: 14px; bottom: 14px; z-index: 99999; pointer-events: none; display: none;
        font: 600 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e8ecf4;
        background: rgba(17, 20, 28, .86); padding: 7px 11px; border-radius: 8px; white-space: pre; }`
    document.head.append(style)

    const spawn = (cls, x, y) => {
      const el = document.createElement('div')
      el.className = cls
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      document.body.append(el)
      el.addEventListener('animationend', () => el.remove())
    }
    addEventListener('mousemove', (e) => {
      cursor.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`
      spawn('__dot', e.clientX, e.clientY)
    }, true)
    addEventListener('mousedown', (e) => spawn('__ripple', e.clientX, e.clientY), true)

    const keys = []
    const label = { Backspace: '⌫', Enter: '⏎', ' ': '␣' }
    addEventListener('keydown', (e) => {
      if (e.key === 'Shift') return
      keys.push(label[e.key] ?? e.key)
      if (keys.length > 18) keys.shift()
      hud.style.display = 'block'
      hud.textContent = `keys  ${keys.join('')}`
    }, true)
  })
}

const base = `
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box }
    body { margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color: #1c2230;
      background: #f4f1ea; }
    h1 { font-size: 26px; margin: 0 0 4px } p { margin: 0; color: #5b6272 }
    .wrap { padding: 36px 48px }
    button { font: 600 15px system-ui, sans-serif; border: 0; border-radius: 10px; padding: 14px 22px;
      background: #1c2230; color: #fff; cursor: pointer }
    button.alt { background: #fff; color: #1c2230; box-shadow: inset 0 0 0 2px #1c2230 }
    button.hot { background: #ff5a36 }
    button.clicked { outline: 3px solid #ff5a36; outline-offset: 3px }
    input, textarea { font: 17px system-ui, sans-serif; width: 100%; padding: 12px 14px; border-radius: 10px;
      border: 2px solid #cfc9bc; background: #fff; color: #1c2230; outline: none }
    input:focus, textarea:focus { border-color: #1c2230 }
    label { display: block; font-weight: 600; margin: 18px 0 6px }
  </style>`

const mousePage = `${base}
  <div class="wrap">
    <h1>Mouse movement</h1>
    <p>Paths are recorded human trajectories from cursory, fitted to each target.</p>
  </div>
  <button id="a" style="position:absolute;left:80px;top:170px">Sign in</button>
  <button id="b" class="alt" style="position:absolute;left:700px;top:140px">Pricing</button>
  <button id="c" class="hot" style="position:absolute;left:430px;top:300px">Get started</button>
  <button id="d" class="alt" style="position:absolute;left:120px;top:470px">Docs</button>
  <button id="e" style="position:absolute;left:760px;top:490px">Contact</button>
  <script>for (const b of document.querySelectorAll('button')) b.onclick = () => b.classList.add('clicked')</script>`

const typingPage = `${base}
  <div class="wrap">
    <h1>Typing</h1>
    <p>Markov-model rhythm with natural mistakes and corrections.</p>
    <label for="name">Name</label><input id="name" autocomplete="off">
    <label for="msg">Message</label><textarea id="msg" rows="4"></textarea>
  </div>`

// Scrolling: a skeleton careers page with a fixed nav and a fixed cookie bar
// (targets must land clear of both), a long article, and an Apply section whose
// nested location list is its own scroller. The right side is left empty for
// the chart panel, which is composited afterwards (see drawScrollPanel).
const cities = ['Amsterdam', 'Atlanta', 'Austin', 'Berlin', 'Boston', 'Chicago', 'Denver', 'Dublin', 'Lisbon', 'London',
  'Los Angeles', 'Madrid', 'Miami', 'Montreal', 'Munich', 'New York', 'Oslo', 'Paris', 'Portland', 'Prague', 'Seattle',
  'Singapore', 'Stockholm', 'Sydney', 'Tokyo', 'Toronto', 'Vancouver', 'Vienna', 'Warsaw', 'Zurich']
const skeleton = (i) => {
  const widths = [96, 91, 98, 73, 88, 60]
  const lines = Array.from({ length: 4 + (i % 3) }, (_, j) => `<div class="line" style="width:${widths[j % widths.length]}%"></div>`)
  const image = i % 3 === 1 ? `<div class="img" style="background:${['#e7d8c9', '#d6e4dc', '#dcd9ea'][i % 3]}"></div>` : ''
  return `<section class="block"><div class="h" style="width:${40 + ((i * 17) % 35)}%"></div>${image}${lines.join('')}</section>`
}
const scrollPage = `${base}
  <style>
    body { font-size: 15px }
    nav { position: fixed; top: 0; left: 0; right: 0; height: 54px; background: #1c2230; color: #fff; z-index: 10;
      display: flex; align-items: center; gap: 22px; padding: 0 28px; font-weight: 600 }
    nav span { opacity: .55; font-weight: 500 }
    .cookie { position: fixed; left: 0; right: 0; bottom: 0; height: 58px; background: #fffdf8; z-index: 10;
      border-top: 1px solid #ddd6c8; display: flex; align-items: center; padding: 0 28px; color: #5b6272 }
    .cookie b { margin-left: auto; background: #1c2230; color: #fff; padding: 7px 14px; border-radius: 8px; font-size: 13px }
    main { width: 600px; padding: 78px 28px 140px }
    .sub { color: #5b6272; margin-bottom: 18px }
    .block { background: #fffdf8; border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; box-shadow: 0 1px 0 #e4ddcf }
    .h { height: 14px; border-radius: 7px; background: #c9c2b4; margin-bottom: 14px }
    .line { height: 9px; border-radius: 5px; background: #e6e0d4; margin-bottom: 9px }
    .img { height: 110px; border-radius: 10px; margin-bottom: 14px }
    #apply-section { background: #fffdf8; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 0 0 2px #ff5a36 }
    #apply-section h2 { margin: 0 0 4px; font-size: 20px }
    button { padding: 12px 22px; background: #ff5a36 }
    button.clicked { outline-color: #1c2230 }
    #location { display: none; margin-top: 14px }
    #location.open { display: block }
    #location label { margin: 0 0 6px }
    #cities { height: 150px; overflow-y: auto; border: 2px solid #cfc9bc; border-radius: 10px; background: #fff }
    #cities div { padding: 7px 12px; border-bottom: 1px solid #f0ece3 }
    #cities div.picked { background: #ff5a36; color: #fff; font-weight: 600 }
  </style>
  <nav>Acme Careers <span>Teams</span><span>Locations</span><span>Benefits</span></nav>
  <main>
    <h1 id="top">Senior Product Engineer</h1>
    <div class="sub">Remote-friendly · Full time</div>
    ${Array.from({ length: 12 }, (_, i) => skeleton(i)).join('')}
    <div id="apply-section">
      <h2>Ready to apply?</h2>
      <div class="sub">Pick where you'd like to work.</div>
      <button id="apply">Apply now</button>
      <div id="location"><label>Location</label><div id="cities">${cities
        .map((c) => `<div id="city-${c.toLowerCase().replace(/ /g, '-')}">${c}</div>`)
        .join('')}</div></div>
    </div>
    ${Array.from({ length: 3 }, (_, i) => skeleton(i + 20)).join('')}
  </main>
  <div class="cookie">We use cookies to improve your experience. <b>Accept</b></div>
  <script>
    apply.onclick = () => { apply.classList.add('clicked'); document.getElementById('location').classList.add('open') }
    for (const d of document.querySelectorAll('#cities div')) d.onclick = () => d.classList.add('picked')
    // Log only (no DOM work): wheel and scroll events with wall-clock times, so
    // the chart can be drawn onto the frames afterwards.
    const now = () => performance.timeOrigin + performance.now()
    const list = document.getElementById('cities')
    window.__log = { wheel: [], scroll: [] }
    addEventListener('wheel', (e) => {
      const inList = !!(e.target.closest && e.target.closest('#cities'))
      __log.wheel.push({ t: now(), d: e.deltaY, list: inList })
    }, { capture: true, passive: true })
    addEventListener('scroll', (e) => {
      const page = document.documentElement
      __log.scroll.push({ t: now(), y: scrollY, pageMax: page.scrollHeight - innerHeight,
        top: list.scrollTop, listMax: list.scrollHeight - list.clientHeight })
    }, { capture: true, passive: true })
  </script>`

// Drawn in the compositor page, onto each captured frame: the wheel events the
// page received (|deltaY| per event over the last 4 s) and the scroll position
// of the page and the location list, as of frame time t.
const drawScrollPanel = (ctx, log, t) => {
  const HISTORY = 4000
  const [x0, y0, w, h] = [628, 68, 318, 460]
  ctx.fillStyle = 'rgba(17, 20, 28, 0.93)'
  ctx.beginPath()
  ctx.roundRect(x0, y0, w, h, 12)
  ctx.fill()
  const text = (s, x, y, font, color) => {
    ctx.font = font
    ctx.fillStyle = color
    ctx.fillText(s, x, y)
  }
  const title = '600 13px system-ui, sans-serif'
  const note = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
  const px = x0 + 16
  const cw = w - 32
  const xAt = (time) => px + cw - ((t - time) / HISTORY) * cw

  text('Wheel events', px, y0 + 26, title, '#fff')
  text('|deltaY| of each event received', px, y0 + 44, note, '#9aa3b5')
  const [wy, wh] = [y0 + 54, 110]
  ctx.fillStyle = 'rgba(255,255,255,.05)'
  ctx.fillRect(px, wy, cw, wh)
  const recent = log.wheel.filter((e) => e.t <= t && t - e.t < HISTORY)
  for (const e of recent) {
    const bh = Math.max(2, Math.min(1, Math.abs(e.d) / 140) * (wh - 6))
    ctx.fillStyle = e.list ? '#7cc4a4' : e.d < 0 ? '#f5c16c' : '#ff8a6b'
    ctx.fillRect(xAt(e.t) - 1, wy + wh - bh, 2, bh)
  }
  const legend = (y, items) => {
    ctx.font = note
    let lx = px
    for (const [label, color] of items) {
      ctx.fillStyle = color
      ctx.fillRect(lx, y - 8, 8, 8)
      text(label, lx + 12, y, note, '#9aa3b5')
      lx += 26 + ctx.measureText(label).width
    }
  }
  legend(wy + wh + 17, [['page, down', '#ff8a6b'], ['page, up', '#f5c16c'], ['list', '#7cc4a4']])

  const py = wy + wh + 50
  text('Scroll position', px, py, title, '#fff')
  legend(py + 18, [['page', '#ff8a6b'], ['location list', '#7cc4a4']])
  const [gy, gh] = [py + 28, 110]
  ctx.fillStyle = 'rgba(255,255,255,.05)'
  ctx.fillRect(px, gy, cw, gh)
  const scrolls = log.scroll.filter((s) => s.t <= t)
  const lines = [
    ['#ff8a6b', (s) => s.y / Math.max(1, s.pageMax)],
    ['#7cc4a4', (s) => s.top / Math.max(1, s.listMax)],
  ]
  for (const [color, frac] of lines) {
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    // Hold the value between events: plot from HISTORY ago up to t.
    const before = scrolls.filter((s) => t - s.t >= HISTORY).at(-1)
    const inWindow = scrolls.filter((s) => t - s.t < HISTORY)
    const points = [...(before ? [{ ...before, t: t - HISTORY }] : []), ...inWindow]
    if (points.length === 0) points.push({ t: t - HISTORY, y: 0, pageMax: 1, top: 0, listMax: 1 })
    points.push({ ...points.at(-1), t })
    points.forEach((s, i) => {
      const y = gy + 6 + frac(s) * (gh - 12)
      i ? ctx.lineTo(xAt(s.t), y) : ctx.moveTo(xAt(s.t), y)
    })
    ctx.stroke()
  }

  const last = scrolls.at(-1) ?? { y: 0, top: 0 }
  const rows = [
    ['wheel events', String(log.wheel.filter((e) => e.t <= t).length)],
    ['page scrollY', `${Math.round(last.y)} px`],
    ['list scrollTop', `${Math.round(last.top)} px`],
  ]
  rows.forEach(([k, v], i) => {
    text(k, px, gy + gh + 26 + i * 19, note, '#9aa3b5')
    text(v, px + 130, gy + gh + 26 + i * 19, '600 12px ui-monospace, SFMono-Regular, Menlo, monospace', '#fff')
  })
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const demos = {
  mouse: {
    html: mousePage,
    async run(cursor) {
      await cursor.moveTo({ x: 480, y: 560 })
      await pause(500)
      for (const id of ['#a', '#b', '#c', '#d', '#e', '#c']) {
        await cursor.click(id)
        await pause(250)
      }
      await pause(900)
    },
  },
  typing: {
    html: typingPage,
    async run(cursor) {
      await cursor.moveTo({ x: 700, y: 520 })
      await pause(400)
      await cursor.click('#name')
      await cursor.type('Ada Lovelace')
      await pause(300)
      await cursor.click('#msg')
      await cursor.type('Hi! I would love to hear more about the analytical engine.')
      await pause(1200)
    },
  },
  scroll: {
    html: scrollPage,
    start: { x: 300, y: 330 },
    panel: drawScrollPanel,
    async run(cursor) {
      await pause(700)
      await cursor.scroll('#apply')
      await pause(350)
      await cursor.click('#apply')
      await pause(500)
      await cursor.scroll('#city-toronto')
      await pause(250)
      await cursor.click('#city-toronto')
      await pause(700)
      await cursor.scroll('#top')
      await pause(1400)
    },
  },
}

// Screencast frames with their wall-clock times (ms).
async function record(context, demo) {
  const page = await context.newPage()
  // Navigate for real rather than setContent(), which would replace the
  // document the overlay init script has already decorated.
  await page.route('https://demo.myuri.test/', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html>${demo.html}` }),
  )
  await page.goto('https://demo.myuri.test/')
  // Start capturing only once the page has painted, so no blank first frame.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

  const cdp = await context.newCDPSession(page)
  const frames = []
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp * 1000 })
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  const cursor = createCursor(page, { seed: SEED, ...(demo.start ? { start: demo.start } : {}) })
  await demo.run(cursor)
  await cdp.send('Page.stopScreencast')
  const log = demo.panel ? await page.evaluate(() => window.__log) : null
  await cursor.dispose()
  await page.close()
  return { frames, log }
}

// Resample to a constant FPS (the screencast only emits frames when something
// changes) and, for the scroll demo, draw the chart panel onto each frame.
async function render(browser, { frames, log }, panel, dir) {
  const compositor = await browser.newPage({ viewport: SIZE })
  await compositor.setContent(`<canvas width="${SIZE.width}" height="${SIZE.height}"></canvas>`)
  if (panel) await compositor.evaluate(`window.drawPanel = ${panel.toString()}`)
  const start = frames[0].t
  const end = frames.at(-1).t
  let f = 0
  let n = 0
  for (let t = start; t <= end; t += 1000 / FPS, n++) {
    while (f + 1 < frames.length && frames[f + 1].t <= t) f++
    let png = frames[f].data
    if (panel) {
      png = await compositor.evaluate(
        async ({ data, log, t }) => {
          const canvas = document.querySelector('canvas')
          const ctx = canvas.getContext('2d')
          const img = new Image()
          img.src = `data:image/png;base64,${data}`
          await img.decode()
          ctx.drawImage(img, 0, 0)
          window.drawPanel(ctx, log, t)
          return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length)
        },
        { data: png, log, t },
      )
    }
    writeFileSync(join(dir, `f${String(n).padStart(5, '0')}.png`), Buffer.from(png, 'base64'))
  }
  await compositor.close()
  return n
}

const wanted = process.argv.slice(2)
const unknown = wanted.filter((name) => !(name in demos))
if (unknown.length) throw new Error(`unknown demo: ${unknown.join(', ')} (have: ${Object.keys(demos).join(', ')})`)

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch()
try {
  for (const [name, demo] of Object.entries(demos)) {
    if (wanted.length && !wanted.includes(name)) continue
    const context = await browser.newContext({ viewport: SIZE })
    await context.addInitScript(overlay)
    const recording = await record(context, demo)
    await context.close()

    const dir = mkdtempSync(join(tmpdir(), `myuri-${name}-`))
    const count = await render(browser, recording, demo.panel, dir)
    const gif = join(outDir, `${name}.gif`)
    // A palette per GIF keeps it small without banding.
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%05d.png'),
      '-vf', 'scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none',
      `${gif}.tmp.gif`,
    ])
    renameSync(`${gif}.tmp.gif`, gif)
    rmSync(dir, { recursive: true, force: true })
    console.log(`wrote ${gif} (${count} frames, ${(count / FPS).toFixed(1)} s)`)
  }
} finally {
  await browser.close()
}
