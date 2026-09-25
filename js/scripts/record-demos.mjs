// Record the README demo GIFs: mouse movement, typing, and scrolling.
//
//   npm run build && node scripts/record-demos.mjs
//
// Needs a Playwright Chromium (`npx playwright-core install chromium`) and
// ffmpeg on PATH. Writes ../docs/media/{mouse,typing,scroll}.gif.
//
// Nothing here fakes the motion: the on-page cursor and trail are drawn from
// the real mousemove/wheel/key events myuri dispatches through Playwright.
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
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

// Visible cursor, a fading trail with one dot per mousemove event (so dots
// bunch up where the hand slows down), click ripples, and a key/scroll HUD.
const overlay = () => {
  addEventListener('DOMContentLoaded', () => {
    const canvas = document.createElement('canvas')
    const cursor = document.createElement('div')
    const hud = document.createElement('div')
    canvas.id = '__trail'
    cursor.id = '__cursor'
    hud.id = '__hud'
    document.body.append(canvas, cursor, hud)
    const style = document.createElement('style')
    style.textContent = `
      #__trail { position: fixed; inset: 0; pointer-events: none; z-index: 99998; }
      #__cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none;
        z-index: 99999; transform: translate(-100px, -100px);
        background: url("data:image/svg+xml,${encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><path d="M3 2l14 9.5-6.2 1.3 3.6 6.8-2.7 1.4-3.6-6.9L3 18.6z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>',
        )}") no-repeat; }
      #__hud { position: fixed; right: 14px; bottom: 14px; z-index: 99999; pointer-events: none;
        font: 600 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e8ecf4;
        background: rgba(17, 20, 28, .86); padding: 7px 11px; border-radius: 8px; min-width: 120px;
        white-space: pre; display: none; }
      .__ripple { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
        border: 2px solid #ff5a36; pointer-events: none; z-index: 99997; animation: __r .5s ease-out forwards; }
      @keyframes __r { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }`
    document.head.append(style)

    const ctx = canvas.getContext('2d')
    const dots = []
    const resize = () => {
      canvas.width = innerWidth * devicePixelRatio
      canvas.height = innerHeight * devicePixelRatio
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    }
    resize()
    addEventListener('resize', resize)
    addEventListener('mousemove', (e) => {
      cursor.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`
      dots.push({ x: e.clientX, y: e.clientY, t: performance.now() })
    }, true)
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div')
      r.className = '__ripple'
      r.style.left = `${e.clientX}px`
      r.style.top = `${e.clientY}px`
      document.body.append(r)
      setTimeout(() => r.remove(), 600)
    }, true)
    const LIFE = 1600
    const draw = () => {
      const now = performance.now()
      while (dots.length && now - dots[0].t > LIFE) dots.shift()
      ctx.clearRect(0, 0, innerWidth, innerHeight)
      for (let i = 1; i < dots.length; i++) {
        const a = 1 - (now - dots[i].t) / LIFE
        ctx.strokeStyle = `rgba(255, 90, 54, ${a * 0.55})`
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(dots[i - 1].x, dots[i - 1].y)
        ctx.lineTo(dots[i].x, dots[i].y)
        ctx.stroke()
      }
      for (const d of dots) {
        const a = 1 - (now - d.t) / LIFE
        ctx.fillStyle = `rgba(255, 90, 54, ${a})`
        ctx.beginPath()
        ctx.arc(d.x, d.y, 2.6, 0, Math.PI * 2)
        ctx.fill()
      }
      requestAnimationFrame(draw)
    }
    draw()

    // HUD: recent keystrokes (typing) or live scroll offset (scrolling).
    const keys = []
    const label = { Backspace: '⌫', Enter: '⏎', Shift: '⇧', ' ': '␣' }
    addEventListener('keydown', (e) => {
      if (e.key === 'Shift') return
      keys.push(label[e.key] ?? e.key)
      if (keys.length > 18) keys.shift()
      hud.style.display = 'block'
      hud.textContent = `keys  ${keys.join('')}`
    }, true)
    addEventListener('wheel', (e) => {
      hud.style.display = 'block'
      hud.textContent = `wheel ${e.deltaY > 0 ? '+' : ''}${Math.round(e.deltaY)}\nscrollY ${Math.round(scrollY)}`
    }, { capture: true, passive: true })
    addEventListener('scroll', () => {
      if (hud.textContent.startsWith('wheel')) hud.textContent = hud.textContent.replace(/scrollY \d+/, `scrollY ${Math.round(scrollY)}`)
    }, { capture: true, passive: true })
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

const sections = Array.from({ length: 14 }, (_, i) => `
  <section id="s${i}" style="height:150px;padding:32px 48px;background:${i % 2 ? '#e9e4d8' : '#f4f1ea'}">
    <h2 style="margin:0">Section ${i + 1}</h2>
  </section>`).join('')
const scrollPage = `${base}
  <div class="wrap"><h1>Scrolling</h1><p>Wheel bursts with human momentum, then a click on the target.</p></div>
  ${sections.replace('Section 12</h2>', 'Section 12</h2><button id="target" class="hot" style="margin:8px 0 12px">Target</button>')}
  <div style="height:240px"></div>
  <script>document.getElementById('target').onclick = (e) => e.target.classList.add('clicked')</script>`

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

// Navigate for real rather than setContent(), which would replace the document
// the overlay init script has already decorated.
async function show(page, html) {
  await page.route('https://demo.myuri.test/', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html>${html}` }),
  )
  await page.goto('https://demo.myuri.test/')
}

const demos = {
  async mouse(page, cursor) {
    await show(page, mousePage)
    await cursor.moveTo({ x: 480, y: 560 })
    await pause(500)
    for (const id of ['#a', '#b', '#c', '#d', '#e', '#c']) {
      await cursor.click(id)
      await pause(250)
    }
    await pause(900)
  },
  async typing(page, cursor) {
    await show(page, typingPage)
    await cursor.moveTo({ x: 700, y: 520 })
    await pause(400)
    await cursor.click('#name')
    await cursor.type('Ada Lovelace')
    await pause(300)
    await cursor.click('#msg')
    await cursor.type('Hi! I would love to hear more about the analytical engine.')
    await pause(1200)
  },
  async scroll(page, cursor) {
    await show(page, scrollPage)
    await cursor.moveTo({ x: 480, y: 300 })
    await pause(400)
    await cursor.scroll('#target')
    await pause(300)
    await cursor.click('#target')
    await pause(600)
    await cursor.scroll('#s3')
    await pause(1000)
  },
}

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch()
try {
  for (const [name, run] of Object.entries(demos)) {
    const videoDir = mkdtempSync(join(tmpdir(), `myuri-${name}-`))
    const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
    await context.addInitScript(overlay)
    const page = await context.newPage()
    const cursor = createCursor(page, { seed: SEED })
    await run(page, cursor)
    await cursor.dispose()
    await context.close()

    const webm = join(videoDir, readdirSync(videoDir).find((f) => f.endsWith('.webm')))
    const gif = join(outDir, `${name}.gif`)
    // Trim the blank first frames (before navigation), then build a palette so
    // the GIF stays small without banding. Scrolling repaints every frame, so
    // it gets a lower rate to keep the file light enough for a README.
    const fps = name === 'scroll' ? 12 : 15
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-ss', '0.3', '-i', webm,
      '-vf', `fps=${fps},scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none`,
      `${gif}.tmp.gif`,
    ])
    renameSync(`${gif}.tmp.gif`, gif)
    rmSync(videoDir, { recursive: true, force: true })
    console.log(`wrote ${gif}`)
  }
} finally {
  await browser.close()
}
