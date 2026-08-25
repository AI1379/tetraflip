import './style.css'
import { dirFromKey, isRestartKey, isUndoKey } from '../core/keyboard'
import { loadLevels } from '../core/levels'
import type { LoadedLevel } from '../core/levels'
import { History } from '../core/undo'
import { solveFrom } from '../core/solver'
import { DIR_VEC, cellKey } from '../core/protocol'
import type { AnyGame, Dir } from '../core/protocol'
import { t3Game, render as renderT3, setT3Preview } from '../games/t3'
import {
  chemGame,
  render as renderChem,
  setChemDecor,
  notifyChemImpact,
  resetChemAnim,
  getChemAnimationRemainingMs,
  setChemPreview,
  setChemInspect,
  setChemMarks,
  chemHitTest,
} from '../games/chem'
import type { ChemMark } from '../games/chem'
import {
  getChemTutorial,
  initialTutorialInputMode,
  tutorialColorText,
  tutorialDirText,
  tutorialInputModeFromPointerType,
  tutorialKeyForDir,
} from './tutorial'
import type { TutorialEvent, TutorialInputMode } from './tutorial'
import { mountFeedback } from './feedback'
import { logicalCanvasSize } from './viewport'
import {
  addCompleted,
  emptyProgress,
  loadProgress,
  saveProgress,
  setCurrentLevel,
} from './progress'

