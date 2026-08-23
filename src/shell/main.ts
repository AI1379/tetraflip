import './style.css'
import { dirFromKey, isRestartKey, isUndoKey } from '../core/keyboard'
import { loadLevels } from '../core/levels'
import type { LoadedLevel } from '../core/levels'
import { History } from '../core/undo'
import type { AnyGame, Dir } from '../core/protocol'
import { t3Game, render as renderT3 } from '../games/t3'
import { chemGame, render as renderChem, setChemDecor } from '../games/chem'

/**
 * 浏览器壳：游戏切换、关卡导航、HUD、撤销/重开、画布宿主。
 * 这是唯一允许 any 的胶合层（桥接异构游戏类型），引擎保持严格类型。
 */

interface Bundle {
  id: string
  label: string
  def: AnyGame
  render: (state: any, ctx: CanvasRenderingContext2D, w: number, h: number) => void
  /** 装饰开关（design §10：包装可用一个开关整体关掉）；未实现则缺省 */
  setDecor?: (v: boolean) => void
}

const bundles: Record<string, Bundle> = {
  t3: { id: 't3', label: 't+3', def: t3Game, render: renderT3 },
  chem: { id: 'chem', label: '109.5°', def: chemGame, render: renderChem, setDecor: setChemDecor },
}

// 一次 glob 两个游戏的关卡，按目录分流
const levelFiles = import.meta.glob('../games/*/levels/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

function filesFor(gameId: string): Record<string, unknown> {
  const marker = `/games/${gameId}/levels/`
  return Object.fromEntries(Object.entries(levelFiles).filter(([path]) => path.includes(marker)))
}

// ---------- DOM ----------

const app = document.querySelector('#app') as HTMLElement
app.innerHTML = `
  <header class="bar">
    <div class="tabs" id="tabs"></div>
    <div class="nav">
      <button id="prev" title="上一关 [">◀</button>
      <span id="level-label"></span>
      <button id="next" title="下一关 ]">▶</button>
    </div>
    <div class="hud">
      <span id="move-label"></span>
      <button id="decor" class="active" title="装饰开关：关掉背景装饰，只留玩法信息">✦ 装饰 开</button>
      <button id="undo" title="撤销 (Z)">↩ 撤销</button>
      <button id="restart" title="重开 (R)">⟳ 重开</button>
    </div>
  </header>
  <div id="level-hint" class="level-hint hidden"></div>
  <main class="stage">
    <canvas id="board"></canvas>
    <div id="overlay" class="overlay hidden">
      <div class="overlay-card">
        <div class="win-mark">✓ 已解出</div>
        <button id="next-after-win">下一关 →</button>
      </div>
    </div>
  </main>
  <footer class="hint">方向键 / WASD 行动 · Z 撤销 · R 重开 · [ ] 切换关卡</footer>
`

const canvas = app.querySelector('#board') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
const tabsEl = app.querySelector('#tabs') as HTMLElement
const levelLabel = app.querySelector('#level-label') as HTMLElement
const moveLabel = app.querySelector('#move-label') as HTMLElement
const overlay = app.querySelector('#overlay') as HTMLElement
const nextAfterWin = app.querySelector('#next-after-win') as HTMLButtonElement
const hintEl = app.querySelector('#level-hint') as HTMLElement

const LOGICAL = 480

let current: Bundle = bundles.t3
let levels: LoadedLevel<any>[] = []
let index = 0
let hist: History<any> = new History(undefined)

function draw(): void {
  const dpr = window.devicePixelRatio || 1
  canvas.width = LOGICAL * dpr
  canvas.height = LOGICAL * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  current.render(hist.current, ctx, LOGICAL, LOGICAL)
}

function levelMeta(): { id?: string; name?: string; hint?: string } {
  return (levels[index]?.level ?? {}) as { id?: string; name?: string; hint?: string }
}

function updateHud(): void {
  const meta = levelMeta()
  const title = [meta.id, meta.name].filter(Boolean).join(' · ')
  levelLabel.textContent = levels.length > 0 ? `${index + 1}/${levels.length} ${title}` : '—'
  moveLabel.textContent = `步数 ${hist.depth}`
  // 关卡 hint（教学/点拨文案）：纯展示，有则显示，无则隐藏
  if (meta.hint) {
    hintEl.textContent = meta.hint
    hintEl.classList.remove('hidden')
  } else {
    hintEl.textContent = ''
    hintEl.classList.add('hidden')
  }
}

function showOverlay(): void {
  const isLast = index >= levels.length - 1
  nextAfterWin.textContent = isLast ? '已是最后一关 ⟳' : '下一关 →'
  overlay.classList.remove('hidden')
}

function hideOverlay(): void {
  overlay.classList.add('hidden')
}

function openLevel(i: number): void {
  index = Math.max(0, Math.min(i, levels.length - 1))
  hist = new History(current.def.initialState(levels[index].level))
  hideOverlay()
  draw()
  updateHud()
}

function loadGame(id: string): void {
  current = bundles[id]
  levels = loadLevels(filesFor(id), current.def.parseLevel)
  for (const btn of Array.from(tabsEl.children)) {
    ;(btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.game === id)
  }
  openLevel(0)
}

function applyDir(dir: Dir): void {
  const def = current.def
  const next = def.step(hist.current, dir)
  if (def.stateKey(next) === def.stateKey(hist.current)) return // 无效果，不入历史
  hist.push(next)
  draw()
  updateHud()
  if (def.isWin(next)) showOverlay()
}

function doUndo(): void {
  if (!hist.canUndo) return
  hist.undo()
  hideOverlay()
  draw()
  updateHud()
}

function restart(): void {
  openLevel(index)
}

function nextLevel(): void {
  if (index < levels.length - 1) openLevel(index + 1)
  else restart()
}

function prevLevel(): void {
  if (index > 0) openLevel(index - 1)
}

// 装饰开关（design §10 纪律：包装可用一个开关整体关掉，玩法信息不受影响）
let decorOn = true
function toggleDecor(): void {
  decorOn = !decorOn
  for (const b of Object.values(bundles)) b.setDecor?.(decorOn)
  const btn = app.querySelector('#decor') as HTMLButtonElement
  btn.textContent = decorOn ? '✦ 装饰 开' : '✦ 装饰 关'
  btn.classList.toggle('active', decorOn)
  draw()
}

// ---------- 事件 ----------

for (const b of Object.values(bundles)) {
  const btn = document.createElement('button')
  btn.textContent = b.label
  btn.dataset.game = b.id
  btn.addEventListener('click', () => loadGame(b.id))
  tabsEl.appendChild(btn)
}
;(app.querySelector('#prev') as HTMLButtonElement).addEventListener('click', prevLevel)
;(app.querySelector('#next') as HTMLButtonElement).addEventListener('click', nextLevel)
;(app.querySelector('#undo') as HTMLButtonElement).addEventListener('click', doUndo)
;(app.querySelector('#restart') as HTMLButtonElement).addEventListener('click', restart)
;(app.querySelector('#decor') as HTMLButtonElement).addEventListener('click', toggleDecor)
nextAfterWin.addEventListener('click', nextLevel)

window.addEventListener('keydown', (e) => {
  const dir = dirFromKey(e)
  if (dir) {
    e.preventDefault()
    if (!e.repeat) applyDir(dir)
    return
  }
  if (isUndoKey(e)) {
    e.preventDefault()
    doUndo()
    return
  }
  if (isRestartKey(e)) {
    e.preventDefault()
    restart()
    return
  }
  if (e.key === '[') prevLevel()
  else if (e.key === ']') nextLevel()
})

loadGame('t3')
