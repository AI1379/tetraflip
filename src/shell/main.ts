import './style.css'
import { dirFromKey, isRestartKey, isUndoKey } from '../core/keyboard'
import { loadLevels } from '../core/levels'
import type { LoadedLevel } from '../core/levels'
import { History } from '../core/undo'
import { solveFrom } from '../core/solver'
import { cellKey } from '../core/protocol'
import type { AnyGame, Dir } from '../core/protocol'
import { t3Game, render as renderT3, setT3Preview } from '../games/t3'
import {
  chemGame,
  render as renderChem,
  setChemDecor,
  notifyChemImpact,
  setChemPreview,
  setChemInspect,
  setChemMarks,
  chemHitTest,
} from '../games/chem'
import type { ChemMark } from '../games/chem'

/**
 * 浏览器壳：游戏切换、关卡导航、HUD、撤销/重开、画布宿主。
 * 这是唯一允许 any 的胶合层（桥接异构游戏类型），引擎保持严格类型。
 *
 * 认知外置层（design §11）在本层的落点：
 * - 输入模型：tap = 执行，hold ≥ HOLD_MS = 预演（预览 = 对当前局面求一次 step 交给渲染层画 ghost），
 *   松开 = 执行，Esc / 指针移开 = 取消；棋盘拖拽 = 实时预演。
 * - 标记模式（chem）：点按中心循环 ①–⑤，点按其他格循环 ★/？/×；按「游戏:关卡」存会话内。
 * - Inspect（chem）：点按中心显示构型周期面板（渲染层实现），6 秒自动收起、任何动作即收起。
 */

interface Bundle {
  id: string
  label: string
  def: AnyGame
  render: (state: any, ctx: CanvasRenderingContext2D, w: number, h: number) => void
  /** 装饰开关（design §10：包装可用一个开关整体关掉）；未实现则缺省 */
  setDecor?: (v: boolean) => void
  /** 无效输入反馈（step 无效果时调用）；未实现则缺省 */
  onBlocked?: (dir: Dir) => void
  /** 按住预演（design §11）：注入 / 清除 step(当前, 方向) 的 ghost 态；未实现则缺省 */
  setPreview?: (state: any | null) => void
  /** 是否支持玩家标记（design §11 层 ③）；当前仅 chem（t3 的记忆负担由时间线完整外置） */
  supportsMarks?: boolean
}

