import './style.css'
import { dirFromKey, isRestartKey, isUndoKey } from '../core/keyboard'
import { loadLevels } from '../core/levels'
import type { LoadedLevel } from '../core/levels'
import { History } from '../core/undo'
import { solveFrom } from '../core/solver'
import { DIR_VEC, cellKey } from '../core/protocol'
import type { AnyGame, Dir } from '../core/protocol'
import {
  chemGame,
  resolveChemStep,
  render as renderChem,
  notifyChemImpact,
  resetChemAnim,
  getChemAnimationRemainingMs,
  setChemAnimationMode,
  setChemRenderTheme,
  setChemPreview,
  setChemTransition,
  setChemInspect,
  setChemMarks,
  chemHitTest,
} from '../games/chem'
import type { ChemAnimationMode, ChemMark } from '../games/chem'
import {
  getChemTutorial,
  initialTutorialInputMode,
  tutorialColorText,
  tutorialDirText,
  tutorialInputModeFromPointerType,
  tutorialKeyForDir,
} from './tutorial'
import type { TutorialControlTarget, TutorialEvent, TutorialInputMode } from './tutorial'
import { mountFeedback } from './feedback'
import { BLOCKED_FEEDBACK_MS, redrawBudgetMs } from './frame-budget'
import { logicalCanvasSize } from './viewport'
import { SingleSlotInputBuffer } from './input-buffer'
import {
  createKeyboardKonamiMatcher,
  createTouchKonamiMatcher,
  isKonamiAlphabetKey,
  konamiKeyFromDir,
} from './konami'
import {
  SWIPE_DISTANCE,
  shouldStartPreview,
  swipeDir,
} from './swipe'
import {
  addCompleted,
  emptyProgress,
  loadProgress,
  saveProgress,
  setCurrentLevel,
} from './progress'

/**
 * 《109.5°》正式浏览器壳：关卡导航、HUD、撤销/重开、画布宿主。
 * 这是唯一允许 any 的胶合层（桥接异构游戏类型），引擎保持严格类型。
 *
 * 认知外置层（design §11）在本层的落点：
 * - 输入模型：tap = 执行，hold ≥ 280ms = 预演（预览 = 对当前局面求一次 step 交给渲染层画 ghost），
 *   键盘松开 = 取消（轻点执行）、指针松开 = 执行（回到原位 / 移出取消）；棋盘拖拽先锁定方向，停留后才进入预演。
 * - 标记模式（chem）：点按中心循环 ①–⑤，点按其他格循环 ★/？/×；按「游戏:关卡」存会话内。
 * - Inspect（chem）：点按中心显示构型周期面板（渲染层实现），6 秒自动收起、任何动作即收起。
 */

interface Bundle {
  id: string
  label: string
  def: AnyGame
  /** 正式动作可额外返回不进游戏状态的因果轨迹；solver 仍只使用 def.step。 */
  resolveStep?: (state: any, action: Dir) => { state: any; events: readonly unknown[] }
  /** 把一次真实因果轨迹交给渲染时间线；null 用于撤销 / 状态跳变清理。 */
  setTransition?: (transition: any | null) => void
  render: (state: any, ctx: CanvasRenderingContext2D, w: number, h: number) => void
  /** 无效输入反馈（step 无效果时调用）；未实现则缺省 */
  onBlocked?: (dir: Dir) => void
  /** 换关 / 重开时重置渲染层动画状态；未实现则缺省 */
  resetAnim?: () => void
  /** 当前棋盘动画还需多久结束；通关卡片据此避让终局反馈 */
  animationRemainingMs?: () => number
  /** 按住预演（design §11）：注入 / 清除 step(当前, 方向) 的 ghost 态；未实现则缺省 */
  setPreview?: (state: any | null, inputHint?: 'key' | 'pointer') => void
  /** 是否支持玩家标记（design §11 层 ③）；当前仅 chem */
  supportsMarks?: boolean
}

const bundles: Record<string, Bundle> = {
  chem: {
    id: 'chem',
    label: '109.5°',
    def: chemGame,
    resolveStep: resolveChemStep,
    setTransition: setChemTransition,
    render: renderChem,
    onBlocked: notifyChemImpact,
    resetAnim: resetChemAnim,
    animationRemainingMs: getChemAnimationRemainingMs,
    setPreview: setChemPreview,
    supportsMarks: true,
  },
}

// 一次 glob 全部游戏的关卡，按目录分流
const levelFiles = import.meta.glob('../games/*/levels/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

function filesFor(gameId: string): Record<string, unknown> {
  const marker = `/games/${gameId}/levels/`
  return Object.fromEntries(Object.entries(levelFiles).filter(([path]) => path.includes(marker)))
}

// ---------- DOM ----------

const progressStore = (() => {
  try {
    return window.localStorage
  } catch {
    return null
  }
})()
const TUTORIAL_PREF_KEY = 'lexin-games:tutorial-enabled'
const ANIMATION_PREF_KEY = 'lexin-games:chem-animation-mode'
const THEME_PREF_KEY = 'lexin-games:color-theme'
type ColorTheme = 'dark' | 'light'
const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)')
let themePreference: ColorTheme | null = (() => {
  try {
    const saved = progressStore?.getItem(THEME_PREF_KEY)
    return saved === 'dark' || saved === 'light' ? saved : null
  } catch {
    return null
  }
})()
const effectiveTheme = (): ColorTheme => themePreference ?? (systemDarkQuery.matches ? 'dark' : 'light')
document.documentElement.dataset.theme = effectiveTheme()