/**
 * 《109.5°》正式浏览器壳：关卡导航、HUD、撤销/重开、画布宿主。
 * `t+3` 仅作为研发档保留，可用显式 ?game=t3 进入；正常提交入口不显示原型切换。
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
  /** 换关 / 重开时重置渲染层动画状态；未实现则缺省 */
  resetAnim?: () => void
  /** 当前棋盘动画还需多久结束；通关卡片据此避让终局反馈 */
  animationRemainingMs?: () => number
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
    resetAnim: resetChemAnim,
    animationRemainingMs: getChemAnimationRemainingMs,
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
const searchParams = new URLSearchParams(window.location.search)
const visualBlindMode = searchParams.get('blind') === '1'
const showPrototypeSwitcher = searchParams.get('devGames') === '1'
app.innerHTML = `
  <header class="app-header">
    <div class="brand">
      <span class="brand-kicker">LEXIN GAMES · STRUCTURAL PUZZLE</span>
      <strong>109.5°</strong>
    </div>
    <div class="header-tools">
      <div class="tabs ${showPrototypeSwitcher ? '' : 'hidden'}" id="tabs" role="tablist" aria-label="研发原型切换"></div>
      <button id="decor" class="icon-button active" title="切换棋盘装饰" aria-label="关闭棋盘装饰"><span class="decor-glyph" aria-hidden="true"></span></button>
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
      <span>本关提示</span>
      <span class="brief-toggle" aria-hidden="true"></span>
    </summary>
    <p id="level-hint"></p>
  </details>

  <main class="stage">
    <canvas id="board" aria-label="游戏棋盘，支持方向滑动"></canvas>
    <div id="board-guide" class="board-guide hidden" aria-live="polite">
      <div id="guide-spotlight" class="guide-spotlight hidden" aria-hidden="true"></div>
      <div id="guide-gesture" class="guide-gesture hidden" aria-hidden="true">
        <span class="gesture-track"></span>
        <span class="gesture-finger"><i></i></span>
      </div>
      <div id="guide-key" class="guide-key hidden" aria-hidden="true">
        <kbd id="guide-key-label">S</kbd>
        <span id="guide-key-action">PRESS</span>
      </div>
      <section class="board-guide-card" aria-label="操作引导">
        <small id="tutorial-kicker">CORE INPUT · 01 / 05</small>
        <strong id="tutorial-title"></strong>
        <p id="tutorial-body"></p>
        <div id="tutorial-forecast" class="tutorial-forecast hidden" aria-label="本次进攻的交换预报">
          <div class="forecast-row">
            <span class="forecast-label inject">放入</span>
            <i id="forecast-in-dot" class="forecast-dot" aria-hidden="true"></i>
            <strong id="forecast-in-color"></strong>
            <span id="forecast-in-target" class="forecast-target"></span>
          </div>
          <div id="forecast-out-row" class="forecast-row">
            <span class="forecast-label extract">换出</span>
            <i id="forecast-out-dot" class="forecast-dot" aria-hidden="true"></i>
            <strong id="forecast-out-color"></strong>
            <span class="forecast-target">→ 手中</span>
          </div>
        </div>
        <div id="tutorial-feedback" class="tutorial-feedback hidden" role="status"></div>
        <span id="tutorial-tip" class="tutorial-tip"></span>
      </section>
    </div>
    <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
    <div id="overlay" class="overlay hidden" aria-hidden="true">
      <div class="overlay-card">
        <div class="win-mark"><span>✓</span> 关卡完成</div>
        <strong id="win-title" class="win-title"></strong>
        <div id="win-stats" class="win-stats"></div>
        <div id="feedback-panel" class="feedback-panel hidden"></div>
        <div class="win-actions">
          <button id="replay-after-win" class="secondary-button">再玩一次</button>
          <button id="view-after-win" class="secondary-button">查看棋盘</button>
          <button id="next-after-win" class="primary-button">下一关 →</button>
        </div>
      </div>
    </div>
    <div id="winbar" class="winbar hidden" aria-live="polite">
      <span id="winbar-text" class="winbar-text"></span>
      <button id="winbar-replay" class="secondary-button">再玩一次</button>
      <button id="winbar-next" class="primary-button">下一关 →</button>
      <button id="winbar-close" class="winbar-close" title="关闭通关栏" aria-label="关闭通关栏">✕</button>
    </div>
  </main>

  <section class="controls" aria-label="游戏操作">
    <div class="utility-actions">
      <button id="undo" class="control-button" title="撤销 (Z)">
        <span class="control-icon icon-undo" aria-hidden="true"></span><span>撤销</span>
      </button>
      <button id="restart" class="control-button" title="重开 (R)">
        <span class="control-icon icon-restart" aria-hidden="true"></span><span>重开</span>
      </button>
      <button id="mark-mode" class="control-button hidden" title="标记模式 (M)：点按中心放 ①–⑤ 顺序标，点按格子放 ★/？/×">
        <span class="control-icon icon-mark" aria-hidden="true"></span><span>标记</span>
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
      <span class="control-icon icon-hint" aria-hidden="true"></span><span>提示一步</span>
    </button>
  </section>

  <footer class="app-footer">
    <div class="shortcut-hint">方向键 / WASD 移动 · 长按预演（松开执行，Esc 取消） · Z 撤销 · R 重开 · H 提示 · M 标记</div>
    <div class="copyright">© 2026 <a href="https://github.com/AI1379" target="_blank" rel="noopener noreferrer" aria-label="Renatus Madrigal 的 GitHub 主页">Renatus Madrigal</a></div>
  </footer>

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
app.classList.toggle('visual-blind', visualBlindMode)

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
const feedbackPanel = app.querySelector('#feedback-panel') as HTMLElement
const nextAfterWin = app.querySelector('#next-after-win') as HTMLButtonElement
const replayAfterWin = app.querySelector('#replay-after-win') as HTMLButtonElement
const viewAfterWin = app.querySelector('#view-after-win') as HTMLButtonElement
const winbar = app.querySelector('#winbar') as HTMLElement
const winbarText = app.querySelector('#winbar-text') as HTMLElement
const winbarReplay = app.querySelector('#winbar-replay') as HTMLButtonElement
const winbarNext = app.querySelector('#winbar-next') as HTMLButtonElement
const winbarClose = app.querySelector('#winbar-close') as HTMLButtonElement
const hintEl = app.querySelector('#level-hint') as HTMLElement
const briefEl = app.querySelector('#level-brief') as HTMLDetailsElement
const boardGuide = app.querySelector('#board-guide') as HTMLElement
const guideSpotlight = app.querySelector('#guide-spotlight') as HTMLElement
const guideGesture = app.querySelector('#guide-gesture') as HTMLElement
const guideKey = app.querySelector('#guide-key') as HTMLElement
const guideKeyLabel = app.querySelector('#guide-key-label') as HTMLElement
const guideKeyAction = app.querySelector('#guide-key-action') as HTMLElement
const tutorialKicker = app.querySelector('#tutorial-kicker') as HTMLElement
const tutorialTitle = app.querySelector('#tutorial-title') as HTMLElement
const tutorialBody = app.querySelector('#tutorial-body') as HTMLElement
const tutorialForecast = app.querySelector('#tutorial-forecast') as HTMLElement
const forecastInDot = app.querySelector('#forecast-in-dot') as HTMLElement
const forecastInColor = app.querySelector('#forecast-in-color') as HTMLElement
const forecastInTarget = app.querySelector('#forecast-in-target') as HTMLElement
const forecastOutRow = app.querySelector('#forecast-out-row') as HTMLElement
const forecastOutDot = app.querySelector('#forecast-out-dot') as HTMLElement
const forecastOutColor = app.querySelector('#forecast-out-color') as HTMLElement
const tutorialFeedback = app.querySelector('#tutorial-feedback') as HTMLElement
const tutorialTip = app.querySelector('#tutorial-tip') as HTMLElement
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

let current: Bundle = bundles.chem
let levels: LoadedLevel<any>[] = []
let index = 0
let hist: History<any> = new History(undefined)
const progressStore = (() => {
  try {
    return window.localStorage
  } catch {
    return null
  }
})()
const savedProgress = progressStore ? loadProgress(progressStore) : emptyProgress()
const completed = new Set<string>(savedProgress.completed)
const gameIndices: Record<string, number> = {
  t3: savedProgress.current.t3 ?? 0,
  chem: savedProgress.current.chem ?? 0,
}
let progress = savedProgress

function persistProgress(): void {
  if (progressStore) saveProgress(progressStore, progress)
}
let tutorialInputMode: TutorialInputMode = initialTutorialInputMode({
  coarsePrimaryPointer: window.matchMedia('(pointer: coarse)').matches,
  maxTouchPoints: navigator.maxTouchPoints,
})
app.dataset.inputMode = tutorialInputMode

// ---------- 认知外置层（design §11）：预演 / 标记 / Inspect 的壳层状态 ----------

/** 按住预演的最小停留时间（毫秒）：≤ 阈值视为快速点按（松开即执行），超过进入预演 */
const HOLD_MS = 280
/** 棋盘动画结束后保留终局局面的短暂停顿，让玩家先看懂“为什么通关”。 */
const WIN_SETTLE_MS = 360
/** 当前「按住待执行」的方向；预演态 = step(当前, pending.dir) 由渲染层画 ghost */
let pending: { dir: Dir; downAt: number; previewing: boolean } | null = null
let winRevealTimer: ReturnType<typeof setTimeout> | null = null
/** 01–05 引导的瞬时反馈；局面改变、取消预演或换关后清空。 */
let tutorialEvent: TutorialEvent = null

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

/** 棋盘内对象揭示优先于静态 hint；hint 仍可由玩家手动展开复习。 */
const BOARD_GUIDE_LEVELS = new Set([0, 1, 2, 3, 4, 9, 15, 16, 20, 26, 32, 40, 42])

function setTutorialInputMode(next: TutorialInputMode): void {
  if (tutorialInputMode === next) return
  tutorialInputMode = next
  app.dataset.inputMode = next
  if (hist.current !== undefined) updateTutorial()
}

function observePointerInput(event: PointerEvent): void {
  const next = tutorialInputModeFromPointerType(event.pointerType)
  if (next) setTutorialInputMode(next)
}

function currentCanvasSize(): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect()
  return logicalCanvasSize(rect.width, rect.height, LOGICAL)
}

function draw(): void {
  const dpr = window.devicePixelRatio || 1
  const logical = currentCanvasSize()
  const pixelWidth = Math.round(logical.width * dpr)
  const pixelHeight = Math.round(logical.height * dpr)
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  current.render(hist.current, ctx, logical.width, logical.height)
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

function levelProgressKey(game: string, levelIndex: number): string {
  const meta = (levels[levelIndex]?.level ?? {}) as { id?: string }
  return `${game}:${meta.id ?? levelIndex}`
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

function setForecastDot(el: HTMLElement, color: string): void {
  el.dataset.tone = color
}

function boardPoint(
  state: Parameters<typeof getChemTutorial>[1],
  pos: readonly [number, number],
): { x: number; y: number; cell: number; logicalWidth: number; logicalHeight: number } {
  const logical = currentCanvasSize()
  const pad = 28
  const cell = Math.max(
    8,
    Math.floor(Math.min(
      (logical.width - pad * 2) / state.width,
      (logical.height - pad * 2) / state.height,
    )),
  )
  const ox = Math.floor((logical.width - cell * state.width) / 2)
  const oy = Math.floor((logical.height - cell * state.height) / 2)
  return {
    x: ((ox + (pos[0] + 0.5) * cell) / logical.width) * 100,
    y: ((oy + (pos[1] + 0.5) * cell) / logical.height) * 100,
    cell,
    logicalWidth: logical.width,
    logicalHeight: logical.height,
  }
}

function positionBoardGuide(
  state: Parameters<typeof getChemTutorial>[1],
  guide: NonNullable<ReturnType<typeof getChemTutorial>>,
): void {
  const spotlight = guide.spotlight
  guideSpotlight.classList.toggle('hidden', spotlight === undefined)
  let anchorY = 50
  if (spotlight) {
    const point = boardPoint(state, spotlight.pos)
    const width = ((point.cell * spotlight.radiusCells * 2) / point.logicalWidth) * 100
    const height = ((point.cell * spotlight.radiusCells * 2) / point.logicalHeight) * 100
    guideSpotlight.style.left = `${point.x}%`
    guideSpotlight.style.top = `${point.y}%`
    guideSpotlight.style.width = `${width}%`
    guideSpotlight.style.height = `${height}%`
    anchorY = point.y
  }

  const gesture = guide.gesture
  const showKeyboardCue = gesture !== undefined && tutorialInputMode === 'keyboard'
  guideGesture.classList.toggle('hidden', gesture === undefined || showKeyboardCue)
  guideKey.classList.toggle('hidden', gesture === undefined || !showKeyboardCue)
  if (gesture) {
    const gestureAction = gesture.hold ? 'hold' : 'move'
    guideGesture.dataset.action = gestureAction
    guideKey.dataset.action = gestureAction
    const start = boardPoint(state, gesture.from)
    const [dx, dy] = DIR_VEC[gesture.dir]
    const distanceX = (start.cell * gesture.distanceCells) / start.logicalWidth * 100
    const distanceY = (start.cell * gesture.distanceCells) / start.logicalHeight * 100
    const endX = start.x + dx * distanceX
    const endY = start.y + dy * distanceY
    guideGesture.style.setProperty('--gesture-x0', `${start.x}%`)
    guideGesture.style.setProperty('--gesture-y0', `${start.y}%`)
    guideGesture.style.setProperty('--gesture-x1', `${endX}%`)
    guideGesture.style.setProperty('--gesture-y1', `${endY}%`)
    guideGesture.style.setProperty('--gesture-length', `${distanceX}%`)
    guideGesture.style.setProperty('--gesture-angle', `${Math.atan2(dy, dx)}rad`)
    if (showKeyboardCue) {
      const offsetX = (start.cell / start.logicalWidth) * 100 * 0.68
      const offsetY = (start.cell / start.logicalHeight) * 100 * 0.68
      const keyX = start.x + (dy === 0 ? 0 : start.x > 50 ? -offsetX : offsetX)
      const keyY = start.y + (dx === 0 ? 0 : start.y > 50 ? -offsetY : offsetY)
      guideKey.style.left = `${keyX}%`
      guideKey.style.top = `${keyY}%`
      guideKeyLabel.textContent = tutorialKeyForDir(gesture.dir)
      guideKeyAction.textContent = gesture.hold ? 'HOLD' : 'PRESS'
    }
    if (!spotlight) anchorY = start.y
  }
  boardGuide.dataset.placement = anchorY < 50 ? 'bottom' : 'top'
}

/**
 * 01–05 状态驱动操作引导：只把纯模型投影到 DOM，并高亮眼前已相邻的可执行方向。
 * 多步路线不在这里求解，06 起整个模块退出界面。
 */
function updateTutorial(): void {
  const state = hist.current as Parameters<typeof getChemTutorial>[1]
  const guide = current.id === 'chem'
    ? getChemTutorial(index, state, tutorialEvent, tutorialInputMode)
    : null

  for (const button of app.querySelectorAll<HTMLButtonElement>('.dpad-key')) {
    button.classList.remove('tutorial-focus')
  }

  const hasBoardCue = guide !== null && (
    guide.spotlight !== undefined ||
    guide.gesture !== undefined ||
    guide.forecast !== null ||
    guide.feedback !== null
  )
  if (!guide || !hasBoardCue || visualBlindMode) {
    boardGuide.classList.add('hidden')
    return
  }

  boardGuide.classList.remove('hidden')
  tutorialKicker.textContent = guide.kicker
  tutorialTitle.textContent = guide.title
  tutorialBody.textContent = guide.body
  tutorialTip.textContent = guide.tip
  boardGuide.dataset.tone = guide.feedbackTone
  positionBoardGuide(state, guide)

  if (tutorialInputMode === 'touch') {
    for (const dir of guide.focusDirs) {
      app.querySelector<HTMLButtonElement>(`.dpad-key[data-dir="${dir}"]`)?.classList.add('tutorial-focus')
    }
  }

  const forecast = guide.forecast
  tutorialForecast.classList.toggle('hidden', forecast === null)
  if (forecast) {
    const injected = `${tutorialColorText(forecast.injected)}珠`
    forecastInColor.textContent = injected
    forecastInTarget.textContent = `→ 当前中心 · 翻转后${tutorialDirText(forecast.landingArm)}侧`
    setForecastDot(forecastInDot, forecast.injected)

    const showExtraction = forecast.showExtraction && forecast.extracted !== null
    forecastOutRow.classList.toggle('hidden', !showExtraction)
    if (showExtraction && forecast.extracted !== null) {
      forecastOutColor.textContent = `${tutorialColorText(forecast.extracted)}珠`
      setForecastDot(forecastOutDot, forecast.extracted)
    }
  }

  tutorialFeedback.classList.toggle('hidden', guide.feedback === null)
  tutorialFeedback.textContent = guide.feedback ?? ''
}

// 旋转屏幕或视口高度变化时，Canvas 会从正方形变为矩形；教程锚点必须同步重算。
new ResizeObserver(() => {
  if (hist.current !== undefined) updateTutorial()
}).observe(canvas)

function updateHud(): void {
  const meta = levelMeta()
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

  // 关卡 hint（教学/点拨文案）：纯展示，有则显示，无则隐藏
  if (meta.hint) {
    hintEl.textContent = meta.hint
    briefEl.classList.remove('hidden')
  } else {
    hintEl.textContent = ''
    briefEl.classList.add('hidden')
  }
  updateTutorial()
}

function winResult(): string {
  const s = hist.current as { moves?: number; par?: number }
  const moves = s.moves ?? hist.depth
  let result = `${moves} 步完成`
  if (current.id === 'chem' && s.par !== undefined) {
    const stars = moves <= s.par ? '★★★' : moves <= s.par + 3 ? '★★☆' : '★☆☆'
    result = `${stars} · ${moves} 步 / 标准 ${s.par}`
  }
  return result
}

function showOverlay(): void {
  const isLast = index >= levels.length - 1
  const meta = levelMeta()
  const result = winResult()
  winTitle.textContent = meta.name ?? meta.id ?? `第 ${index + 1} 关`
  winStats.textContent = result
  winbarText.textContent = `✓ 已通关 · ${result}`
  nextAfterWin.textContent = isLast ? '回到本关' : '下一关 →'
  winbarNext.textContent = isLast ? '回到本关' : '下一关 →'
  // 可选通关反馈（构建期开关，design §8）：未启用时面板保持隐藏、零请求
  const s = hist.current as { moves?: number; par?: number }
  mountFeedback(feedbackPanel, {
    game: current.id,
    level: index + 1,
    levelId: meta.id ?? String(index + 1),
    moves: s.moves ?? hist.depth,
    par: s.par,
  })
  overlay.classList.remove('hidden')
  overlay.setAttribute('aria-hidden', 'false')
  viewAfterWin.focus()
}

function cancelWinReveal(): void {
  if (winRevealTimer !== null) {
    clearTimeout(winRevealTimer)
    winRevealTimer = null
  }
}

/** 动画完整结束，再停顿一小拍；期间若撤销 / 重开 / 换关，旧卡片不会穿越局面弹出。 */
function scheduleWinOverlay(): void {
  cancelWinReveal()
  const progressKey = levelProgressKey(current.id, index)
  completed.add(progressKey)
  progress = addCompleted(progress, progressKey)
  persistProgress()
  const wonGame = current.id
  const wonLevel = index
  const wonKey = current.def.stateKey(hist.current)
  const animationWait = current.animationRemainingMs?.() ?? 0
  winRevealTimer = setTimeout(() => {
    winRevealTimer = null
    if (current.id !== wonGame || index !== wonLevel) return
    if (current.def.stateKey(hist.current) !== wonKey || !current.def.isWin(hist.current)) return
    showOverlay()
  }, Math.ceil(animationWait) + WIN_SETTLE_MS)
}

function hideOverlay(): void {
  overlay.classList.add('hidden')
  overlay.setAttribute('aria-hidden', 'true')
}

/** 关闭通关卡片、露出终局棋盘，同时保留一条精简通栏 */
function viewBoard(): void {
  hideOverlay()
  winbar.classList.remove('hidden')
}

function hideWinbar(): void {
  winbar.classList.add('hidden')
}

function openLevel(i: number): void {
  cancelWinReveal()
  index = Math.max(0, Math.min(i, levels.length - 1))
  gameIndices[current.id] = index
  progress = setCurrentLevel(progress, current.id, index)
  persistProgress()
  if (current.id === 'chem' && BOARD_GUIDE_LEVELS.has(index)) briefEl.open = false
  current.resetAnim?.()
  hist = new History(current.def.initialState(levels[index].level))
  tutorialEvent = null
  cancelPending()
  setChemInspect(null)
  clearInspectTimer()
  loadMarks()
  setChemMarks(current.id === 'chem' ? currentMarks : null)
  hideOverlay()
  hideWinbar()
  hideToast()
  closePicker()
  draw()
  updateHud()
}

function loadGame(id: string): void {
  // 首次启动时 levels 还是空数组，不要用默认 index=0 覆盖 URL 深链接指定的关卡。
  if (levels.length > 0) gameIndices[current.id] = index
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
  if (def.isWin(hist.current)) return
  const next = def.step(hist.current, dir)
  if (def.stateKey(next) === def.stateKey(hist.current)) {
    current.onBlocked?.(dir) // 无效果输入：交给游戏渲染层做反馈（抖动/红闪）
    tutorialEvent = { kind: 'blocked', dir }
    updateTutorial()
    return
  }
  tutorialEvent = null
  setChemInspect(null) // 局面已变：Inspect 面板收起（design §11）
  clearInspectTimer()
  hist.push(next)
  draw()
  updateHud()
  if (def.isWin(next)) scheduleWinOverlay()
}

function doUndo(): void {
  if (!hist.canUndo) return
  cancelWinReveal()
  hist.undo()
  tutorialEvent = null
  setChemInspect(null)
  clearInspectTimer()
  hideOverlay()
  hideWinbar()
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
    tutorialEvent = null
  } else {
    current.setPreview?.(next)
    tutorialEvent = { kind: 'preview', dir }
  }
  updateTutorial()
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
  tutorialEvent = null
  updateTutorial()
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
  const logical = currentCanvasSize()
  const lx = (clientX - rect.left) * (logical.width / rect.width)
  const ly = (clientY - rect.top) * (logical.height / rect.height)
  const hit = chemHitTest(hist.current as any, lx, ly, logical.width, logical.height)
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

const CHEM_CHAPTERS = [
  { start: 0, end: 8, label: '核心搬运' },
  { start: 9, end: 14, label: '共振传导' },
  { start: 15, end: 19, label: '光照与分步' },
  { start: 20, end: 25, label: '三臂空穴' },
  { start: 26, end: 31, label: '弹射中心' },
  { start: 32, end: 38, label: '阶段护罩' },
  { start: 39, end: 39, label: '终盘复习' },
  { start: 40, end: 45, label: '结构碰撞与回授闸门' },
  { start: 46, end: 49, label: '综合 mastery' },
  { start: 50, end: 59, label: '综合候选池' },
] as const

function buildPicker(): void {
  pickerEl.innerHTML = ''
  levels.forEach((l, i) => {
    const chapter = current.id === 'chem' ? CHEM_CHAPTERS.find((c) => c.start === i) : undefined
    if (chapter) {
      const heading = document.createElement('div')
      heading.className = 'level-chapter'
      const range = `${String(chapter.start + 1).padStart(2, '0')}–${String(chapter.end + 1).padStart(2, '0')}`
      heading.innerHTML = `<span>${range}</span><strong>${chapter.label}</strong>`
      pickerEl.appendChild(heading)
    }
    const meta = l.level as { id?: string; name?: string }
    const btn = document.createElement('button')
    const isComplete = completed.has(levelProgressKey(current.id, i))
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

if (showPrototypeSwitcher) {
  for (const b of Object.values(bundles)) {
    const btn = document.createElement('button')
    btn.textContent = b.label
    btn.dataset.game = b.id
    btn.setAttribute('role', 'tab')
    btn.setAttribute('aria-selected', 'false')
    btn.addEventListener('click', () => loadGame(b.id))
    tabsEl.appendChild(btn)
  }
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
viewAfterWin.addEventListener('click', viewBoard)
winbarReplay.addEventListener('click', restart)
winbarNext.addEventListener('click', () => {
  if (index >= levels.length - 1) restart()
  else nextLevel()
})
winbarClose.addEventListener('click', hideWinbar)

// 触屏方向键（design §11 输入模型）：按下开始计时，松开 = 执行；指针移开按钮 = 取消。
// 键盘可达性：Enter/Space 触发的 click（无 pointerdown 前置）直接执行。
const dpadPointerAt = new WeakMap<HTMLButtonElement, number>()
for (const btn of app.querySelectorAll<HTMLButtonElement>('.dpad-key')) {
  const dir = btn.dataset.dir as Dir
  btn.addEventListener('pointerdown', (e) => {
    observePointerInput(e)
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
    setTutorialInputMode('keyboard')
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
  observePointerInput(e)
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
  if (visualBlindMode) {
    e.preventDefault()
    return
  }
  if (!pickerBackdrop.classList.contains('hidden')) {
    if (e.key === 'Escape') closePicker()
    return
  }
  const dir = dirFromKey(e)
  if (dir) {
    e.preventDefault()
    setTutorialInputMode('keyboard')
    if (!e.repeat) dirDown(dir)
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    if (pending) {
      cancelPending() // 预演中：Esc 只取消预演，不执行
      return
    }
    if (!overlay.classList.contains('hidden')) {
      viewBoard() // 通关卡片：Esc 收起卡片看终局
      return
    }
    if (!winbar.classList.contains('hidden')) {
      hideWinbar()
      return
    }
    closePicker()
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
  if (visualBlindMode) {
    e.preventDefault()
    return
  }
  const dir = dirFromKey(e)
  if (dir) {
    e.preventDefault()
    dirUp(dir)
  }
})

// 失焦：清掉按住状态，避免回来后误执行
window.addEventListener('blur', cancelPending)

const requestedGame = searchParams.get('game')
const initialGame = requestedGame !== null && Object.hasOwn(bundles, requestedGame) ? requestedGame : 'chem'
const requestedLevel = Number.parseInt(searchParams.get('level') ?? '', 10)
if (Number.isFinite(requestedLevel)) gameIndices[initialGame] = Math.max(0, requestedLevel - 1)
loadGame(initialGame)
requestAnimationFrame(frame)