const bundles: Record<string, Bundle> = {
  t3: { id: 't3', label: 't+3', def: t3Game, render: renderT3, setPreview: setT3Preview },
  chem: {
    id: 'chem',
    label: '109.5°',
    def: chemGame,
    render: renderChem,
    setDecor: setChemDecor,
    onBlocked: notifyChemImpact,
    setPreview: setChemPreview,
    supportsMarks: true,
  },
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
  <header class="app-header">
    <div class="brand">
      <span class="brand-kicker">LEXIN LAB · PUZZLE PROTOTYPES</span>
      <strong>玩法实验室</strong>
    </div>
    <div class="header-tools">
      <div class="tabs" id="tabs" role="tablist" aria-label="切换游戏"></div>
      <button id="decor" class="icon-button active" title="切换棋盘装饰" aria-label="关闭棋盘装饰">✦</button>
    </div>
  </header>

  <section class="level-header" aria-label="关卡导航">
    <button id="prev" class="level-arrow" title="上一关 [" aria-label="上一关">←</button>
    <button id="levels-btn" class="level-identity" title="打开选关面板" aria-haspopup="dialog">
      <span id="level-number" class="level-number">LEVEL —</span>
      <span id="level-label" class="level-name">加载中</span>
      <span class="level-picker-cue">全部关卡⌄</span>
    </button>
    <button id="next" class="level-arrow" title="下一关 ]" aria-label="下一关">→</button>
  </section>

  <section id="status-bar" class="status-bar" aria-label="当前状态">
    <div class="stat">
      <span class="stat-label">行动</span>
      <strong id="move-label">0</strong>
    </div>
    <div id="game-stats" class="game-stats"></div>
  </section>

  <details id="level-brief" class="level-brief" open>
    <summary>
      <span class="brief-mark">?</span>
      <span id="brief-label">本关提示</span>
      <span class="brief-toggle" aria-hidden="true"></span>
    </summary>
    <p id="level-hint"></p>
    <div id="mechanic-note" class="mechanic-note hidden">
      <strong>染色 = 交换 + 翻转</strong>
      <span><i class="flow-dot carried"></i>手中色珠 → 进入中心，并随中心翻转</span>
      <span><i class="flow-dot extracted"></i>开口臂原来的色珠 → 换到手中</span>
      <small>持珠站到正确进攻位时，棋盘上的彩色光环会预览落点。</small>
    </div>
  </details>

  <main class="stage">
    <canvas id="board" aria-label="游戏棋盘，支持方向滑动"></canvas>
    <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
    <div id="overlay" class="overlay hidden" aria-hidden="true">
      <div class="overlay-card">
        <div class="win-mark"><span>✓</span> 关卡完成</div>
        <strong id="win-title" class="win-title"></strong>
        <div id="win-stats" class="win-stats"></div>
        <div class="win-actions">
          <button id="replay-after-win" class="secondary-button">再玩一次</button>
          <button id="next-after-win" class="primary-button">下一关 →</button>
        </div>
      </div>
    </div>
  </main>

  <section class="controls" aria-label="游戏操作">
    <div class="utility-actions">
      <button id="undo" class="control-button" title="撤销 (Z)">
        <span class="control-icon">↶</span><span>撤销</span>
      </button>
      <button id="restart" class="control-button" title="重开 (R)">
        <span class="control-icon">↻</span><span>重开</span>
      </button>
      <button id="mark-mode" class="control-button hidden" title="标记模式 (M)：点按中心放 ①–⑤ 顺序标，点按格子放 ★/？/×">
        <span class="control-icon">✎</span><span>标记</span>
      </button>
    </div>
    <div class="dpad" role="group" aria-label="方向控制">
      <button class="dpad-key north" data-dir="N" aria-label="向上">↑</button>
      <button class="dpad-key west" data-dir="W" aria-label="向左">←</button>
      <span class="dpad-core" aria-hidden="true"></span>
      <button class="dpad-key east" data-dir="E" aria-label="向右">→</button>
      <button class="dpad-key south" data-dir="S" aria-label="向下">↓</button>
    </div>
    <button id="hint" class="control-button hint-button" title="下一步提示 (H)：不限次数">
      <span class="control-icon">◇</span><span>提示一步</span>
    </button>
  </section>

  <footer class="shortcut-hint">方向键 / WASD 移动 · 长按预演（松开执行，Esc 取消） · Z 撤销 · R 重开 · H 提示 · M 标记</footer>

  <div id="picker-backdrop" class="picker-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="picker-title">
    <section class="picker-panel">
      <header class="picker-header">
        <div><span class="brand-kicker">LEVEL SELECT</span><strong id="picker-title">选择关卡</strong></div>
        <button id="picker-close" class="icon-button" aria-label="关闭选关面板">×</button>
      </header>
      <div id="level-picker" class="level-picker"></div>
    </section>
  </div>
`

const canvas = app.querySelector('#board') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
const tabsEl = app.querySelector('#tabs') as HTMLElement
const levelNumber = app.querySelector('#level-number') as HTMLElement
const levelLabel = app.querySelector('#level-label') as HTMLElement
const moveLabel = app.querySelector('#move-label') as HTMLElement
const gameStats = app.querySelector('#game-stats') as HTMLElement
const overlay = app.querySelector('#overlay') as HTMLElement
const winTitle = app.querySelector('#win-title') as HTMLElement
const winStats = app.querySelector('#win-stats') as HTMLElement
const nextAfterWin = app.querySelector('#next-after-win') as HTMLButtonElement
const replayAfterWin = app.querySelector('#replay-after-win') as HTMLButtonElement
const hintEl = app.querySelector('#level-hint') as HTMLElement
const briefEl = app.querySelector('#level-brief') as HTMLDetailsElement
const briefLabel = app.querySelector('#brief-label') as HTMLElement
const mechanicNote = app.querySelector('#mechanic-note') as HTMLElement
const toastEl = app.querySelector('#toast') as HTMLElement
const pickerEl = app.querySelector('#level-picker') as HTMLElement
const pickerBackdrop = app.querySelector('#picker-backdrop') as HTMLElement
const levelsBtn = app.querySelector('#levels-btn') as HTMLButtonElement
const decorBtn = app.querySelector('#decor') as HTMLButtonElement
const prevBtn = app.querySelector('#prev') as HTMLButtonElement
const nextBtn = app.querySelector('#next') as HTMLButtonElement
const undoBtn = app.querySelector('#undo') as HTMLButtonElement
const markBtn = app.querySelector('#mark-mode') as HTMLButtonElement

const LOGICAL = 480

let current: Bundle = bundles.t3
let levels: LoadedLevel<any>[] = []
let index = 0
let hist: History<any> = new History(undefined)
const completed = new Set<string>()
const gameIndices: Record<string, number> = { t3: 0, chem: 0 }

// ---------- 认知外置层（design §11）：预演 / 标记 / Inspect 的壳层状态 ----------

/** 按住预演的最小停留时间（毫秒）：≤ 阈值视为快速点按（松开即执行），超过进入预演 */
const HOLD_MS = 280
/** 当前「按住待执行」的方向；预演态 = step(当前, pending.dir) 由渲染层画 ghost */
let pending: { dir: Dir; downAt: number; previewing: boolean } | null = null

/** 标记模式（仅 chem）；标记按「游戏:关卡」存会话内，撤销 / 重开不丢失 */
let markMode = false
const marksStore = new Map<string, Map<string, ChemMark>>()
let currentMarks = new Map<string, ChemMark>()
const CENTER_MARK_CYCLE: ChemMark[] = ['1', '2', '3', '4', '5']
const CELL_MARK_CYCLE: ChemMark[] = ['star', 'question', 'cross']

/** Inspect 面板自动收起计时（6 秒） */
let inspectTimer: ReturnType<typeof setTimeout> | null = null

const COLOR_TEXT: Record<string, string> = {
  red: '红',
  blue: '蓝',
  green: '绿',
  yellow: '黄',
  purple: '紫',
}

function draw(): void {
  const dpr = window.devicePixelRatio || 1
  const size = Math.round(LOGICAL * dpr)
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size
    canvas.height = size
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  current.render(hist.current, ctx, LOGICAL, LOGICAL)
}

// 渲染循环：补间动画 / 背景自转 / 无效进攻反馈需要连续重绘（棋盘小，开销可忽略）；
// 同时驱动「按住预演」：按住超过 HOLD_MS 注入一步预演态（design §11）。
function frame(): void {
  if (pending && !pending.previewing && performance.now() - pending.downAt >= HOLD_MS) {
    pending.previewing = true
    showPreview(pending.dir)
  }
  draw()
  requestAnimationFrame(frame)
}

function levelMeta(): { id?: string; name?: string; hint?: string } {
  return (levels[index]?.level ?? {}) as { id?: string; name?: string; hint?: string }
}

function appendStat(label: string, value: string, tone?: string): void {
  const item = document.createElement('div')
  item.className = 'stat'
  const key = document.createElement('span')
  key.className = 'stat-label'
  key.textContent = label
  const strong = document.createElement('strong')
  strong.textContent = value
  if (tone) strong.dataset.tone = tone
  item.append(key, strong)
  gameStats.appendChild(item)
}

function updateHud(): void {
  const meta = levelMeta()
  const rawLevel = (levels[index]?.level ?? {}) as { groups?: readonly unknown[] }
  const hasColoring = current.id === 'chem' && (rawLevel.groups?.length ?? 0) > 0
  levelNumber.textContent = levels.length > 0
    ? `LEVEL ${String(index + 1).padStart(2, '0')} / ${String(levels.length).padStart(2, '0')}`
    : 'LEVEL —'
  levelLabel.textContent = meta.name ?? meta.id ?? '未命名关卡'
  moveLabel.textContent = String(hist.depth).padStart(2, '0')
  gameStats.innerHTML = ''

  if (current.id === 'chem') {
    const s = hist.current as {
      par?: number
      holding: string | null
      stage: number
      stages: readonly { goals: readonly { center: number; arm: Dir; color: string }[] }[]
      centers: readonly { arms: Partial<Record<Dir, string>> }[]
    }
    if (s.par !== undefined) appendStat('标准', String(s.par).padStart(2, '0'))
    if (s.stages.length > 1) {
      appendStat('阶段', `${Math.min(s.stage + 1, s.stages.length)} / ${s.stages.length}`)
    }
    const activeGoals = s.stages[s.stage]?.goals ?? []
    const matched = activeGoals.filter((g) => s.centers[g.center]?.arms[g.arm] === g.color).length
    appendStat('目标', `${matched} / ${activeGoals.length}`)
    appendStat('手持', s.holding === null ? '空' : COLOR_TEXT[s.holding] ?? s.holding, s.holding ?? 'empty')
  } else {
    const s = hist.current as { echoes: readonly { delay: number }[] }
    appendStat('回声', String(s.echoes.length))
    appendStat('最长延迟', `${Math.max(0, ...s.echoes.map((e) => e.delay))} 拍`)
  }

  prevBtn.disabled = index <= 0
  nextBtn.disabled = index >= levels.length - 1
  undoBtn.disabled = !hist.canUndo
  decorBtn.classList.toggle('hidden', current.setDecor === undefined)
  mechanicNote.classList.toggle('hidden', !hasColoring)
  briefLabel.textContent = hasColoring ? '本关提示 · 染色规则' : '本关提示'

  // 关卡 hint（教学/点拨文案）：纯展示，有则显示，无则隐藏
  if (meta.hint) {
    hintEl.textContent = meta.hint
    briefEl.classList.remove('hidden')
  } else {
    hintEl.textContent = ''
    briefEl.classList.add('hidden')
  }
}

function showOverlay(): void {
  const isLast = index >= levels.length - 1
  completed.add(`${current.id}:${index}`)
  const meta = levelMeta()
  const s = hist.current as { moves?: number; par?: number }
  const moves = s.moves ?? hist.depth
  let result = `${moves} 步完成`
  if (current.id === 'chem' && s.par !== undefined) {
    const stars = moves <= s.par ? '★★★' : moves <= s.par + 3 ? '★★☆' : '★☆☆'
    result = `${stars} · ${moves} 步 / 标准 ${s.par}`
  }
  winTitle.textContent = meta.name ?? meta.id ?? `第 ${index + 1} 关`
  winStats.textContent = result
  nextAfterWin.textContent = isLast ? '回到本关' : '下一关 →'
  overlay.classList.remove('hidden')
  overlay.setAttribute('aria-hidden', 'false')
  nextAfterWin.focus()
}

function hideOverlay(): void {
  overlay.classList.add('hidden')
  overlay.setAttribute('aria-hidden', 'true')
}

function openLevel(i: number): void {
  index = Math.max(0, Math.min(i, levels.length - 1))
  if (current.id === 'chem' && index === 10 && !completed.has('chem:10')) briefEl.open = true
  hist = new History(current.def.initialState(levels[index].level))
  cancelPending()
  setChemInspect(null)
  clearInspectTimer()
  loadMarks()
  setChemMarks(current.id === 'chem' ? currentMarks : null)
  hideOverlay()
  hideToast()
  closePicker()
  draw()
  updateHud()
}

function loadGame(id: string): void {
  gameIndices[current.id] = index
  current = bundles[id]
  app.dataset.game = id
  levels = loadLevels(filesFor(id), current.def.parseLevel)
  // 切游戏：清掉两个游戏的预演 / Inspect 瞬态，退出标记模式
  for (const b of Object.values(bundles)) b.setPreview?.(null)
  setChemInspect(null)
  clearInspectTimer()
  setMarkMode(false)
  markBtn.classList.toggle('hidden', current.supportsMarks !== true)
  for (const btn of Array.from(tabsEl.children)) {
    const tab = btn as HTMLButtonElement
    const active = tab.dataset.game === id
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', String(active))
  }
  closePicker()
  openLevel(gameIndices[id] ?? 0)
}

function applyDir(dir: Dir): void {
  const def = current.def
  const next = def.step(hist.current, dir)
  if (def.stateKey(next) === def.stateKey(hist.current)) {
    current.onBlocked?.(dir) // 无效果输入：交给游戏渲染层做反馈（抖动/红闪）
    return
  }
  setChemInspect(null) // 局面已变：Inspect 面板收起（design §11）
  clearInspectTimer()
  hist.push(next)
  draw()
  updateHud()
  if (def.isWin(next)) showOverlay()
}

function doUndo(): void {
  if (!hist.canUndo) return
  hist.undo()
  setChemInspect(null)
  clearInspectTimer()
  hideOverlay()
  draw()
  updateHud()
}

function restart(): void {
  openLevel(index)
}

function nextLevel(): void {
  if (index < levels.length - 1) openLevel(index + 1)
}

function prevLevel(): void {
  if (index > 0) openLevel(index - 1)
}

// ---------- 输入模型（design §11）：tap=执行 / hold=预演 / 松开=执行 / Esc=取消 ----------
// 预演 = 壳层对当前局面求一次 step 后把 ghost 态交给渲染层；不碰任何游戏规则。

/** 计算并注入一步预演态；无效果动作（stateKey 不变）不画 ghost */
function showPreview(dir: Dir): void {
  const def = current.def
  if (def.isWin(hist.current)) return
  const next = def.step(hist.current, dir)
  if (def.stateKey(next) === def.stateKey(hist.current)) {
    current.setPreview?.(null)
  } else {
    current.setPreview?.(next)
  }
}

function clearPreview(): void {
  current.setPreview?.(null)
}

/** 方向按下：若正按住别的方向，先提交它（换键滚动），再开始新的等待 */
function dirDown(dir: Dir): void {
  if (!overlay.classList.contains('hidden')) return // 胜利面板显示时不吃方向输入
  if (pending && pending.dir === dir) return // 键盘连发（repeat）忽略
  if (pending && pending.dir !== dir) commitPending()
  if (!overlay.classList.contains('hidden')) return // 提交可能刚好通关
  pending = { dir, downAt: performance.now(), previewing: false }
}

/** 方向松开：快速点按直接执行；已预演则「松开即执行」 */
function dirUp(dir: Dir): void {
  if (!pending || pending.dir !== dir) return
  commitPending()
}

/** 提交当前按住的方向（执行一步）并清掉预演态 */
function commitPending(): void {
  if (!pending) return
  const dir = pending.dir
  pending = null
  clearPreview()
  hideToast()
  applyDir(dir)
}

/** 取消预演，不执行（Esc / 指针移开 / 切到别的动作） */
function cancelPending(): void {
  pending = null
  clearPreview()
}

// ---------- Inspect（chem）：点按中心看构型周期，纯展示 ----------

function clearInspectTimer(): void {
  if (inspectTimer !== null) {
    clearTimeout(inspectTimer)
    inspectTimer = null
  }
}

function startInspect(centerIndex: number): void {
  setChemInspect(centerIndex)
  clearInspectTimer()
  inspectTimer = setTimeout(() => {
    setChemInspect(null)
    inspectTimer = null
  }, 6000)
}

// ---------- 标记（chem，design §11 层 ③）：游戏只提供外部工作记忆，不解释含义 ----------

function marksKey(): string {
  const meta = levelMeta()
  return `${current.id}:${meta.id ?? index}`
}

function loadMarks(): void {
  const key = marksKey()
  currentMarks = marksStore.get(key) ?? new Map()
  marksStore.set(key, currentMarks)
}

function setMarkMode(on: boolean): void {
  markMode = on && current.supportsMarks === true
  markBtn.classList.toggle('active', markMode)
  markBtn.title = markMode
    ? '标记模式开 (M)：点按中心 ①–⑤ / 点按格子 ★？× · 再按 M 退出'
    : '标记模式 (M)：点按中心放 ①–⑤ 顺序标，点按格子放 ★/？/×'
  markBtn.setAttribute('aria-pressed', String(markMode))
}

function toggleMarkMode(): void {
  if (current.supportsMarks !== true) return
  setMarkMode(!markMode)
}

/** 点按一个中心 / 格子：沿各自的轻量循环推进一格（再点一圈清除） */
function cycleMark(hit: { kind: 'center'; index: number } | { kind: 'cell'; x: number; y: number }): void {
  const s = hist.current as { centers?: readonly { pos: readonly [number, number] }[] }
  let key: string
  let cycle: ChemMark[]
  if (hit.kind === 'center') {
    const c = s.centers?.[hit.index]
    if (!c) return
    key = cellKey(c.pos[0], c.pos[1])
    cycle = CENTER_MARK_CYCLE
  } else {
    key = cellKey(hit.x, hit.y)
    cycle = CELL_MARK_CYCLE
  }
  const cur = currentMarks.get(key)
  const idx = cur === undefined ? -1 : cycle.indexOf(cur)
  if (idx === -1) {
    currentMarks.set(key, cycle[0])
  } else if (idx === cycle.length - 1) {
    currentMarks.delete(key)
  } else {
    currentMarks.set(key, cycle[idx + 1])
  }
  setChemMarks(currentMarks)
  draw()
}

/** 棋盘点按（位移 < 24px）：标记模式改标记；否则中心 = Inspect，空格 = 收起 Inspect */
function handleCanvasTap(clientX: number, clientY: number): void {
  if (current.id !== 'chem') return
  const rect = canvas.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  const lx = (clientX - rect.left) * (LOGICAL / rect.width)
  const ly = (clientY - rect.top) * (LOGICAL / rect.height)
  const hit = chemHitTest(hist.current as any, lx, ly, LOGICAL, LOGICAL)
  if (!hit) {
    setChemInspect(null)
    clearInspectTimer()
    return
  }
  if (markMode) {
    cycleMark(hit)
    return
  }
  if (hit.kind === 'center') {
    startInspect(hit.index)
  } else {
    setChemInspect(null)
    clearInspectTimer()
  }
}

// ---------- 选关面板：当前游戏全部关卡一屏可选（替代一关关按 ▶） ----------

function buildPicker(): void {
  pickerEl.innerHTML = ''
  levels.forEach((l, i) => {
    const meta = l.level as { id?: string; name?: string }
    const btn = document.createElement('button')
    const isComplete = completed.has(`${current.id}:${i}`)
    btn.className = ['level-item', i === index ? 'active' : '', isComplete ? 'complete' : '']
      .filter(Boolean)
      .join(' ')
    const number = document.createElement('span')
    number.className = 'level-item-number'
    number.textContent = String(i + 1).padStart(2, '0')
    const name = document.createElement('span')
    name.className = 'level-item-name'
    name.textContent = meta.name ?? meta.id ?? ''
    const mark = document.createElement('span')
    mark.className = 'level-item-mark'
    mark.textContent = isComplete ? '✓' : '→'
    btn.append(number, name, mark)
    btn.title = meta.id ?? ''
    btn.addEventListener('click', () => {
      openLevel(i)
      closePicker()
    })
    pickerEl.appendChild(btn)
  })
}

function openPicker(): void {
  buildPicker()
  pickerBackdrop.classList.remove('hidden')
  document.body.classList.add('modal-open')
  ;(pickerEl.querySelector('.level-item.active') as HTMLButtonElement | null)?.focus()
}

function closePicker(): void {
  pickerBackdrop.classList.add('hidden')
  document.body.classList.remove('modal-open')
}

function togglePicker(): void {
  if (pickerBackdrop.classList.contains('hidden')) openPicker()
  else closePicker()
}

// 装饰开关（design §10 纪律：包装可用一个开关整体关掉，玩法信息不受影响）
let decorOn = true
function toggleDecor(): void {
  decorOn = !decorOn
  for (const b of Object.values(bundles)) b.setDecor?.(decorOn)
  decorBtn.textContent = decorOn ? '✦' : '·'
  decorBtn.classList.toggle('active', decorOn)
  decorBtn.title = decorOn ? '关闭棋盘装饰' : '恢复棋盘装饰'
  decorBtn.setAttribute('aria-label', decorBtn.title)
  draw()
}

// ---------- solver 提示（design §10「玩家辅助」：从当前局面实时求解，不写手打攻略） ----------

const DIR_TEXT: Record<string, string> = {
  N: '↑（上）',
  E: '→（右）',
  S: '↓（下）',
  W: '←（左）',
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
function toast(msg: string, ms = 5000): void {
  toastEl.textContent = msg
  toastEl.classList.remove('hidden')
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms)
}
function hideToast(): void {
  toastEl.classList.add('hidden')
  if (toastTimer !== null) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
}

function showHint(): void {
  if (current.def.isWin(hist.current)) {
    toast('这关已经解出来了！按 ] 或「下一关」继续。')
    return
  }
  // 从当前局面跑通用 BFS（与入库关卡验证同一个 solver），取最短解的第一步
  const r = solveFrom(current.def, hist.current, { maxDepth: 30 })
  if (r.solved && r.solution.length > 0) {
    toast(`下一步：${DIR_TEXT[r.solution[0]] ?? r.solution[0]} · 距通关还有 ${r.solution.length} 步（最短路线）`)
  } else if (!r.solved && !r.truncated) {
    // 搜索空间穷尽仍无解 = 当前局面真的走不通了（比如扔掉了必需的珠子）
    toast('这个局面已经走不通了。↩ 撤销 (Z) 回退几步，或 ⟳ 重开 (R)。')
  } else {
    const meta = levelMeta()
    toast(meta.hint ? `提示：${meta.hint}` : '再想想——开口的对面就是进攻的位置。')
  }
}

// ---------- 事件 ----------

for (const b of Object.values(bundles)) {
  const btn = document.createElement('button')
  btn.textContent = b.label
  btn.dataset.game = b.id
  btn.setAttribute('role', 'tab')
  btn.setAttribute('aria-selected', 'false')
  btn.addEventListener('click', () => loadGame(b.id))
  tabsEl.appendChild(btn)
}
prevBtn.addEventListener('click', () => {
  cancelPending()
  prevLevel()
})
nextBtn.addEventListener('click', () => {
  cancelPending()
  nextLevel()
})
undoBtn.addEventListener('click', () => {
  cancelPending()
  doUndo()
})
;(app.querySelector('#restart') as HTMLButtonElement).addEventListener('click', () => {
  cancelPending()
  restart()
})
decorBtn.addEventListener('click', toggleDecor)
;(app.querySelector('#hint') as HTMLButtonElement).addEventListener('click', () => {
  cancelPending()
  showHint()
})
levelsBtn.addEventListener('click', togglePicker)
;(app.querySelector('#picker-close') as HTMLButtonElement).addEventListener('click', closePicker)
pickerBackdrop.addEventListener('click', (e) => {
  if (e.target === pickerBackdrop) closePicker()
})
nextAfterWin.addEventListener('click', () => {
  if (index >= levels.length - 1) restart()
  else nextLevel()
})
replayAfterWin.addEventListener('click', restart)

// 触屏方向键（design §11 输入模型）：按下开始计时，松开 = 执行；指针移开按钮 = 取消。
// 键盘可达性：Enter/Space 触发的 click（无 pointerdown 前置）直接执行。
const dpadPointerAt = new WeakMap<HTMLButtonElement, number>()
for (const btn of app.querySelectorAll<HTMLButtonElement>('.dpad-key')) {
  const dir = btn.dataset.dir as Dir
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    btn.setPointerCapture(e.pointerId)
    dpadPointerAt.set(btn, performance.now())
    dirDown(dir)
  })
  btn.addEventListener('pointerup', (e) => {
    const r = btn.getBoundingClientRect()
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (inside) dirUp(dir) // 松开 = 执行
    else cancelPending() // 移开 = 取消（不执行）
  })
  btn.addEventListener('pointercancel', cancelPending)
  btn.addEventListener('click', () => {
    // pointer 路径已经处理过（600ms 内）则跳过；否则视为键盘激活，直接执行
    const at = dpadPointerAt.get(btn) ?? 0
    if (performance.now() - at < 600) return
    hideToast()
    applyDir(dir)
  })
}

// 触屏棋盘（design §11）：拖拽 ≥ 24px = 实时预演（随手指变向），松开执行；
// 拖回起点 < 24px = 取消；位移 < 24px 的轻点 = Inspect / 标记。
let swipeStart: { x: number; y: number; pointerId: number; engaged: boolean } | null = null

function swipeDir(dx: number, dy: number): Dir | null {
  if (Math.min(Math.abs(dx), Math.abs(dy)) > Math.max(Math.abs(dx), Math.abs(dy)) * 0.75) return null
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : dy > 0 ? 'S' : 'N'
}

canvas.addEventListener('pointerdown', (e) => {
  swipeStart = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, engaged: false }
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  if (!swipeStart || swipeStart.pointerId !== e.pointerId) return
  const dx = e.clientX - swipeStart.x
  const dy = e.clientY - swipeStart.y
  if (Math.hypot(dx, dy) < 24) {
    // 拖回起点附近：若之前已预演，取消
    if (swipeStart.engaged) {
      swipeStart.engaged = false
      cancelPending()
    }
    return
  }
  const dir = swipeDir(dx, dy)
  if (!dir) return // 斜滑：保持既有方向
  swipeStart.engaged = true
  if (!pending || pending.dir !== dir) {
    // 变向 = 替换意图（不提交旧方向）；拖拽预演立即生效，不等 HOLD_MS
    pending = { dir, downAt: performance.now(), previewing: true }
    showPreview(dir)
  }
})
canvas.addEventListener('pointerup', (e) => {
  if (!swipeStart || swipeStart.pointerId !== e.pointerId) return
  const start = swipeStart
  swipeStart = null
  const dx = e.clientX - start.x
  const dy = e.clientY - start.y
  const distance = Math.hypot(dx, dy)
  if (start.engaged && distance >= 24 && pending) {
    hideToast()
    dirUp(pending.dir) // 松开 = 执行
    return
  }
  if (start.engaged) {
    cancelPending() // 拖回起点 = 取消
    return
  }
  handleCanvasTap(e.clientX, e.clientY) // 轻点：Inspect / 标记
})
canvas.addEventListener('pointercancel', () => {
  swipeStart = null
  cancelPending()
})

markBtn.addEventListener('click', toggleMarkMode)

window.addEventListener('keydown', (e) => {
  if (!pickerBackdrop.classList.contains('hidden')) {
    if (e.key === 'Escape') closePicker()
    return
  }
  const dir = dirFromKey(e)
  if (dir) {
    e.preventDefault()
    if (!e.repeat) dirDown(dir)
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    if (pending) {
      cancelPending() // 预演中：Esc 只取消预演，不执行
      return
    }
    closePicker()
    hideOverlay()
    return
  }
  if (isUndoKey(e)) {
    e.preventDefault()
    hideToast()
    cancelPending()
    doUndo()
    return
  }
  if (isRestartKey(e)) {
    e.preventDefault()
    hideToast()
    cancelPending()
    restart()
    return
  }
  if (e.key === 'h' || e.key === 'H') {
    e.preventDefault()
    cancelPending()
    showHint()
    return
  }
  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault()
    cancelPending()
    toggleMarkMode()
    return
  }
  if (e.key === '[') {
    cancelPending()
    prevLevel()
  } else if (e.key === ']') {
    cancelPending()
    nextLevel()
  }
})

// 方向键松开：快速点按 / 预演后的「松开即执行」
window.addEventListener('keyup', (e) => {
  const dir = dirFromKey(e)
  if (dir) {
    e.preventDefault()
    dirUp(dir)
  }
})

// 失焦：清掉按住状态，避免回来后误执行
window.addEventListener('blur', cancelPending)

loadGame('t3')
requestAnimationFrame(frame)