const app = document.querySelector('#app') as HTMLElement
const searchParams = new URLSearchParams(window.location.search)
const visualBlindMode = searchParams.get('blind') === '1'
app.innerHTML = `
  <header class="app-header">
    <div class="brand">
      <span id="brand-kicker" class="brand-kicker">CHEM GAMES · STRUCTURAL PUZZLE</span>
      <strong id="brand-title">109.5°</strong>
    </div>
  </header>

  <section class="level-header" aria-label="关卡导航">
    <button id="prev" class="level-arrow" title="上一关 [" aria-label="上一关">←</button>
    <button id="levels-btn" class="level-identity" title="打开选关面板" aria-haspopup="dialog">
      <span id="level-number" class="level-number">LEVEL —</span>
      <span id="level-label" class="level-name">加载中</span>
      <span class="level-picker-cue">全部关卡<i aria-hidden="true"></i></span>
    </button>
    <button id="next" class="level-arrow" title="下一关 ]" aria-label="下一关">→</button>
  </section>

  <section id="status-bar" class="status-bar" aria-label="当前状态">
    <div class="stat">
      <span class="stat-label">行动</span>
      <strong id="move-label">0</strong>
    </div>
    <div id="game-stats" class="game-stats"></div>
    <div class="status-toggles" aria-label="显示设置">
      <button id="animation-toggle" class="tutorial-toggle animation-toggle" role="switch" aria-checked="false" aria-label="动画速度：1 倍速" title="动画速度：1×（点击开启 2×）">
        <svg class="toggle-icon icon-anim" viewBox="0 0 24 24" aria-hidden="true"><path class="chev-lead" d="m6 17 5-5-5-5"/><path class="chev-main" d="m13 17 5-5-5-5"/></svg>
      </button>
      <button id="tutorial-toggle" class="tutorial-toggle" role="switch" aria-checked="true" aria-label="新手教程已开启">
        <svg class="toggle-icon icon-tutorial" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/><line class="slash" x1="4" y1="20" x2="20" y2="4"/></svg>
      </button>
      <button id="theme-toggle" class="tutorial-toggle theme-toggle" role="switch" aria-checked="true" aria-label="暗色模式已开启">
        <svg class="toggle-icon icon-theme" viewBox="0 0 24 24" aria-hidden="true"><path class="moon" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/><g class="sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></g></svg>
      </button>
    </div>
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
    <div id="budget-alarm" class="budget-alarm" aria-hidden="true"></div>
    <div id="board-guide" class="board-guide hidden" aria-live="polite">
      <div id="guide-spotlight" class="guide-spotlight hidden" aria-hidden="true"></div>
      <div id="guide-orbit" class="guide-orbit hidden" aria-hidden="true"><i></i></div>
      <div id="guide-gesture" class="guide-gesture hidden" aria-hidden="true">
        <span class="gesture-track"></span>
        <span class="gesture-finger"><i></i></span>
      </div>
      <div id="guide-key" class="guide-key hidden" aria-hidden="true">
        <kbd id="guide-key-label">S</kbd>
        <span id="guide-key-action">PRESS</span>
      </div>
      <section id="tutorial-card" class="board-guide-card" aria-label="操作引导">
        <button id="tutorial-close" class="tutorial-close" title="收起操作引导" aria-label="收起操作引导" aria-controls="tutorial-card" aria-expanded="true"><span aria-hidden="true"></span></button>
        <small id="tutorial-kicker">BASICS · 01 / 05</small>
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
      <button id="tutorial-reopen" class="tutorial-reopen" aria-label="展开操作引导" aria-controls="tutorial-card" aria-expanded="false"><span>TIP</span><i aria-hidden="true"></i></button>
    </div>
    <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
    <div id="overlay" class="overlay hidden" aria-hidden="true">
      <div class="overlay-card">
        <div id="win-mark" class="win-mark"><span>✓</span> 关卡完成</div>
        <strong id="win-title" class="win-title"></strong>
        <div id="win-stats" class="win-stats"></div>
        <button id="win-secret-hint" class="win-secret-hint hidden" aria-label="似乎还有没结束的游戏">GAME… NOT OVER?</button>
        <div id="feedback-panel" class="feedback-panel hidden"></div>
        <div class="win-actions">
          <button id="replay-after-win" class="secondary-button">再玩一次</button>
          <button id="view-after-win" class="secondary-button">查看棋盘</button>
          <button id="next-after-win" class="primary-button">下一关 →</button>
        </div>
      </div>
    </div>
    <div id="winbar" class="winbar hidden" aria-live="polite">
      <button id="winbar-open" class="winbar-text" title="重新打开通关反馈" aria-label="重新打开通关反馈"></button>
      <button id="winbar-replay" class="secondary-button">再玩一次</button>
      <button id="winbar-next" class="primary-button">下一关 →</button>
      <button id="winbar-close" class="winbar-close" title="关闭通关栏" aria-label="关闭通关栏">✕</button>
    </div>
  </main>

  <section class="controls" aria-label="游戏操作">
    <div class="utility-actions">
      <button id="undo" class="control-button" title="撤销 (Z)" aria-label="撤销">
        <span class="control-icon icon-undo" aria-hidden="true"></span><span>撤销</span>
      </button>
      <button id="restart" class="control-button" title="重开 (R)" aria-label="重开">
        <span class="control-icon icon-restart" aria-hidden="true"></span><span>重开</span>
      </button>
      <button id="mark-mode" class="control-button hidden" title="标记模式 (M)：点按中心放 ①–⑤ 顺序标，点按格子放 ★/？/×" aria-label="标记模式">
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
    <div class="assist-actions">
      <button id="hint" class="control-button hint-button" title="下一步提示 (H)：不限次数" aria-label="提示一步">
        <span class="control-icon icon-hint" aria-hidden="true"></span><span>提示一步</span>
      </button>
      <button id="rules" class="control-button rules-button" title="查看全部规则 (G)" aria-label="查看全部游戏规则" aria-haspopup="dialog">
        <span class="control-icon icon-rules" aria-hidden="true"></span><span>全部规则</span>
      </button>
    </div>
  </section>

  <footer class="app-footer">
    <div class="shortcut-hint">方向键 / WASD 移动 · 长按预演（松开取消，轻点执行） · Z 撤销 · R 重开 · H 提示 · G 规则 · M 标记</div>
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

  <div id="rules-backdrop" class="picker-backdrop rules-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="rules-title">
    <section class="picker-panel rules-panel">
      <header class="picker-header">
        <div><span class="brand-kicker">RULE BOOK</span><strong id="rules-title">《109.5°》全部规则</strong></div>
        <button id="rules-close" class="icon-button" aria-label="关闭规则弹窗">×</button>
      </header>
      <div class="rules-scroll">
        <div class="rules-game" data-rules-game="chem">
          <section class="rules-intro">
            <span>一句话目标</span>
            <strong>让每个虚线目标圈，和圈里的珠变成同一种颜色。</strong>
            <p>当前阶段的目标全部对上后进入下一阶段；做完最后一个阶段就过关。✓ 表示这个目标目前对上了，但之后还可能被改变。</p>
          </section>
          <ol class="rules-list">
            <li>
              <span class="rule-number">01</span><div><strong>移动与背面进攻</strong><p>上下左右移动，一次一格。白箭头指出开口在哪、该从哪个方向撞：先站到箭头对面，再顺着箭头撞进去。撞别的面没有效果。</p></div>
            </li>
            <li>
              <span class="rule-number">02</span><div><strong>整体翻转</strong><p>每撞一次，中心、所有臂、白箭头和空穴都会整体翻到对面：上换下，左换右。</p></div>
            </li>
            <li>
              <span class="rule-number">03</span><div><strong>拾珠与交换</strong><p>走过场上的珠会拿起它；手里已经有珠时，会和地上的珠交换。拿着珠撞进开口时，手里的珠进去，开口上原来的珠换到你手里，然后中心整体翻转。手不会自己变空。</p></div>
            </li>
            <li>
              <span class="rule-number">04</span><div><strong>长按预演</strong><p>按住方向键或拖住不松手可预演完整结果；虚线轮廓表示尚未发生。键盘松开即取消，轻点执行；棋盘拖拽拖回原位取消，松开执行。</p></div>
            </li>
            <li>
              <span class="rule-number">05</span><div><strong>共振键</strong><p>相邻两座中心面对面的臂都有珠、而且同色，中间会形成亮键。一座中心被撞后先翻转，再按翻转后的样子看亮键；传到的邻居也是先翻转，再看下一座。</p></div>
            </li>
            <li>
              <span class="rule-number">06</span><div><strong>光格与阶段目标</strong><p>走上金色的光格，所有中心的开口会顺时针移到下一条有珠的臂；臂上的珠不会跟着转。亮圈是当前阶段的目标，淡圈是以后阶段的。</p></div>
            </li>
            <li>
              <span class="rule-number">07</span><div><strong>三臂中心与空穴</strong><p>三臂中心只有三颗珠；虚线空槽是空穴，填不上。翻转时空穴也移到对面，空穴那个方向形成不了共振键；光格转开口时会跳过空穴。</p></div>
            </li>
            <li>
              <span class="rule-number">08</span><div><strong>弹射中心</strong><p>菱形核是弹射中心。拿着珠撞进去，手会变空，开口上原来的珠从背后的喷口沿直线飞出去，落在最后一个空格；如果你身后第一格被堵，这一撞无效。</p></div>
            </li>
            <li>
              <span class="rule-number">09</span><div><strong>阶段护罩</strong><p>带数字的六边形护罩挡住直接进攻和共振，但不挡光格。编号表示它从第几阶段起打开；护罩要等当前这一步全部结束才打开，刚结束的这一撞不能追进去。</p></div>
            </li>
            <li>
              <span class="rule-number">10</span><div><strong>弹出的珠撞结构</strong><p>后面的关卡里，弹出的珠落到光格上，会像你踩上去一样转一次所有开口；落到另一座中心的进攻位，会替你空手翻一次，并继续检查共振。珠留在落点，之后可以捡起。</p></div>
            </li>
            <li>
              <span class="rule-number">11</span><div><strong>再生护罩</strong><p>带 R 的护罩用虚线连着一条控制臂。控制臂的颜色没了，护罩关上；修回来，护罩重新打开。有时故意关上它，能保护已经对齐的中心。</p></div>
            </li>
          </ol>
        </div>
        <section class="rules-controls" aria-label="通用操作">
          <strong>通用操作</strong>
          <p><kbd>WASD</kbd> / <kbd>方向键</kbd> 移动 · <kbd>Z</kbd> 撤销 · <kbd>R</kbd> 重开 · <kbd>H</kbd> 下一步提示 · <kbd>G</kbd> 规则 · <kbd>Esc</kbd> 取消预演或关闭弹窗</p>
          <p>状态栏的「动画」可独立切换 1× / 2×；默认 1× 会依次播放交换、翻转与共振，不依赖文字教程。</p>
        </section>
      </div>
    </section>
  </div>
  <div class="lv999-flash" aria-hidden="true"></div>
`
app.classList.toggle('visual-blind', visualBlindMode)

const canvas = app.querySelector('#board') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
const budgetAlarmEl = app.querySelector('#budget-alarm') as HTMLDivElement

/** 步数红线警示（design §5 v6）：剩余步数 ≤ 阈值时棋盘四周亮红色警示框 */
const BUDGET_ALARM_THRESHOLD = 3

function updateBudgetAlarm(): void {
  if (current.id !== 'chem') {
    budgetAlarmEl.classList.remove('active')
    return
  }
  const s = hist.current as { moves?: number; moveLimit?: number; won?: boolean }
  if (s.moveLimit === undefined || s.won) {
    budgetAlarmEl.classList.remove('active')
    return
  }
  const remaining = s.moveLimit - (s.moves ?? hist.depth)
  budgetAlarmEl.classList.toggle('active', remaining <= BUDGET_ALARM_THRESHOLD)
}

/** 每动一次跳一下：重启 pulse 动画（仅在警示已激活时） */
function pulseBudgetAlarm(): void {
  if (!budgetAlarmEl.classList.contains('active')) return
  budgetAlarmEl.classList.remove('pulse')
  void budgetAlarmEl.offsetWidth // 强制回流以重启动画
  budgetAlarmEl.classList.add('pulse')
}
const brandKicker = app.querySelector('#brand-kicker') as HTMLElement
const brandTitle = app.querySelector('#brand-title') as HTMLElement
const levelNumber = app.querySelector('#level-number') as HTMLElement
const levelLabel = app.querySelector('#level-label') as HTMLElement
const moveLabel = app.querySelector('#move-label') as HTMLElement
const gameStats = app.querySelector('#game-stats') as HTMLElement
const animationToggle = app.querySelector('#animation-toggle') as HTMLButtonElement
const tutorialToggle = app.querySelector('#tutorial-toggle') as HTMLButtonElement
const themeToggle = app.querySelector('#theme-toggle') as HTMLButtonElement
const hintBtn = app.querySelector('#hint') as HTMLButtonElement
const overlay = app.querySelector('#overlay') as HTMLElement
const winMark = app.querySelector('#win-mark') as HTMLElement
const winTitle = app.querySelector('#win-title') as HTMLElement
const winStats = app.querySelector('#win-stats') as HTMLElement
const winSecretHint = app.querySelector('#win-secret-hint') as HTMLButtonElement
const feedbackPanel = app.querySelector('#feedback-panel') as HTMLElement
const nextAfterWin = app.querySelector('#next-after-win') as HTMLButtonElement
const replayAfterWin = app.querySelector('#replay-after-win') as HTMLButtonElement
const viewAfterWin = app.querySelector('#view-after-win') as HTMLButtonElement
const winbar = app.querySelector('#winbar') as HTMLElement
const winbarOpen = app.querySelector('#winbar-open') as HTMLButtonElement
const winbarReplay = app.querySelector('#winbar-replay') as HTMLButtonElement
const winbarNext = app.querySelector('#winbar-next') as HTMLButtonElement
const winbarClose = app.querySelector('#winbar-close') as HTMLButtonElement
const hintEl = app.querySelector('#level-hint') as HTMLElement
const briefEl = app.querySelector('#level-brief') as HTMLDetailsElement
const boardGuide = app.querySelector('#board-guide') as HTMLElement
const guideSpotlight = app.querySelector('#guide-spotlight') as HTMLElement
const guideOrbit = app.querySelector('#guide-orbit') as HTMLElement
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
const tutorialClose = app.querySelector('#tutorial-close') as HTMLButtonElement
const tutorialReopen = app.querySelector('#tutorial-reopen') as HTMLButtonElement
const toastEl = app.querySelector('#toast') as HTMLElement
const pickerEl = app.querySelector('#level-picker') as HTMLElement
const pickerBackdrop = app.querySelector('#picker-backdrop') as HTMLElement
const rulesBackdrop = app.querySelector('#rules-backdrop') as HTMLElement
const rulesTitle = app.querySelector('#rules-title') as HTMLElement
const rulesBtn = app.querySelector('#rules') as HTMLButtonElement
const rulesClose = app.querySelector('#rules-close') as HTMLButtonElement
const levelsBtn = app.querySelector('#levels-btn') as HTMLButtonElement
const prevBtn = app.querySelector('#prev') as HTMLButtonElement
const nextBtn = app.querySelector('#next') as HTMLButtonElement
const undoBtn = app.querySelector('#undo') as HTMLButtonElement
const markBtn = app.querySelector('#mark-mode') as HTMLButtonElement

const LOGICAL = 480

let current: Bundle = bundles.chem
let levels: LoadedLevel<any>[] = []
let index = 0
let hist: History<any> = new History(undefined)
let tutorialEnabled = (() => {
  try {
    return progressStore?.getItem(TUTORIAL_PREF_KEY) !== 'off'
  } catch {
    return true
  }
})()
let chemAnimationMode: ChemAnimationMode = (() => {
  try {
    return progressStore?.getItem(ANIMATION_PREF_KEY) === 'fast' ? 'fast' : 'clear'
  } catch {
    return 'clear'
  }
})()
setChemAnimationMode(chemAnimationMode)
const savedProgress = progressStore ? loadProgress(progressStore) : emptyProgress()
const completed = new Set<string>(savedProgress.completed)
const gameIndices: Record<string, number> = {
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

/** 棋盘动画结束后保留终局局面的短暂停顿，让玩家先看懂“为什么通关”。 */
const WIN_SETTLE_MS = 360
/** 当前「按住待执行」的方向；预演态 = step(当前, pending.dir) 由渲染层画 ghost。
 *  origin 记录预演来源：键盘松开 = 取消，指针（拖拽 / 触屏方向键）松开 = 执行（design §11）。
 *  fromPreviewSwitch：该 pending 由「换键打断预演」产生——换键手势链不允许执行任何步，
 *  松开一律取消，只有松开后重新干净轻点才会执行。 */
let pending: {
  dir: Dir
  downAt: number
  previewing: boolean
  origin: 'key' | 'pointer'
  fromPreviewSwitch?: boolean
} | null = null
/** 1× 因果动画期间只缓存下一步，避免快速连按被静默丢弃。 */
const inputBuffer = new SingleSlotInputBuffer<Dir>()
let winRevealTimer: ReturnType<typeof setTimeout> | null = null
/** 核心操作 / 新机制引导的瞬时反馈；局面改变、取消预演或换关后清空。 */
let tutorialEvent: TutorialEvent = null
/** 01 / 03 指物教学的局部拍数；达到各段阈值后才开放真实方向输入。 */
let tutorialIntroBeat = 0
/** 玩家主动收起后跨教程步骤保持精简态；可随时用棋盘边缘的 TIP 标签恢复。 */
let tutorialCollapsed = false

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
const BOARD_GUIDE_LEVELS = new Set([0, 1, 2, 3, 4, 9, 15, 16, 20, 26, 32, 40, 41, 42])

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

// 画布 CSS 尺寸用 ResizeObserver 维护缓存：每帧 getBoundingClientRect 会强制布局回流，
// 渲染循环与事件处理器统一读缓存；DPR 变化（缩放 / 换屏）由 draw 每次对比后备存储尺寸自行纠正。
const initialCanvasRect = canvas.getBoundingClientRect()
let canvasCssWidth = initialCanvasRect.width
let canvasCssHeight = initialCanvasRect.height
new ResizeObserver((entries) => {
  const rect = entries[0]?.contentRect
  if (!rect) return
  canvasCssWidth = rect.width
  canvasCssHeight = rect.height
}).observe(canvas)

function currentCanvasSize(): { width: number; height: number } {
  return logicalCanvasSize(canvasCssWidth, canvasCssHeight, LOGICAL)
}

/** 帧率门控记账：draw 内更新，frame 据此决定本帧是否重绘。 */
let lastDrawAt = -Infinity
let lastDrawnState: unknown

function draw(): void {
  lastDrawAt = performance.now()
  lastDrawnState = hist.current
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

// 棋盘动画（补间 / 翻转 / 弹射 / 预演）期间全速重绘；静止与弹窗遮盖下的重绘限频见 frame-budget.ts。
let blockedFeedbackUntil = 0

function boardCoveredByModal(): boolean {
  return (
    !overlay.classList.contains('hidden') ||
    !pickerBackdrop.classList.contains('hidden') ||
    !rulesBackdrop.classList.contains('hidden')
  )
}

// 渲染循环：驱动输入缓冲消费与「按住预演」（按住超过 280ms 注入一步预演态，design §11）；
// 重绘按 frame-budget 的门控限频执行。
function frame(): void {
  if (
    inputBuffer.pending !== undefined &&
    (current.animationRemainingMs?.() ?? 0) <= 0 &&
    overlay.classList.contains('hidden')
  ) {
    const dir = inputBuffer.take()!
    clearBufferedDir()
    applyDir(dir)
  }
  if (pending && !pending.previewing && shouldStartPreview(pending.downAt, performance.now())) {
    pending.previewing = true
    showPreview(pending.dir)
  }
  const now = performance.now()
  const budget = redrawBudgetMs({
    animating: (current.animationRemainingMs?.() ?? 0) > 0,
    stateChanged: hist.current !== lastDrawnState,
    previewing: pending?.previewing === true,
    feedbackActive: now < blockedFeedbackUntil,
    covered: boardCoveredByModal(),
  })
  if (now - lastDrawAt >= budget) draw()
  requestAnimationFrame(frame)
}

function levelMeta(): { id?: string; name?: string; hint?: string } {
  return (levels[index]?.level ?? {}) as { id?: string; name?: string; hint?: string }
}

const LV999_LEVEL_ID = '109.5°-999'

function isLv999Level(levelIndex = index): boolean {
  if (current.id !== 'chem') return false
  const meta = (levels[levelIndex]?.level ?? {}) as { id?: string }
  return meta.id === LV999_LEVEL_ID
}

// ---------- LV.999 入口隐藏化（design §5 LV.999 四次决策）：发现制，不是关卡锁 ----------
// 发现前：选关面板只有「??? 未知扇区」诱饵、状态栏总数 / 74、74 关按最后一关处理；
// 主入口 = Konami 序列（桌面）/ 滑动序列 + 双击（触屏）/ 50 终局通关卡 idle 面包屑 / 深链接。
// 任何方式进入即持久发现标记，之后恢复霓虹入口与真实总数。

const LV999_DISCOVERED_KEY = 'lexin-games:lv999-discovered'
let lv999Discovered: boolean = (() => {
  try {
    return progressStore?.getItem(LV999_DISCOVERED_KEY) === '1'
  } catch {
    return false
  }
})()

function markLv999Discovered(): void {
  if (lv999Discovered) return
  lv999Discovered = true
  try {
    progressStore?.setItem(LV999_DISCOVERED_KEY, '1')
  } catch {
    /* 隐私模式等存储不可用：本次会话内仍生效 */
  }
}

/** 玩家可见的关卡总数：发现前隐藏 LV.999，避免「/ 75」直接泄漏还有一关 */
function visibleLevelCount(): number {
  return current.id === 'chem' && !lv999Discovered ? levels.length - 1 : levels.length
}

/** 接入隐藏挑战：关弹窗 → 持久发现标记 → 直达末关（主题切换自动播放既有故障闪屏） */
function enterLv999(): void {
  closeRules()
  closePicker()
  markLv999Discovered()
  openLevel(levels.length - 1)
  toast('> 隐藏挑战已接入 · LV.999', 4200, 'lv999')
}

// 秘籍入口（只在未发现时激活；发现后由选关面板霓虹入口承担，避免游玩中误触发重进）
const keyboardKonami = createKeyboardKonamiMatcher()
const touchKonami = createTouchKonamiMatcher()
let touchKonamiArmedAt = 0
let touchKonamiLastTapAt = 0

/** 键盘 Konami：↑↑↓↓←→←→BA（方向键 / WASD 逐拍同权，a 在左位是左、末位是 A）；字母表外的键打断进度 */
function trackKonamiKeydown(e: KeyboardEvent): void {
  if (current.id !== 'chem' || lv999Discovered || isLv999Level()) return
  const target = e.target
  if (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  ) {
    return
  }
  if (!isKonamiAlphabetKey(e.key)) {
    keyboardKonami.reset()
    return
  }
  if (keyboardKonami.push(e.key)) {
    keyboardKonami.reset()
    enterLv999()
  }
}

/** 触屏滑动序列：↑↑↓↓←→←→ 命中后 3 秒内双击棋盘接入 */
function recordTouchKonamiSwipe(dir: Dir): void {
  if (current.id !== 'chem' || lv999Discovered || isLv999Level()) return
  if (touchKonami.push(konamiKeyFromDir(dir))) touchKonamiArmedAt = performance.now()
}

// LV.999 骇客介入（design §5 LV.999 二次决策）：四段完成逐段拼出 GAME / NOT / OVER；
// 迷路 5 步仍卡在第一段时播一次性「低效操作」嘲讽——它同时是变相指路（回起点的口袋）。
// 阈值 5 = 走出单门口袋并撞上第一道锁的距离，避免刚出门就被打断。
const LV999_STAGE_SPELLS = ['GAME', 'NOT', 'OVER'] as const
let lv999TauntShown = false

/** 只在 LV.999 的有效动作后调用；won 状态交给通关卡片，不重复播字。 */
function notifyLv999Progress(after: { stage: number; moves: number }, beforeStage: number): void {
  if (after.stage > beforeStage) {
    if (after.stage <= LV999_STAGE_SPELLS.length) {
      toast(`> 段 0${after.stage} 改写完成 —— ${LV999_STAGE_SPELLS[after.stage - 1]}`, 3200, 'lv999')
    }
    return
  }
  if (!lv999TauntShown && after.moves >= 5 && after.stage === 0) {
    lv999TauntShown = true
    toast('> 低效操作已记录 ▸ 第 999 场，仍从第 1 场的房间开始', 6000, 'lv999-warn')
  }
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

  const orbit = guide.orbitDemo
  guideOrbit.classList.toggle('hidden', orbit === undefined)
  if (orbit) {
    const center = boardPoint(state, orbit.center)
    const cssCell = center.cell * canvas.getBoundingClientRect().width / center.logicalWidth
    const angle: Record<Dir, number> = { N: -90, E: 0, S: 90, W: 180 }
    guideOrbit.style.left = `${center.x}%`
    guideOrbit.style.top = `${center.y}%`
    guideOrbit.style.setProperty('--orbit-radius', `${cssCell * (orbit.radiusCells ?? 0.46)}px`)
    guideOrbit.style.setProperty('--orbit-from', `${angle[orbit.from]}deg`)
    guideOrbit.style.setProperty('--orbit-to', `${angle[orbit.from] + 180}deg`)
    guideOrbit.dataset.tone = orbit.color
    if (!spotlight) anchorY = center.y
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
 * 01–04 核心操作引导与后续机制首现揭示：只把纯模型投影到 DOM。
 * 05 起不再提供状态驱动解题路线；未命中新机制揭示时模块退出界面。
 */
function updateTutorialToggle(): void {
  tutorialToggle.classList.toggle('hidden', current.id !== 'chem')
  tutorialToggle.dataset.enabled = String(tutorialEnabled)
  tutorialToggle.setAttribute('aria-checked', String(tutorialEnabled))
  tutorialToggle.setAttribute('aria-label', `新手教程已${tutorialEnabled ? '开启' : '关闭'}`)
}

function updateAnimationToggle(): void {
  const doubled = chemAnimationMode === 'fast'
  animationToggle.classList.toggle('hidden', current.id !== 'chem')
  animationToggle.dataset.enabled = String(doubled)
  animationToggle.setAttribute('aria-checked', String(doubled))
  animationToggle.setAttribute('aria-label', `动画速度：${doubled ? '2' : '1'} 倍速`)
  animationToggle.title = `动画速度：${doubled ? '2×' : '1×'}（点击切换到 ${doubled ? '1×' : '2×'}）`
}

/** LV.999 退出闪烁：CSS 动画时长 620ms，属性保留 700ms 后撤下。 */
let lv999ExitTimer: ReturnType<typeof setTimeout> | null = null

function triggerLv999ExitFlash(): void {
  if (lv999ExitTimer !== null) clearTimeout(lv999ExitTimer)
  document.documentElement.dataset.lv999Exit = ''
  lv999ExitTimer = setTimeout(() => {
    lv999ExitTimer = null
    clearLv999ExitFlash()
  }, 700)
}

function clearLv999ExitFlash(): void {
  if (lv999ExitTimer !== null) {
    clearTimeout(lv999ExitTimer)
    lv999ExitTimer = null
  }
  delete document.documentElement.dataset.lv999Exit
}

function updateThemeToggle(): void {
  const dark = effectiveTheme() === 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  const lv999 = isLv999Level()
  if (lv999) {
    // 中途回到彩蛋关时撤下未播完的退出闪烁，避免两段动画叠在同一层
    clearLv999ExitFlash()
    document.documentElement.dataset.levelTheme = 'lv999'
    app.dataset.levelTheme = 'lv999'
    setChemRenderTheme('lv999')
    brandKicker.textContent = 'PUNKLORDE // GODMODE PLAYER'
    brandTitle.textContent = '109.5° // LV.999'
    themeToggle.dataset.enabled = 'true'
    themeToggle.setAttribute('aria-checked', 'true')
    themeToggle.setAttribute('aria-label', 'LV.999 彩蛋主题已锁定')
    themeToggle.title = 'LV.999 彩蛋主题已锁定；离开本关后恢复明暗偏好'
    return
  }

  // 离开彩蛋关：主题属性即将移除，CSS 无法对「属性消失」做动画，挂一个瞬态属性播放 CRT 关机式收束
  if (document.documentElement.dataset.levelTheme === 'lv999') triggerLv999ExitFlash()
  delete document.documentElement.dataset.levelTheme
  delete app.dataset.levelTheme
  setChemRenderTheme(dark ? 'dark' : 'light')
  brandKicker.textContent = 'CHEM GAMES · STRUCTURAL PUZZLE'
  brandTitle.textContent = '109.5°'
  themeToggle.dataset.enabled = String(dark)
  themeToggle.setAttribute('aria-checked', String(dark))
  themeToggle.setAttribute('aria-label', `暗色模式已${dark ? '开启' : '关闭'}`)
  themeToggle.title = dark ? '暗色模式：开（点击切换为浅色）' : '暗色模式：关（点击切换为深色）'
}

function setAnimationMode(mode: ChemAnimationMode): void {
  clearBufferedDir()
  chemAnimationMode = mode
  setChemAnimationMode(mode)
  try {
    progressStore?.setItem(ANIMATION_PREF_KEY, mode)
  } catch {
    // 隐私模式下偏好只保留到当前页面；不影响动画节奏本身。
  }
  updateAnimationToggle()
  draw()
}

function setTutorialEnabled(enabled: boolean): void {
  tutorialEnabled = enabled
  tutorialEvent = null
  try {
    progressStore?.setItem(TUTORIAL_PREF_KEY, enabled ? 'on' : 'off')
  } catch {
    // 隐私模式下偏好只保留到当前页面；不影响教程开关本身。
  }
  updateTutorialToggle()
  updateTutorial()
}

function setDarkMode(enabled: boolean): void {
  clearBufferedDir()
  themePreference = enabled ? 'dark' : 'light'
  try {
    progressStore?.setItem(THEME_PREF_KEY, themePreference)
  } catch {
    // 隐私模式下偏好只保留到当前页面；不影响主题切换本身。
  }
  updateThemeToggle()
}

function isTutorialIntroAwaiting(): boolean {
  if (!tutorialEnabled || current.id !== 'chem') return false
  const state = hist.current as Parameters<typeof getChemTutorial>[1] | undefined
  if (!state) return false
  return getChemTutorial(index, state, tutorialEvent, tutorialInputMode, tutorialIntroBeat)?.advanceOnTap === true
}

/** 返回 true 表示这次输入只推进了讲解，不应再传给游戏。 */
function advanceTutorialIntro(): boolean {
  if (!isTutorialIntroAwaiting()) return false
  tutorialIntroBeat++
  updateTutorial()
  return true
}

function isTutorialControlAwaiting(target: TutorialControlTarget): boolean {
  if (!tutorialEnabled || current.id !== 'chem') return false
  const state = hist.current as Parameters<typeof getChemTutorial>[1] | undefined
  if (!state) return false
  return getChemTutorial(index, state, tutorialEvent, tutorialInputMode, tutorialIntroBeat)?.controlTarget === target
}

/** 实际试用提示按钮也完成这一拍；玩家仍可轻触棋盘直接跳过。 */
function requestStepHint(): void {
  const completesTutorial = isTutorialControlAwaiting('hint')
  cancelPending()
  showHint()
  if (completesTutorial) {
    tutorialIntroBeat++
    updateTutorial()
  }
}

function updateTutorial(): void {
  const state = hist.current as Parameters<typeof getChemTutorial>[1]
  const guide = current.id === 'chem' && tutorialEnabled
    ? getChemTutorial(index, state, tutorialEvent, tutorialInputMode, tutorialIntroBeat)
    : null

  for (const button of app.querySelectorAll<HTMLButtonElement>('.dpad-key')) {
    button.classList.remove('tutorial-focus')
  }
  hintBtn.classList.toggle('tutorial-focus', guide?.controlTarget === 'hint')

  const hasBoardCue = guide !== null && (
    guide.spotlight !== undefined ||
    guide.orbitDemo !== undefined ||
    guide.gesture !== undefined ||
    guide.forecast !== null ||
    guide.feedback !== null ||
    guide.controlTarget !== undefined
  )
  if (!guide || !hasBoardCue || visualBlindMode) {
    boardGuide.classList.add('hidden')
    boardGuide.classList.remove('awaiting-advance')
    return
  }

  boardGuide.classList.remove('hidden')
  boardGuide.classList.toggle('awaiting-advance', guide.advanceOnTap === true)
  boardGuide.classList.toggle('collapsed', tutorialCollapsed)
  tutorialClose.setAttribute('aria-expanded', String(!tutorialCollapsed))
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

function setTutorialCollapsed(collapsed: boolean): void {
  tutorialCollapsed = collapsed
  boardGuide.classList.toggle('collapsed', collapsed)
  tutorialClose.setAttribute('aria-expanded', String(!collapsed))
  tutorialReopen.setAttribute('aria-expanded', String(!collapsed))
}

// 旋转屏幕或视口高度变化时，Canvas 会从正方形变为矩形；教程锚点必须同步重算。
new ResizeObserver(() => {
  if (hist.current !== undefined) updateTutorial()
}).observe(canvas)

function updateHud(): void {
  const meta = levelMeta()
  levelNumber.textContent = isLv999Level()
    ? 'LV.999 // HIDDEN RAID'
    : levels.length > 0
      ? `LEVEL ${String(index + 1).padStart(2, '0')} / ${String(visibleLevelCount()).padStart(2, '0')}`
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
      moves?: number
      moveLimit?: number
      won?: boolean
    }
    if (s.par !== undefined) appendStat('标准', String(s.par).padStart(2, '0'))
    if (s.moveLimit !== undefined) {
      const remaining = Math.max(0, s.moveLimit - (s.moves ?? hist.depth))
      appendStat(
        '剩余',
        String(remaining).padStart(2, '0'),
        remaining <= BUDGET_ALARM_THRESHOLD && !s.won ? 'red' : undefined,
      )
    }
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
  nextBtn.disabled = index >= visibleLevelCount() - 1
  undoBtn.disabled = !hist.canUndo
  updateBudgetAlarm()
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

/** 50《终局》通关卡 idle 4 秒后的面包屑（design §5 LV.999 四次决策）：给不用秘籍的玩家留发现路径。 */
let winSecretHintTimer: ReturnType<typeof setTimeout> | null = null
function cancelWinSecretHint(): void {
  if (winSecretHintTimer !== null) {
    clearTimeout(winSecretHintTimer)
    winSecretHintTimer = null
  }
  winSecretHint.classList.add('hidden')
}

function scheduleWinSecretHint(): void {
  cancelWinSecretHint()
  if (current.id !== 'chem' || index !== 49 || lv999Discovered) return
  winSecretHintTimer = setTimeout(() => {
    winSecretHintTimer = null
    if (lv999Discovered || index !== 49 || overlay.classList.contains('hidden')) return
    winSecretHint.classList.remove('hidden')
  }, 4000)
}

function showOverlay(): void {
  const isLast = index >= visibleLevelCount() - 1
  const lv999 = isLv999Level()
  const meta = levelMeta()
  const result = winResult()
  // 50《终局》= 主线完结：明确宣告「主线通关」，之后的 51–74 是通关后挑战（design §6）
  const mainDone = current.id === 'chem' && index === 49
  winMark.textContent = lv999
    ? '◆ GODMODE CLEAR · GAME NOT OVER'
    : mainDone
      ? '✓ 主线通关'
      : '✓ 关卡完成'
  winTitle.textContent = meta.name ?? meta.id ?? `第 ${index + 1} 关`
  winStats.textContent = result
  winbarOpen.textContent = lv999
    ? `LV.999 CLEAR · ${result}`
    : mainDone
      ? `✓ 主线通关 · ${result}`
      : `✓ 已通关 · ${result}`
  nextAfterWin.textContent = lv999 ? '再次挑战' : isLast ? '回到本关' : '下一关 →'
  winbarNext.textContent = lv999 ? '再次挑战' : isLast ? '回到本关' : '下一关 →'
  // 可选通关反馈（构建期开关，design §8）：未启用时面板保持隐藏、零请求
  const s = hist.current as { moves?: number; par?: number }
  mountFeedback(feedbackPanel, {
    game: current.id,
    level: index + 1,
    levelId: meta.id ?? String(index + 1),
    moves: s.moves ?? hist.depth,
    par: s.par,
  })
  reopenOverlay()
  scheduleWinSecretHint()
}

function cancelWinReveal(): void {
  if (winRevealTimer !== null) {
    clearTimeout(winRevealTimer)
    winRevealTimer = null
  }
  cancelWinSecretHint()
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

/** 从精简通栏恢复原来的通关卡片；不重建 DOM，因此未提交的反馈选择也会保留。 */
function reopenOverlay(): void {
  hideWinbar()
  overlay.classList.remove('hidden')
  overlay.setAttribute('aria-hidden', 'false')
  viewAfterWin.focus()
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
  if (current.id === 'chem' && isLv999Level()) markLv999Discovered() // 深链接等任何进入都算发现
  tutorialIntroBeat = 0
  gameIndices[current.id] = index
  progress = setCurrentLevel(progress, current.id, index)
  persistProgress()
  if (current.id === 'chem' && BOARD_GUIDE_LEVELS.has(index)) briefEl.open = false
  current.resetAnim?.()
  hist = new History(current.def.initialState(levels[index].level))
  tutorialEvent = null
  lv999TauntShown = false
  cancelPending()
  setChemInspect(null)
  clearInspectTimer()
  loadMarks()
  setChemMarks(current.id === 'chem' ? currentMarks : null)
  hideOverlay()
  hideWinbar()
  hideToast()
  closePicker()
  updateThemeToggle()
  draw()
  updateHud()
}

function loadGame(id: string): void {
  // 首次启动时 levels 还是空数组，不要用默认 index=0 覆盖 URL 深链接指定的关卡。
  if (levels.length > 0) gameIndices[current.id] = index
  current = bundles[id]
  app.dataset.game = id
  updateTutorialToggle()
  updateAnimationToggle()
  updateThemeToggle()
  rulesTitle.textContent = '《109.5°》全部规则'
  for (const ruleBook of app.querySelectorAll<HTMLElement>('[data-rules-game]')) {
    ruleBook.classList.toggle('hidden', ruleBook.dataset.rulesGame !== id)
  }
  levels = loadLevels(filesFor(id), current.def.parseLevel)
  // 换关重进：清掉预演 / Inspect 瞬态，退出标记模式
  for (const b of Object.values(bundles)) b.setPreview?.(null)
  setChemInspect(null)
  clearInspectTimer()
  setMarkMode(false)
  markBtn.classList.toggle('hidden', current.supportsMarks !== true)
  closePicker()
  openLevel(gameIndices[id] ?? 0)
}

function applyDir(dir: Dir): void {
  const def = current.def
  if (def.isWin(hist.current)) return
  const transition = current.resolveStep?.(hist.current, dir) ?? null
  const next = transition?.state ?? def.step(hist.current, dir)
  if (def.stateKey(next) === def.stateKey(hist.current)) {
    current.setTransition?.(null)
    current.onBlocked?.(dir) // 无效果输入：交给游戏渲染层做反馈（抖动/红闪）
    blockedFeedbackUntil = performance.now() + BLOCKED_FEEDBACK_MS // 抖动期间全速重绘
    tutorialEvent = { kind: 'blocked', dir }
    updateTutorial()
    return
  }
  tutorialEvent = null
  if (
    current.id === 'chem' &&
    (index === 2 || index === 26) &&
    (hist.current as { holding?: string | null }).holding === null &&
    (next as { holding?: string | null }).holding !== null
  ) {
    tutorialIntroBeat = Math.max(tutorialIntroBeat, 2)
  }
  setChemInspect(null) // 局面已变：Inspect 面板收起（design §11）
  clearInspectTimer()
  const lv999 = current.id === 'chem' && isLv999Level()
  const lv999BeforeStage = lv999 ? (hist.current as { stage: number }).stage : -1
  current.setTransition?.(transition)
  hist.push(next)
  draw()
  updateHud()
  pulseBudgetAlarm()
  if (lv999) notifyLv999Progress(next as { stage: number; moves: number }, lv999BeforeStage)
  if (def.isWin(next)) scheduleWinOverlay()
}

function doUndo(): void {
  if (!hist.canUndo) return
  cancelWinReveal()
  current.setTransition?.(null)
  current.resetAnim?.()
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
  if (index < visibleLevelCount() - 1) openLevel(index + 1)
}

function prevLevel(): void {
  if (index > 0) openLevel(index - 1)
}

// ---------- 输入模型（design §11）：tap=执行 / hold=预演 / 键盘松开=取消 · 指针松开=执行 / Esc=取消 ----------
// 预演 = 壳层对当前局面求一次 step 后把 ghost 态交给渲染层；不碰任何游戏规则。

/** 计算并注入一步预演态；无效果动作（stateKey 不变）不画 ghost */
function showPreview(dir: Dir): void {
  const def = current.def
  if (def.isWin(hist.current)) return
  const transition = current.resolveStep?.(hist.current, dir) ?? null
  const next = transition?.state ?? def.step(hist.current, dir)
  if (def.stateKey(next) === def.stateKey(hist.current)) {
    current.setPreview?.(null)
    tutorialEvent = null
  } else {
    current.setPreview?.(transition ?? next, pending?.origin ?? 'pointer')
    tutorialEvent = { kind: 'preview', dir }
  }
  updateTutorial()
}

function clearPreview(): void {
  current.setPreview?.(null)
}

/** 方向按下：若正按住别的方向，先处理它（未预演=换键滚动提交；预演中=取消，不偷偷执行），再开始新的等待 */
function dirDown(dir: Dir, origin: 'key' | 'pointer' = 'key'): void {
  if (!overlay.classList.contains('hidden')) return // 胜利面板显示时不吃方向输入
  if (advanceTutorialIntro()) return
  if (bufferDirectionDuringAnimation(dir)) return
  if (pending && pending.dir === dir) return // 键盘连发（repeat）忽略
  let fromPreviewSwitch = false
  if (pending && pending.dir !== dir) {
    if (pending.previewing) {
      cancelPending() // 预演中的意图不因换键被偷偷执行
      fromPreviewSwitch = true // 接续方向的首拍只用于查看：松开取消，重新轻点才执行
    } else {
      commitPending()
    }
    if (bufferDirectionDuringAnimation(dir)) return
  }
  if (!overlay.classList.contains('hidden')) return // 提交可能刚好通关
  pending = { dir, downAt: performance.now(), previewing: false, origin, fromPreviewSwitch }
}

/** 方向松开（指针路径：拖拽 / 触屏方向键）：快速点按直接执行；预演中松开 = 执行。
 *  换键打断预演后的接续方向在松开时取消——换键手势链永不执行任何步。 */
function dirUp(dir: Dir): void {
  if (!pending || pending.dir !== dir) return
  if (pending.fromPreviewSwitch && !pending.previewing) {
    cancelPending()
    return
  }
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
  clearBufferedDir()
  clearPreview()
  tutorialEvent = null
  updateTutorial()
}

function clearBufferedDir(): void {
  inputBuffer.clear()
  for (const button of app.querySelectorAll<HTMLButtonElement>('.dpad-key')) {
    button.classList.remove('input-buffered')
  }
}

/** 返回 true 表示方向已进入 1× 的单步缓冲，不应立刻建立 pending / 改变状态。 */
function bufferDirectionDuringAnimation(dir: Dir): boolean {
  if (
    current.id !== 'chem' ||
    chemAnimationMode !== 'clear' ||
    current.def.isWin(hist.current) ||
    (current.animationRemainingMs?.() ?? 0) <= 0
  ) {
    return false
  }
  inputBuffer.queue(dir)
  for (const button of app.querySelectorAll<HTMLButtonElement>('.dpad-key')) {
    button.classList.toggle('input-buffered', button.dataset.dir === dir)
  }
  return true
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
  if (advanceTutorialIntro()) return
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
  { start: 0, end: 5, label: '核心搬运' },
  { start: 6, end: 11, label: '共振' },
  { start: 12, end: 16, label: '光格与阶段' },
  { start: 17, end: 22, label: '三臂空穴' },
  { start: 23, end: 28, label: '弹射中心' },
  { start: 29, end: 35, label: '阶段护罩' },
  { start: 36, end: 42, label: '撞结构与再生护罩' },
  { start: 43, end: 49, label: '综合' },
  { start: 50, end: 55, label: '通关后·进阶综合' },
  { start: 56, end: 65, label: '通关后·全机制组合' },
  { start: 66, end: 73, label: '通关后·转辙与红线' },
  { start: 74, end: 74, label: '隐藏挑战' },
] as const

// 「??? 未知扇区」诱饵：发现前顶替 LV.999 入口。点击只回访问拒绝；
// 连点 9 次作为触屏友好兜底（999 母题），第 9 次直接接入隐藏挑战。
let lv999BaitClicks = 0
function onLv999BaitClick(): void {
  lv999BaitClicks += 1
  if (lv999BaitClicks >= 9) {
    enterLv999()
    return
  }
  toast(
    lv999BaitClicks >= 5 ? '> ……还在试？' : '> ??? · 扇区不存在或无权访问',
    2600,
    'lv999-warn',
  )
}

function buildPicker(): void {
  pickerEl.innerHTML = ''
  levels.forEach((l, i) => {
    const chapter = current.id === 'chem' ? CHEM_CHAPTERS.find((c) => c.start === i) : undefined
    const meta = l.level as { id?: string; name?: string }
    const lv999 = current.id === 'chem' && meta.id === LV999_LEVEL_ID
    const lv999Hidden = lv999 && !lv999Discovered
    if (chapter) {
      const heading = document.createElement('div')
      heading.className = 'level-chapter'
      const range =
        chapter.start === 74
          ? lv999Discovered
            ? 'LV.999'
            : '???'
          : `${String(chapter.start + 1).padStart(2, '0')}–${String(chapter.end + 1).padStart(2, '0')}`
      const label = chapter.start === 74 && !lv999Discovered ? '未知扇区' : chapter.label
      heading.innerHTML = `<span>${range}</span><strong>${label}</strong>`
      pickerEl.appendChild(heading)
    }
    const btn = document.createElement('button')
    const isComplete = completed.has(levelProgressKey(current.id, i))
    btn.className = [
      'level-item',
      i === index ? 'active' : '',
      isComplete && !lv999Hidden ? 'complete' : '',
      lv999 ? 'lv999' : '',
      lv999Hidden ? 'lv999-bait' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const number = document.createElement('span')
    number.className = 'level-item-number'
    number.textContent = lv999Hidden ? '???' : lv999 ? 'LV.999' : String(i + 1).padStart(2, '0')
    const name = document.createElement('span')
    name.className = 'level-item-name'
    name.textContent = lv999Hidden ? '∅∅∅ // 访问受限' : (meta.name ?? meta.id ?? '')
    const mark = document.createElement('span')
    mark.className = 'level-item-mark'
    mark.textContent = isComplete && !lv999Hidden ? '✓' : '→'
    btn.append(number, name, mark)
    btn.title = lv999Hidden ? '???' : (meta.id ?? '')
    btn.addEventListener('click', () => {
      if (lv999Hidden) {
        onLv999BaitClick()
        return
      }
      openLevel(i)
      closePicker()
    })
    pickerEl.appendChild(btn)
  })
}

function syncModalState(): void {
  const modalOpen = !pickerBackdrop.classList.contains('hidden') || !rulesBackdrop.classList.contains('hidden')
  document.body.classList.toggle('modal-open', modalOpen)
}

function openPicker(): void {
  rulesBackdrop.classList.add('hidden')
  buildPicker()
  pickerBackdrop.classList.remove('hidden')
  syncModalState()
  ;(pickerEl.querySelector('.level-item.active') as HTMLButtonElement | null)?.focus()
}

function closePicker(): void {
  pickerBackdrop.classList.add('hidden')
  syncModalState()
}

function togglePicker(): void {
  if (pickerBackdrop.classList.contains('hidden')) openPicker()
  else closePicker()
}

function openRules(): void {
  cancelPending()
  pickerBackdrop.classList.add('hidden')
  rulesBackdrop.classList.remove('hidden')
  syncModalState()
  rulesClose.focus()
}

function closeRules(): void {
  rulesBackdrop.classList.add('hidden')
  syncModalState()
  rulesBtn.focus()
}

function toggleRules(): void {
  if (rulesBackdrop.classList.contains('hidden')) openRules()
  else closeRules()
}

// ---------- solver 提示（design §10「玩家辅助」：从当前局面实时求解，不写手打攻略） ----------

const DIR_TEXT: Record<string, string> = {
  N: '↑（上）',
  E: '→（右）',
  S: '↓（下）',
  W: '←（左）',
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
function toast(msg: string, ms = 5000, tone?: 'lv999' | 'lv999-warn'): void {
  toastEl.textContent = msg
  if (tone === undefined) {
    delete toastEl.dataset.tone
  } else {
    // 先摘再挂同名属性并强制回流，让骇客变体的入场动画每次从头播放
    delete toastEl.dataset.tone
    void toastEl.offsetWidth
    toastEl.dataset.tone = tone
  }
  toastEl.classList.remove('hidden')
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms)
}
function hideToast(): void {
  toastEl.classList.add('hidden')
  delete toastEl.dataset.tone
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
hintBtn.addEventListener('click', requestStepHint)
rulesBtn.addEventListener('click', toggleRules)
animationToggle.addEventListener('click', () => {
  setAnimationMode(chemAnimationMode === 'clear' ? 'fast' : 'clear')
})
tutorialToggle.addEventListener('click', () => {
  setTutorialEnabled(!tutorialEnabled)
})
themeToggle.addEventListener('click', () => {
  if (isLv999Level()) {
    toast('LV.999 已锁定满级主题；离开本关后会恢复你的明暗偏好。')
    return
  }
  setDarkMode(effectiveTheme() !== 'dark')
})
systemDarkQuery.addEventListener('change', () => {
  if (themePreference === null) updateThemeToggle()
})
levelsBtn.addEventListener('click', togglePicker)
;(app.querySelector('#picker-close') as HTMLButtonElement).addEventListener('click', closePicker)
pickerBackdrop.addEventListener('click', (e) => {
  if (e.target === pickerBackdrop) closePicker()
})
rulesClose.addEventListener('click', closeRules)
rulesBackdrop.addEventListener('click', (e) => {
  if (e.target === rulesBackdrop) closeRules()
})
nextAfterWin.addEventListener('click', () => {
  if (index >= visibleLevelCount() - 1) restart()
  else nextLevel()
})
replayAfterWin.addEventListener('click', restart)
viewAfterWin.addEventListener('click', viewBoard)
winSecretHint.addEventListener('click', () => {
  cancelWinSecretHint()
  enterLv999()
})
winbarReplay.addEventListener('click', restart)
winbarOpen.addEventListener('click', reopenOverlay)
winbarNext.addEventListener('click', () => {
  if (index >= visibleLevelCount() - 1) restart()
  else nextLevel()
})
winbarClose.addEventListener('click', hideWinbar)
tutorialClose.addEventListener('click', () => setTutorialCollapsed(true))
tutorialReopen.addEventListener('click', () => setTutorialCollapsed(false))

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
    dirDown(dir, 'pointer')
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
    if (advanceTutorialIntro()) return
    if (bufferDirectionDuringAnimation(dir)) return
    hideToast()
    applyDir(dir)
  })
}

// 触屏棋盘（design §11）：拖拽 ≥24px 先锁定方向，快速松手直接执行；
// 保持方向 ≥280ms 才显示预演。拖回起点 = 取消；短距离轻点 = Inspect / 标记。
let swipeStart: { x: number; y: number; pointerId: number; engaged: boolean; buffered: boolean } | null = null

canvas.addEventListener('pointerdown', (e) => {
  observePointerInput(e)
  swipeStart = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, engaged: false, buffered: false }
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  if (!swipeStart || swipeStart.pointerId !== e.pointerId) return
  if (isTutorialIntroAwaiting()) return
  const dx = e.clientX - swipeStart.x
  const dy = e.clientY - swipeStart.y
  if (Math.hypot(dx, dy) < SWIPE_DISTANCE) {
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
  if (bufferDirectionDuringAnimation(dir)) {
    swipeStart.buffered = true
    pending = null
    clearPreview()
    return
  }
  if (!pending || pending.dir !== dir) {
    // 变向 = 替换意图并重新计时，不提交旧方向；停留到阈值后由 frame 注入预演。
    clearPreview()
    tutorialEvent = null
    pending = { dir, downAt: performance.now(), previewing: false, origin: 'pointer' }
    updateTutorial()
  }
})
canvas.addEventListener('pointerup', (e) => {
  if (!swipeStart || swipeStart.pointerId !== e.pointerId) return
  const start = swipeStart
  swipeStart = null
  if (advanceTutorialIntro()) return
  const dx = e.clientX - start.x
  const dy = e.clientY - start.y
  const distance = Math.hypot(dx, dy)
  // 极快的 fling 可能在越过阈值后没有派发 pointermove；在松手点补一次方向判定。
  if (!start.engaged && distance >= SWIPE_DISTANCE) {
    const dir = swipeDir(dx, dy)
    if (dir) {
      recordTouchKonamiSwipe(dir)
      if (bufferDirectionDuringAnimation(dir)) return
      pending = { dir, downAt: performance.now(), previewing: false, origin: 'pointer' }
      hideToast()
      commitPending()
    }
    return
  }
  if (start.buffered && distance >= SWIPE_DISTANCE) return
  if (start.engaged && distance >= SWIPE_DISTANCE && pending) {
    recordTouchKonamiSwipe(pending.dir)
    hideToast()
    dirUp(pending.dir) // 松开 = 执行
    return
  }
  if (start.engaged) {
    cancelPending() // 拖回起点 = 取消
    return
  }
  // 秘籍尾拍：滑动序列已命中且 3 秒内双击棋盘 → 接入隐藏挑战
  if (touchKonamiArmedAt > 0) {
    const tapAt = performance.now()
    if (tapAt - touchKonamiArmedAt <= 3000) {
      if (tapAt - touchKonamiLastTapAt <= 500) {
        touchKonamiArmedAt = 0
        enterLv999()
        return
      }
      touchKonamiLastTapAt = tapAt
    } else {
      touchKonamiArmedAt = 0
    }
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
  trackKonamiKeydown(e)
  if (!pickerBackdrop.classList.contains('hidden')) {
    if (e.key === 'Escape') closePicker()
    return
  }
  if (!rulesBackdrop.classList.contains('hidden')) {
    if (e.key === 'Escape' || e.key === 'g' || e.key === 'G') closeRules()
    return
  }
  if (isTutorialIntroAwaiting() && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    advanceTutorialIntro()
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
    requestStepHint()
    return
  }
  if (e.key === 'g' || e.key === 'G') {
    e.preventDefault()
    toggleRules()
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

// 方向键松开：快速点按执行；预演中松开 = 取消——键盘没有「拖回原位 / 移出按钮」式的
// 位置性取消，松开取消让放弃与轻点确认一样便宜（拖拽 / 触屏方向键仍走 dirUp 的松开=执行）。
window.addEventListener('keyup', (e) => {
  if (visualBlindMode) {
    e.preventDefault()
    return
  }
  const dir = dirFromKey(e)
  if (dir) {
    e.preventDefault()
    if (pending?.dir === dir && pending.previewing) cancelPending()
    else dirUp(dir)
  }
})

// 失焦：清掉按住状态，避免回来后误执行
window.addEventListener('blur', cancelPending)

// ---------- 隐藏关控制台彩蛋 + dev 调试接口 ----------
// 正式版即暴露 __lexin.lv999.enter() / .state()，并在控制台留一条主题化邀请（design §5 四次决策：
// 控制台是骇客的主场，打开 devtools 的玩家正是彩蛋的目标受众）；reset / discover 仍仅限开发构建。
declare global {
  interface Window {
    __lexin?: {
      lv999: {
        /** 接入隐藏挑战（任何状态可用；正在其中时只回一句终端台词） */
        enter(): void
        /** 当前发现状态与所在关卡 */
        state(): { discovered: boolean; levelIndex: number; baitClicks: number }
        /** 重置为未发现（仅 dev）；若正身处隐藏关则跳回 50《终局》便于复测面包屑 */
        reset?(): void
        /** 标记为已发现（仅 dev，不跳转），用于反向复测发现后的 UI 恢复 */
        discover?(): void
      }
    }
  }
}

window.__lexin = {
  lv999: {
    enter: () => {
      if (isLv999Level()) {
        console.info('[lexin] > 你已经在这里了')
        return
      }
      console.info('[lexin] > 隐藏挑战已接入 · LV.999')
      enterLv999()
    },
    state: () => ({ discovered: lv999Discovered, levelIndex: index, baitClicks: lv999BaitClicks }),
  },
}

/** 正式版与 dev 都输出的主题化终端邀请（dev 便于直接调试彩蛋观感） */
function printLv999ConsoleInvite(): void {
  const art = [
    '█    █   █    ████ ████ ████',
    '█    █   █    █  █ █  █ █  █',
    '█    █   █    ████ ████ ████',
    '█     █ █  ██    █    █    █',
    '████   █   ██ ████ ████ ████',
  ].join('\n')
  console.info(
    `%c${art}\n\n> PUNKLORDE TERMINAL v9.99\n> 检测到空闲扇区……\n> __lexin.lv999.enter()   // 仅限无敌玩家`,
    'color:#bd7cff;font-family:ui-monospace,Menlo,Consolas,monospace;',
  )
}

if (import.meta.env.DEV) {
  const refreshLv999Ui = (): void => {
    updateHud()
    if (!pickerBackdrop.classList.contains('hidden')) buildPicker()
  }
  window.__lexin.lv999.reset = () => {
    try {
      progressStore?.removeItem(LV999_DISCOVERED_KEY)
    } catch {
      /* 存储不可用时仅重置内存态 */
    }
    lv999Discovered = false
    lv999BaitClicks = 0
    if (isLv999Level()) openLevel(49) // 面包屑在 50《终局》的通关卡上
    else refreshLv999Ui()
    console.info('[lexin] LV.999 已重置为未发现')
  }
  window.__lexin.lv999.discover = () => {
    markLv999Discovered()
    refreshLv999Ui()
    console.info('[lexin] LV.999 已标记为发现')
  }
  printLv999ConsoleInvite()
  console.info('[dev] 隐藏关调试：__lexin.lv999.enter() / .reset() / .discover() / .state()')
} else {
  printLv999ConsoleInvite()
}

const requestedGame = searchParams.get('game')
const initialGame = requestedGame !== null && Object.hasOwn(bundles, requestedGame) ? requestedGame : 'chem'
const requestedLevel = Number.parseInt(searchParams.get('level') ?? '', 10)
if (Number.isFinite(requestedLevel)) gameIndices[initialGame] = Math.max(0, requestedLevel - 1)
loadGame(initialGame)
requestAnimationFrame(frame)
