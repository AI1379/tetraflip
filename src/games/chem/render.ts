import { DIR_VEC, cellKey, opposite } from '../../core/protocol'
import type { Dir, Vec } from '../../core/protocol'
import { Tweens, easeInOutQuad, easeOutCubic } from '../../core/tween'
import { getEjectionPreview, isShielded, peekFlip, stateKey } from './engine'
import type {
  ChemAttackEvent,
  ChemCenterState,
  ChemEjectionEvent,
  ChemFlipEvent,
  ChemState,
  ChemStepResult,
} from './engine'
import type { ChemEjectionPreview } from './engine'
import type { CenterKind } from './level'

/**
 * 《109.5°》渲染（design §10 轻包装：化学味、零美术素材、全程序化 Canvas）。
 *
 * - 中心画成分子骨架风格：细键线 + 原子点（中心原子 + 臂原子）；三臂中心以三角核区分。
 * - 开口以中心核内的白色短箭头标记（指向进攻方向；固定在旋转中心上，避免被进攻位玩家遮挡）。
 * - 相邻中心画「共轭键」：面对臂同色时点亮（共振可传导），否则暗色（v2 玩法信息）。
 * - v3.2/v4 特殊信息：光照格（金色放射纹）；阶段护罩中心画六边形罩；
 *   再生护罩常显休眠轮廓与通往控制臂的彩色因果线；
 *   分步目标当前段正常虚线圈、未来段淡圈预告。
 * - 背景：极低透明度的四面体线框（标题《109.5°》的几何本体，纯装饰，缓慢自转）。
 * - 可读性：色珠同时使用颜色与内部纹样编码；玩家用亮环暗芯轮廓，与色珠 / 中心 / 目标区分。
 * - 手感：行走补间、整体 180° 翻转动画（连锁时按传播距离阶梯延迟；三臂中心的缺口也随骨架转动）、
 *   无效进攻抖动 + 撞面红闪；已达标中心画锁定圈 + ✓ 徽标。
 * - 动画状态是渲染层私有时钟（只读游戏状态、绝不改状态）；stateKey 只负责发现状态切换，
 *   翻转源头、真实传播边与层级由引擎 `resolveChemStep` 的一次性事件轨迹提供。
 * - 纪律：装饰不压缩棋盘，不与玩法信息——开口箭头 / 目标虚线 / 共轭键 / 锁定徽标 / 特殊格——竞争。
 * - 全程不出现化学术语/化学式文字。
 *
 * 认知外置层（design §11，2026-08-24）：
 * - **按住预演**（`setChemPreview`，壳层注入 step(当前态, 按住方向)）：棋盘压暗，变化的中心以正式执行同款
 *   翻转动画过渡到「动作后构型」ghost 态（虚线晕圈标记尚未发生），共振链按相邻 BFS 距离标 ①②③；
 *   手持换出物 / 场上珠增减画 ghost；目标 ✓ 锁定圈按预演后状态判定。光照格与阶段护罩
 *   全部走通用 diff，规则零特判。
 * - **Inspect**（`setChemInspect` + `chemHitTest`）：点按中心显示完整模 2 构型周期——现在 / 翻一次后，
 *   三臂中心同时显示缺口移动，当前态高亮（读引擎纯函数 peekFlip）。
 * - **标记**（`setChemMarks`）：玩家自笔记——中心顺序标 ①–⑤，任意格 ★/？/×；常显、不进引擎状态。
 * 以上三者均为渲染层只读状态，绝不修改游戏状态。
 */

export type ChemRenderTheme = 'dark' | 'light' | 'lv999'

interface ChemRenderPalette {
  colors: Readonly<Record<string, string>>
  stageTones: readonly string[]
  canvas: string
  board: string
  grid: string
  wall: string
  wallHatch: string
  ink: string
  bond: string
  faint: string
  tetra: string
  flash: string
  impact: string
  playerCore: string
  panel: string
  panelMuted: string
  anchorFill: string
  previewVeil: string
  previewPanel: string
  previewBorder: string
  markFill: string
  lockCheck: string
  centerOutline: string
  atomOutline: string
  atomPattern: string
  lightCell: string
}

export const CHEM_PALETTES: Record<ChemRenderTheme, ChemRenderPalette> = {
  dark: {
    colors: {
      red: '#ff6369',
      blue: '#5da9ff',
      green: '#58d68d',
      yellow: '#f6c85f',
      purple: '#c084fc',
    },
    stageTones: ['#f0c65a', '#63b3ff', '#c084fc', '#58d68d', '#ff8f70'],
    canvas: '#0b1018',
    board: 'rgba(18, 27, 39, 0.72)',
    grid: '#202b39',
    wall: '#303b4a',
    wallHatch: 'rgba(139, 149, 165, 0.16)',
    ink: '#f2f4f8',
    bond: '#55617a',
    faint: '#39424f',
    tetra: '#4f8ef7',
    flash: '#e5484d',
    impact: '#8ad5ff',
    playerCore: '#111923',
    panel: 'rgba(13, 19, 28, 0.94)',
    panelMuted: '#8d9aab',
    anchorFill: '#10161f',
    previewVeil: 'rgba(7, 10, 15, 0.42)',
    previewPanel: 'rgba(13, 19, 28, 0.92)',
    previewBorder: 'rgba(240, 198, 90, 0.55)',
    markFill: '#10161f',
    lockCheck: '#0b1018',
    centerOutline: '#8b95a5',
    atomOutline: 'rgba(0, 0, 0, 0.42)',
    atomPattern: 'rgba(7, 10, 15, 0.62)',
    lightCell: '#e0b64f',
  },
  light: {
    // 清亮填色（#52 决策，2026-08-28 真人复测确认：压暗追对比度会显脏，已回退）。
    // 可读性由 atomOutline / atomPattern 深墨轮廓与纹样双编码承担（design §10 红线：
    // 黄/绿/盾阶段色不得退成褐灰；不要求填充色单独满足正文对比度）。
    colors: {
      red: '#ec4f5f',
      blue: '#2b8bd8',
      green: '#2fa866',
      yellow: '#d99a16',
      purple: '#9768d4',
    },
    stageTones: ['#d39516', '#2f8ed8', '#9867d4', '#35a66a', '#e16b4f'],
    canvas: '#f3f8fb',
    board: 'rgba(255, 255, 255, 0.94)',
    grid: '#d7e4ec',
    wall: '#c8d5de',
    wallHatch: 'rgba(67, 91, 108, 0.16)',
    ink: '#294052',
    // 暗键 / 空穴圈 / 手持键线用低 alpha 绘制：底色保持清亮灰蓝，存在感靠 dimBondAlpha 抬高
    bond: '#8ba2b4',
    faint: '#b6c7d2',
    tetra: '#76b7d9',
    flash: '#ee4054',
    impact: '#248dce',
    playerCore: '#fbfdff',
    panel: 'rgba(255, 255, 255, 0.97)',
    panelMuted: '#6d8292',
    anchorFill: '#f9fcfe',
    previewVeil: 'rgba(237, 244, 248, 0.5)',
    previewPanel: 'rgba(255, 255, 255, 0.97)',
    previewBorder: 'rgba(180, 122, 0, 0.6)',
    markFill: '#ffffff',
    lockCheck: '#ffffff',
    centerOutline: '#7890a2',
    // 浅色描边不再使用：drawAtom 改用 shadeColor(填充色) 派生同相深色环（藏青圈 × 暖黄会显脏）。
    // 字段保留给深主题与接口完整性。
    atomOutline: 'rgba(29, 48, 62, 0.34)',
    // 纹样是色弱双编码的实际承担者：保持深中性色，但透明度从 0.78 回落到 0.55，避免珠面挂霜
    atomPattern: 'rgba(43, 38, 30, 0.55)',
    lightCell: '#dfa723',
  },
  lv999: {
    colors: {
      red: '#ff5e7a',
      blue: '#58d9ff',
      green: '#52f7b6',
      yellow: '#ffd866',
      purple: '#bd7cff',
    },
    stageTones: ['#bd7cff', '#58d9ff', '#ff5edb', '#ffd866', '#52f7b6'],
    canvas: '#080413',
    board: 'rgba(24, 9, 43, 0.84)',
    grid: '#332054',
    wall: '#41295f',
    wallHatch: 'rgba(142, 90, 255, 0.2)',
    ink: '#f4efff',
    bond: '#765da1',
    faint: '#432e64',
    tetra: '#9c6cff',
    flash: '#ff4fb8',
    impact: '#65e9ff',
    playerCore: '#10071d',
    panel: 'rgba(15, 6, 29, 0.96)',
    panelMuted: '#b6a5d4',
    anchorFill: '#120821',
    previewVeil: 'rgba(8, 2, 18, 0.5)',
    previewPanel: 'rgba(17, 7, 32, 0.95)',
    previewBorder: 'rgba(88, 217, 255, 0.72)',
    markFill: '#120821',
    lockCheck: '#080413',
    centerOutline: '#bca8dd',
    atomOutline: 'rgba(4, 0, 12, 0.54)',
    atomPattern: 'rgba(8, 2, 18, 0.68)',
    lightCell: '#ff5edb',
  },
}

/** 浅色低亮度元素的透明度补偿：负面 / 休眠信息不能在浅底上隐形，但不再压暗色相（v5 修订）。 */
const dimBondAlpha = (): number => (renderTheme === 'light' ? 0.66 : 0.5)
const idleShieldAlpha = (): number => (renderTheme === 'light' ? 0.6 : 0.34)
const idleLinkAlpha = (): number => (renderTheme === 'light' ? 0.5 : 0.32)
const futureGoalAlpha = (): number => (renderTheme === 'light' ? 0.32 : 0.22)

let renderTheme: ChemRenderTheme = 'dark'
let palette = CHEM_PALETTES.dark
const colorOf = (name: string): string => palette.colors[name] ?? palette.colors.purple

const SHAKE_MS = 240 // 无效进攻抖动时长

export type ChemAnimationMode = 'clear' | 'fast'

interface AnimationTiming {
  walkMs: number
  contactMs: number
  exchangeMs: number
  flipMs: number
  hopMs: number
  ejectMsPerCell: number
  shieldBurstMs: number
  shieldPauseMs: number
  impactMs: number
}

const ANIMATION_TIMINGS: Record<ChemAnimationMode, AnimationTiming> = {
  clear: {
    walkMs: 140,
    contactMs: 120,
    exchangeMs: 360,
    flipMs: 420,
    // 下一级等上一级完整落定，再留一小拍显示刚接通的共振键。
    hopMs: 470,
    ejectMsPerCell: 120,
    shieldBurstMs: 520,
    // R 盾打开后留出独立一拍，再让刚解锁的中心开始转动。
    shieldPauseMs: 180,
    impactMs: 220,
  },
  fast: {
    walkMs: 110,
    contactMs: 80,
    exchangeMs: 0,
    flipMs: 260,
    hopMs: 90,
    ejectMsPerCell: 90,
    shieldBurstMs: 420,
    shieldPauseMs: 0,
    impactMs: 150,
  },
}

let animationMode: ChemAnimationMode = 'clear'
const animationTiming = (): AnimationTiming => ANIMATION_TIMINGS[animationMode]
const ARM_LEN = 0.46 // 普通臂长（格）：收在中心附近，避免与进攻位上的玩家重叠
const ARM_LEN_SHORT = 0.34 // 相邻中心侧进一步缩短，留出共振键
const TETRA_SPIN = 0.00012 // 背景四面体自转（rad/ms）

/**
 * Canvas 小字号不能依赖 Unicode 圈号或浏览器的等宽字体回退：不同系统会得到完全不同的字面框。
 * 阶段 / 连锁编号统一使用窄体无衬线数字，中文说明统一走系统中文黑体栈。
 */
const CANVAS_NUM_FONT = '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif'
const CANVAS_UI_FONT = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'

// ---------- 认知外置层（design §11）：预演 / Inspect / 标记（渲染层只读，不进游戏状态） ----------

/** 玩家自笔记标记：中心顺序标 ①–⑤；任意格 ★/？/×。含义由玩家自己理解。 */
export type ChemMark = '1' | '2' | '3' | '4' | '5' | 'star' | 'question' | 'cross'

/** 壳层按住方向时注入的一步预演态（= step(当前态, 按住方向)）；null = 无预演。 */
let preview: ChemState | null = null
let previewTransition: ChemStepResult | null = null
let previewStartedAt = 0
export function setChemPreview(next: ChemStepResult | ChemState | null): void {
  previewTransition = next !== null && 'state' in next ? next : null
  preview = previewTransition?.state ?? (next as ChemState | null)
  previewStartedAt = preview === null ? 0 : performance.now()
}

/** Inspect 检视的中心下标；null = 关闭面板。 */
let inspect: number | null = null
export function setChemInspect(index: number | null): void {
  inspect = index
}

/** 玩家标记（cellKey → 标记）；null = 无标记。 */
let marks: ReadonlyMap<string, ChemMark> | null = null
export function setChemMarks(map: ReadonlyMap<string, ChemMark> | null): void {
  marks = map
}

/** 棋盘布局（render 与 hitTest 共用同一份几何，保证点按命中与绘制一致）。 */
function chemLayout(s: ChemState, W: number, H: number): { cell: number; ox: number; oy: number } {
  const pad = 28
  const cell = Math.max(
    8,
    Math.floor(Math.min((W - pad * 2) / s.width, (H - pad * 2) / s.height)),
  )
  return {
    cell,
    ox: Math.floor((W - cell * s.width) / 2),
    oy: Math.floor((H - cell * s.height) / 2),
  }
}

/**
 * 点按命中检测（壳层把画布坐标换算成逻辑坐标后调用）。
 * 返回命中的中心，或普通格（用于标记模式）；棋盘外返回 null。
 */
export function chemHitTest(
  s: ChemState,
  lx: number,
  ly: number,
  W: number,
  H: number,
): { kind: 'center'; index: number } | { kind: 'cell'; x: number; y: number } | null {
  const { cell, ox, oy } = chemLayout(s, W, H)
  const x = Math.floor((lx - ox) / cell)
  const y = Math.floor((ly - oy) / cell)
  if (x < 0 || y < 0 || x >= s.width || y >= s.height) return null
  const index = s.centers.findIndex((c) => c.pos[0] === x && c.pos[1] === y)
  return index >= 0 ? { kind: 'center', index } : { kind: 'cell', x, y }
}

// ---------- 渲染层私有动画状态（不进游戏状态；撤销 / 重开显式清空） ----------

interface FlipAnim {
  center: number
  start: number
  before: ChemCenterState
  after: ChemCenterState
  source: number | null
  cause: ChemFlipEvent['cause']
  wave: number
  depth: number
  exchange?: SubstitutionAnim
}

interface SubstitutionAnim {
  start: number
  end: number
  dir: Dir
  player: Vec
  injected: string
  extracted: string
}

interface CenterPose {
  arms: Partial<Record<Dir, string>>
  leaving: Dir
  rot: number
  armRot?: Partial<Record<Dir, number>>
}

interface EjectionAnim {
  start: number
  from: Vec
  color: string
  path: readonly Vec[]
  landing: Vec
}

interface SuccessfulImpactAnim {
  start: number
  contactAt: number
  end: number
  player: Vec
  target: Vec
  dir: Dir
}

let lastKey = ''
let lastState: ChemState | null = null
let lastDims = ''
let walk = new Tweens()
const flips: FlipAnim[] = []
let pendingTransition: ChemStepResult | null = null
let shake: { start: number; dir: Dir } | null = null
let handPulse: { start: number; color: string | null } | null = null
let ejectionAnim: EjectionAnim | null = null
let successfulImpact: SuccessfulImpactAnim | null = null
const shieldBursts = new Map<number, number>()
const shieldForms = new Map<number, number>()
let animationEndsAt = 0

/**
 * 壳层用这个只读时钟等待棋盘动画结束后再展示通关卡片。
 * 返回剩余毫秒数，不把 UI 时序写进引擎状态。
 */
export function getChemAnimationRemainingMs(now = performance.now()): number {
  return Math.max(0, animationEndsAt - now)
}

/** 动画节奏与文字教程独立；切换只清空渲染时间线，不触碰游戏状态。 */
export function setChemAnimationMode(mode: ChemAnimationMode): void {
  if (animationMode === mode) return
  animationMode = mode
  resetChemAnim()
}

export function getChemAnimationMode(): ChemAnimationMode {
  return animationMode
}

/** DOM 与 Canvas 共用主题状态；切换只替换语义调色板，不进入游戏状态。 */
export function setChemRenderTheme(theme: ChemRenderTheme): void {
  if (renderTheme === theme) return
  renderTheme = theme
  palette = CHEM_PALETTES[theme]
  resetChemAnim()
}

export function getChemRenderTheme(): ChemRenderTheme {
  return renderTheme
}

export function getChemShieldTransitionPhase(
  center: number,
  now = performance.now(),
): 'waiting-release' | 'releasing' | 'waiting-form' | null {
  const releaseAt = shieldBursts.get(center)
  if (releaseAt !== undefined) {
    if (now < releaseAt) return 'waiting-release'
    if (now < releaseAt + animationTiming().shieldBurstMs) return 'releasing'
  }
  const formAt = shieldForms.get(center)
  if (formAt !== undefined && now < formAt) return 'waiting-form'
  return null
}

/** 回归测试 / 壳层诊断用：区分“等待因果拍”与中心已经开始旋转。 */
export function getChemCenterFlipPhase(
  center: number,
  now = performance.now(),
): 'waiting' | 'rotating' | null {
  const flip = flips.find(
    (candidate) =>
      candidate.center === center && now < candidate.start + animationTiming().flipMs,
  )
  if (!flip) return null
  if (now < flip.start) return 'waiting'
  if (now < flip.start + animationTiming().flipMs) return 'rotating'
  return null
}

/** 回归测试 / 诊断用：读取引擎事件已经排定的真实翻转层级，不暴露可变动画对象。 */
export function getChemFlipSchedule(): readonly {
  center: number
  source: number | null
  cause: ChemFlipEvent['cause']
  wave: number
  depth: number
  start: number
}[] {
  return flips.map(({ center, source, cause, wave, depth, start }) => ({
    center,
    source,
    cause,
    wave,
    depth,
    start,
  }))
}

export function getChemSuccessfulImpactPhase(
  now = performance.now(),
): 'approach' | 'burst' | null {
  if (!successfulImpact || now < successfulImpact.start || now >= successfulImpact.end) return null
  return now < successfulImpact.contactAt ? 'approach' : 'burst'
}

/** 无效进攻 / 撞墙反馈入口：shell 在 step 无效果（stateKey 不变）时调用 */
export function notifyChemImpact(dir: Dir): void {
  shake = { start: performance.now(), dir }
}

/** 壳层把引擎本次真实结算轨迹交给渲染时间线；下一次匹配的状态转移消费一次。 */
export function setChemTransition(transition: ChemStepResult | null): void {
  pendingTransition = transition
}

/** 换关 / 重开时清除渲染层跨关卡动画状态，避免把“上一关的 1 步胜利”误判成当前关的步进动画 */
export function resetChemAnim(): void {
  lastKey = ''
  lastState = null
  lastDims = ''
  walk = new Tweens()
  flips.length = 0
  pendingTransition = null
  shake = null
  handPulse = null
  ejectionAnim = null
  successfulImpact = null
  shieldBursts.clear()
  shieldForms.clear()
  animationEndsAt = 0
}

const rotateArms = (arms: Partial<Record<Dir, string>>): Partial<Record<Dir, string>> => {
  const rotated: Partial<Record<Dir, string>> = {}
  for (const d of ['N', 'E', 'S', 'W'] as const) {
    const color = arms[d]
    if (color !== undefined) rotated[opposite(d)] = color
  }
  return rotated
}

/** 臂方向的基准角（屏幕坐标系，N 朝上） */
const ARM_ANGLE: Record<Dir, number> = { N: -Math.PI / 2, E: 0, S: Math.PI / 2, W: Math.PI }

/** 臂方向的单位向量（屏幕坐标系，N 朝上）——迷你图等小件用 */
const ARM_VEC: Record<Dir, readonly [number, number]> = {
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
}

/**
 * 正式执行与预演共用的翻转姿态口径：四臂 / 三臂中心都将现存结构整体旋转半圈。
 * progress 可小于 0（连锁尚未轮到）或大于 1（已经落到动作后构型）。
 */
function flipPose(
  before: ChemCenterState,
  after: ChemCenterState,
  progress: number,
): CenterPose {
  if (progress >= 1) return { arms: after.arms, leaving: after.leaving, rot: 0 }

  const e = easeInOutQuad(Math.max(0, progress))
  return {
    // 与正式动画一致：取代色先进入翻转前臂面，再随骨架旋转到最终位置。
    arms: rotateArms(after.arms),
    leaving: before.leaving,
    rot: Math.PI * e,
  }
}

function flipAnimationPose(
  flip: FlipAnim,
  now: number,
  timing: AnimationTiming,
): CenterPose | null {
  const progress = (now - flip.start) / timing.flipMs
  if (progress >= 1) return null
  if (flip.exchange && now < flip.start) {
    const arms = { ...flip.before.arms }
    if (now >= flip.exchange.start) delete arms[flip.exchange.dir]
    return { arms, leaving: flip.before.leaving, rot: 0 }
  }
  return flipPose(flip.before, flip.after, progress)
}

/**
 * 由 stateKey 变化驱动动画外壳；翻转的源头、传播边与层级只读取引擎 transition，
 * 不再从前后状态差值猜测。大跳（撤销 / 重开 / 换关）没有匹配轨迹，直接重置。
 */
function sync(s: ChemState, now: number): void {
  const dims = `${s.width}x${s.height}`
  if (dims !== lastDims) {
    lastDims = dims
    lastState = null
    lastKey = ''
    walk = new Tweens()
    flips.length = 0
    pendingTransition = null
    shake = null
    handPulse = null
    ejectionAnim = null
    successfulImpact = null
    shieldBursts.clear()
    shieldForms.clear()
  }
  const key = stateKey(s)
  if (lastState && key !== lastKey) {
    const prev = lastState
    const timing = animationTiming()
    const dist =
      Math.abs(s.player[0] - prev.player[0]) + Math.abs(s.player[1] - prev.player[1])
    const transition = pendingTransition?.state === s ? pendingTransition : null
    pendingTransition = null
    if (s.moves === prev.moves + 1 && dist <= 1) {
      flips.length = 0
      if (s.player[0] !== prev.player[0] || s.player[1] !== prev.player[1]) {
        walk.set('px', s.player[0], now, timing.walkMs, easeOutCubic, prev.player[0])
        walk.set('py', s.player[1], now, timing.walkMs, easeOutCubic, prev.player[1])
        animationEndsAt = Math.max(animationEndsAt, now + timing.walkMs)
      }
      const attack = transition?.events.find(
        (event): event is ChemAttackEvent => event.type === 'attack',
      )
      const flipEvents = transition?.events.filter(
        (event): event is ChemFlipEvent => event.type === 'flip',
      ) ?? []
      const ejection = transition?.events.find(
        (event): event is ChemEjectionEvent => event.type === 'ejection',
      )
      const flightMs = ejection
        ? Math.max(1, ejection.path.length) * timing.ejectMsPerCell
        : 0
      const hasExchange =
        animationMode === 'clear' &&
        attack !== undefined &&
        attack.injected !== null &&
        attack.extracted !== null
      const exchangeStart = now + timing.contactMs
      const rootFlipStart = exchangeStart + (hasExchange ? timing.exchangeMs : 0)
      let actionEndsAt = animationEndsAt
      if (attack !== undefined) {
        successfulImpact = {
          start: now,
          contactAt: exchangeStart,
          end: exchangeStart + timing.impactMs,
          player: attack.player,
          target: prev.centers[attack.center].pos,
          dir: attack.dir,
        }
        actionEndsAt = Math.max(actionEndsAt, successfulImpact.end)
      }
      // 引擎已经给出每条真实传播边与 depth。直接波完整落定后才进入弹射飞行 / 撞核波；
      // 同 depth 分支同拍，不同 depth 只由 hopMs 控制清晰或快速重叠程度。
      const directEvents = flipEvents.filter((event) => event.wave === 0)
      const directWaveEnd = directEvents.reduce(
        (end, event) => Math.max(end, rootFlipStart + event.depth * timing.hopMs + timing.flipMs),
        rootFlipStart,
      )
      const ejectionStart = directWaveEnd
      const remoteWaveStart = ejectionStart + flightMs
      for (const event of flipEvents) {
        const waveStart = event.wave === 0 ? rootFlipStart : remoteWaveStart
        const start = waveStart + event.depth * timing.hopMs
        const exchange: SubstitutionAnim | undefined =
          hasExchange &&
          event.cause === 'attack' &&
          attack?.injected !== null &&
          attack?.extracted !== null
            ? {
                start: exchangeStart,
                end: rootFlipStart,
                dir: attack.dir,
                player: attack.player,
                injected: attack.injected,
                extracted: attack.extracted,
              }
            : undefined
        flips.push({
          center: event.center,
          start,
          before: event.before,
          after: event.after,
          source: event.source,
          cause: event.cause,
          wave: event.wave,
          depth: event.depth,
          exchange,
        })
        actionEndsAt = Math.max(actionEndsAt, start + timing.flipMs)
      }
      flips.sort((a, b) => a.start - b.start || a.depth - b.depth)
      if (ejection?.landing) {
        ejectionAnim = {
          start: ejectionStart,
          from: ejection.from,
          color: ejection.color,
          path: ejection.path,
          landing: ejection.landing,
        }
        actionEndsAt = Math.max(actionEndsAt, ejectionStart + flightMs)
      }
      let visualEndsAt = actionEndsAt
      for (let i = 0; i < s.centers.length; i++) {
        const before = prev.centers[i]
        const after = s.centers[i]
        if (!before || !after) continue
        const wasShielded = isShielded(prev, before)
        const isNowShielded = isShielded(s, after)
        if (wasShielded === isNowShielded) continue
        const controllerFlip = after.reactiveTo
          ? [...flips].reverse().find(
              (flip) =>
                flip.center === after.reactiveTo!.center &&
                flip.before.arms[after.reactiveTo!.arm] !== flip.after.arms[after.reactiveTo!.arm],
            )
          : undefined
        // R 盾由控制臂落定的瞬间驱动；阶段盾仍等整条连锁结束。
        const transitionAt = controllerFlip
          ? controllerFlip.start + timing.flipMs
          : actionEndsAt
        if (wasShielded) {
          const protectedFlip = controllerFlip
            ? flips.find((flip) => flip.center === i && flip.start >= controllerFlip.start)
            : undefined
          if (protectedFlip && timing.shieldPauseMs > 0) {
            const earliestStart = transitionAt + timing.shieldPauseMs
            const delay = earliestStart - protectedFlip.start
            if (delay > 0) {
              // 后续共振中心不能越过刚解锁的中心；把同拍及更晚的链条整体顺延。
              const downstreamStart = protectedFlip.start
              for (const flip of flips) {
                if (flip.start >= downstreamStart) flip.start += delay
              }
            }
          }
          shieldBursts.set(i, transitionAt)
          visualEndsAt = Math.max(visualEndsAt, transitionAt + timing.shieldBurstMs)
        } else {
          shieldForms.set(i, transitionAt)
          visualEndsAt = Math.max(visualEndsAt, transitionAt + 180)
        }
      }
      if (s.holding !== prev.holding) {
        const pulseStart = hasExchange ? rootFlipStart : now
        handPulse = { start: pulseStart, color: s.holding }
        actionEndsAt = Math.max(actionEndsAt, pulseStart + 220)
      }
      for (const flip of flips) {
        actionEndsAt = Math.max(actionEndsAt, flip.start + timing.flipMs)
      }
      animationEndsAt = Math.max(animationEndsAt, actionEndsAt, visualEndsAt)
    } else {
      walk = new Tweens()
      flips.length = 0
      pendingTransition = null
      handPulse = null
      ejectionAnim = null
      successfulImpact = null
      shieldBursts.clear()
      shieldForms.clear()
      animationEndsAt = 0
    }
  }
  lastState = s
  lastKey = key
}

export function render(s: ChemState, ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const now = performance.now()
  sync(s, now)
  const timing = animationTiming()
  const { cell, ox, oy } = chemLayout(s, W, H)
  const cx = (x: number): number => ox + x * cell + cell / 2
  const cy = (y: number): number => oy + y * cell + cell / 2
  const visualPoses = new Map<number, CenterPose>()
  const visualFlips = new Map<number, FlipAnim>()
  for (const center of new Set(flips.map((flip) => flip.center))) {
    const flip = flips.find(
      (candidate) => candidate.center === center && now < candidate.start + timing.flipMs,
    )
    if (!flip) continue
    const pose = flipAnimationPose(flip, now, timing)
    if (pose) {
      visualPoses.set(center, pose)
      visualFlips.set(center, flip)
    }
  }
  for (let i = flips.length - 1; i >= 0; i--) {
    if (now >= flips[i].start + timing.flipMs) flips.splice(i, 1)
  }
  const visuallyShielded = (i: number): boolean => {
    const center = s.centers[i]
    if (!center) return false
    const active = isShielded(s, center)
    const releaseAt = shieldBursts.get(i)
    if (!active && releaseAt !== undefined && now < releaseAt) return true
    const formAt = shieldForms.get(i)
    if (active && formAt !== undefined && now < formAt) return false
    return active
  }

  ctx.fillStyle = palette.canvas
  ctx.fillRect(0, 0, W, H)

  drawBackdrop(ctx, W, H, now)
  drawFrame(ctx, ox, oy, cell * s.width, cell * s.height, cell)

  // 棋盘底板与网格
  ctx.fillStyle = palette.board
  ctx.fillRect(ox, oy, cell * s.width, cell * s.height)
  ctx.strokeStyle = palette.grid
  ctx.lineWidth = 1
  for (let x = 0; x <= s.width; x++) {
    line(ctx, ox + x * cell + 0.5, oy, ox + x * cell + 0.5, oy + s.height * cell)
  }
  for (let y = 0; y <= s.height; y++) {
    line(ctx, ox, oy + y * cell + 0.5, ox + s.width * cell, oy + y * cell + 0.5)
  }

  // 墙
  for (const key of s.walls) {
    const [x, y] = key.split(',').map(Number)
    const inset = cell * 0.08
    const wx = ox + x * cell + inset
    const wy = oy + y * cell + inset
    const ws = cell - inset * 2
    ctx.fillStyle = palette.wall
    ctx.beginPath()
    ctx.roundRect(wx, wy, ws, ws, cell * 0.12)
    ctx.fill()
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(wx, wy, ws, ws, cell * 0.12)
    ctx.clip()
    ctx.strokeStyle = palette.wallHatch
    ctx.lineWidth = Math.max(1, cell * 0.025)
    for (let d = -ws; d < ws * 2; d += Math.max(7, cell * 0.18)) {
      line(ctx, wx + d, wy + ws, wx + d + ws, wy)
    }
    ctx.restore()
  }

  drawSpecialCells(ctx, s, cx, cy, cell, now)

  // 再生护罩的因果关系必须在“罩已打开”时仍可读：控制线画在中心 / 共轭键下层，
  // 端点钉在 reactiveTo 指向的具体颜色臂上，而不是只给受保护中心一个无来源的 R。
  drawReactiveLinks(ctx, s, cx, cy, cell, visualPoses, visuallyShielded)

  // 相邻中心关系（共轭）：每个中心各方向是否有相邻中心
  const neighborIdx = (i: number, d: Dir): number => {
    const c = s.centers[i]
    const [dx, dy] = DIR_VEC[d]
    return s.centers.findIndex((o) => o.pos[0] === c.pos[0] + dx && o.pos[1] === c.pos[1] + dy)
  }
  const neighborsOf = (i: number): Record<Dir, boolean> => ({
    N: neighborIdx(i, 'N') >= 0,
    E: neighborIdx(i, 'E') >= 0,
    S: neighborIdx(i, 'S') >= 0,
    W: neighborIdx(i, 'W') >= 0,
  })

  // 目标（虚线圈）：当前段正常显示，未来段淡圈预告（分步目标，v3）。
  // 臂若朝向相邻中心，圈紧扣属主中心自己的短臂原子（与普通目标圈同一「圈住原子」语法），
  // 不画在键中点——否则玩家分不清圈要求的是左侧还是右侧中心的臂色（2026-08-29 协作者反馈）。
  const drawGoal = (
    g: { center: number; arm: Dir; color: string },
    alpha: number,
    view: ChemState = s,
    stageIndex = view.stage,
  ): void => {
    const c = view.centers[g.center]
    // ✓ 已经承担“完成”提示；已满足目标圈退后，避免同一信息在局部重复抢眼。
    const ringAlpha = c.arms[g.arm] === g.color ? alpha * 0.3 : alpha
    let gx: number
    let gy: number
    if (neighborIdx(g.center, g.arm) >= 0) {
      const [dx, dy] = DIR_VEC[g.arm]
      gx = cx(c.pos[0]) + dx * cell * ARM_LEN_SHORT
      gy = cy(c.pos[1]) + dy * cell * ARM_LEN_SHORT
      // 半径收敛到 0.16：键两侧同时有目标时（如 66 段 4）两圈相切不重叠
      dashedCircle(ctx, gx, gy, cell * 0.16, colorOf(g.color), ringAlpha, goalDash(g.color))
    } else {
      const [dx, dy] = DIR_VEC[g.arm]
      gx = cx(c.pos[0]) + dx * cell * ARM_LEN
      gy = cy(c.pos[1]) + dy * cell * ARM_LEN
      dashedCircle(ctx, gx, gy, cell * 0.25, colorOf(g.color), ringAlpha, goalDash(g.color))
    }
    if (view.stages.length > 1) drawStageBadge(ctx, gx, gy, cell, stageIndex, alpha)
  }
  s.stages.forEach((st, si) => {
    if (si < s.stage) return // 已完成的段不再显示
    const alpha = si === s.stage ? 0.85 : futureGoalAlpha()
    for (const g of st.goals) drawGoal(g, alpha, s, si)
  })

  // 共轭键（v2）：相邻中心之间的连接。面对臂同色 = 点亮（共振可传导）；否则暗色。
  for (let i = 0; i < s.centers.length; i++) {
    for (const d of ['N', 'E', 'S', 'W'] as const) {
      const j = neighborIdx(i, d)
      if (j < 0 || j <= i) continue // 每对只画一次
      const ci = s.centers[i]
      const cj = s.centers[j]
      const fi = (visualPoses.get(i)?.arms ?? ci.arms)[d]
      const fj = (visualPoses.get(j)?.arms ?? cj.arms)[opposite(d)]
      if (fi === undefined || fj === undefined) continue // 三臂中心当前缺少面对臂：不连
      const [dx, dy] = DIR_VEC[d]
      const x1 = cx(ci.pos[0]) + dx * cell * ARM_LEN_SHORT
      const y1 = cy(ci.pos[1]) + dy * cell * ARM_LEN_SHORT
      const x2 = cx(cj.pos[0]) - dx * cell * ARM_LEN_SHORT
      const y2 = cy(cj.pos[1]) - dy * cell * ARM_LEN_SHORT
      const live = fi === fj
      ctx.save()
      if (live) {
        ctx.strokeStyle = palette.ink
        ctx.globalAlpha = 0.55 + 0.25 * Math.sin(now / 260)
        ctx.lineWidth = Math.max(2, cell * 0.09)
      } else {
        ctx.strokeStyle = palette.bond
        ctx.globalAlpha = dimBondAlpha()
        ctx.lineWidth = Math.max(1.5, cell * 0.05)
      }
      line(ctx, x1, y1, x2, y2)
      ctx.restore()
    }
  }

  // 游离色珠（v1 基团搬运）：小原子点 + 虚线外圈（拾取物标记）
  const flightDuration = ejectionAnim
    ? Math.max(1, ejectionAnim.path.length) * timing.ejectMsPerCell
    : 0
  if (ejectionAnim && now - ejectionAnim.start >= flightDuration) ejectionAnim = null
  for (const g of s.groups) {
    if (
      ejectionAnim &&
      g.color === ejectionAnim.color &&
      g.pos[0] === ejectionAnim.landing[0] &&
      g.pos[1] === ejectionAnim.landing[1]
    ) {
      continue
    }
    const gx = cx(g.pos[0])
    const gy = cy(g.pos[1])
    dashedCircle(ctx, gx, gy, cell * 0.26, colorOf(g.color))
    drawAtom(ctx, gx, gy, cell * 0.15, g.color)
  }

  // 中心与臂（翻转中：四臂 / 三臂结构都整体旋转 0→π，缺口随结构移动）
  // 预演（design §11）：将变化的中心会在预演层整体切换为「动作后构型」ghost，
  // 常规管线里这些中心的落点预览 / 锁定圈跳过（避免画两遍、口径不一）。
  const previewChanged: number[] = []
  const previewFlipEvents = previewTransition?.events.filter(
    (event): event is ChemFlipEvent => event.type === 'flip',
  ) ?? []
  const previewShieldReleased: number[] = []
  const previewShieldFormed: number[] = []
  if (preview && !s.won) {
    for (let i = 0; i < s.centers.length && i < preview.centers.length; i++) {
      const p = preview.centers[i]
      const c = s.centers[i]
      if (p && c && (p.arms !== c.arms || p.leaving !== c.leaving)) previewChanged.push(i)
      if (p && c && isShielded(s, c) && !isShielded(preview, p)) previewShieldReleased.push(i)
      if (p && c && !isShielded(s, c) && isShielded(preview, p)) previewShieldFormed.push(i)
    }
    for (const event of previewFlipEvents) {
      if (!previewChanged.includes(event.center)) previewChanged.push(event.center)
    }
  }
  const pendingExchange = flips
    .map((flip) => flip.exchange)
    .find((exchange): exchange is SubstitutionAnim => exchange !== undefined && now < exchange.end)
  for (let i = 0; i < s.centers.length; i++) {
    const c = s.centers[i]
    const ghosted = previewChanged.includes(i)
    const px = cx(c.pos[0])
    const py = cy(c.pos[1])
    const flip = visualFlips.get(i)
    const visualPose = visualPoses.get(i)
    const rot = visualPose?.rot ?? 0
    const arms = visualPose?.arms ?? c.arms
    const leaving = visualPose?.leaving ?? c.leaving
    const armRot = visualPose?.armRot
    drawCenter(ctx, px, py, cell, arms, leaving, rot, neighborsOf(i), c.kind, c.ejects, armRot)
    if (flip?.exchange && now >= flip.exchange.start && now < flip.exchange.end) {
      drawSubstitutionTransfer(ctx, flip.exchange, px, py, cx, cy, cell, now)
    }

    // 持珠且已经站到合法进攻位：用手持色预览本次染色最终落到哪条臂。
    // 只做渲染提示，不提前计算或修改游戏状态。（ghost 中心改由预演层绘制）
    if (!ghosted && s.holding !== null && !isShielded(s, c)) {
      const [adx, ady] = DIR_VEC[c.leaving]
      const ready = s.player[0] + adx === c.pos[0] && s.player[1] + ady === c.pos[1]
      if (ready) {
        const ejection = getEjectionPreview(s, i)
        const landing = opposite(c.leaving)
        const [ldx, ldy] = DIR_VEC[landing]
        const len = neighborsOf(i)[landing] ? ARM_LEN_SHORT : ARM_LEN
        // 喷口受阻时整次进攻无效，不伪造“手持珠已进入中心”的落点。
        if (!c.ejects || ejection?.landing != null) {
          drawLandingPreview(
            ctx,
            cx(s.player[0]),
            cy(s.player[1]),
            px + ldx * cell * len,
            py + ldy * cell * len,
            cell,
            s.holding,
            now,
          )
        }
        if (ejection) drawEjectionTrajectory(ctx, ejection, cx, cy, cell, now)
      }
    }

    // 阶段护罩（v3.2）与再生护罩（v4）：清晰模式在整次动作结算前保留旧罩，
    // 然后才播放碎裂，避免状态已推进却提前消失。
    const burstAt = shieldBursts.get(i)
    const waitingToBurst = burstAt !== undefined && now < burstAt
    const formAt = shieldForms.get(i)
    if (formAt !== undefined && now >= formAt) shieldForms.delete(i)
    const shieldActive = visuallyShielded(i)
    if (shieldActive) {
      const shieldLabel =
        c.shieldUntilStage !== undefined && (s.stage < c.shieldUntilStage || waitingToBurst)
          ? c.shieldUntilStage + 1
          : 'R'
      drawShield(ctx, px, py, cell, shieldLabel)
    } else if (c.reactiveTo) {
      drawDormantReactiveShield(ctx, px, py, cell)
    }
    if (burstAt !== undefined) {
      const progress = (now - burstAt) / timing.shieldBurstMs
      if (progress >= 1) shieldBursts.delete(i)
      else if (progress >= 0) drawShieldBurst(ctx, px, py, cell, c.shieldUntilStage ?? 0, progress)
    }

    // 已达标锁定圈 + ✓ 徽标（当前段中该中心的所有目标均已满足且至少有一个）
    // 预演中变化的中心由预演层按「动作后」状态判定（design §11）
    const activeGoals =
      s.stage < s.stages.length
        ? s.stages[s.stage].goals.filter((g) => g.center === i)
        : []
    if (!ghosted && activeGoals.length > 0 && activeGoals.every((g) => arms[g.arm] === g.color)) {
      drawLockRing(ctx, px, py, cell)
    }

    // 无效进攻红闪：撞面短弧（仅当撞的是中心）
    if (shake && lastState) {
      const age = now - shake.start
      if (age < SHAKE_MS) {
        const [dx, dy] = DIR_VEC[shake.dir]
        const target = lastState.centers.find(
          (cc) => cc.pos[0] === lastState!.player[0] + dx && cc.pos[1] === lastState!.player[1] + dy,
        )
        if (target && target.pos[0] === c.pos[0] && target.pos[1] === c.pos[1]) {
          const targetIndex = lastState.centers.indexOf(target)
          const blockedEjection = getEjectionPreview(lastState, targetIndex)?.landing === null
          if (blockedEjection) {
            drawBlockedNozzle(ctx, lastState, target, cx, cy, cell, 1 - age / SHAKE_MS)
          } else {
            const a = ARM_ANGLE[opposite(shake.dir)]
            ctx.save()
            ctx.strokeStyle = palette.flash
            ctx.globalAlpha = 1 - age / SHAKE_MS
            ctx.lineWidth = 3
            ctx.beginPath()
            ctx.arc(px, py, cell * 0.44, a - 0.55, a + 0.55)
            ctx.stroke()
            ctx.restore()
          }
        }
      }
    }
  }

  if (ejectionAnim && now >= ejectionAnim.start) {
    drawEjectionFlight(ctx, ejectionAnim, cx, cy, cell, now)
  }

  const impact = successfulImpact
  if (impact && now >= impact.contactAt && now < impact.end) {
    drawSuccessfulImpact(ctx, impact, cx, cy, cell, now)
  }

  // 玩家（最后画）：行走补间 + 无效进攻抖动 + 手持色珠
  let px = walk.value('px', now)
  let py = walk.value('py', now)
  if (Number.isNaN(px)) px = s.player[0]
  if (Number.isNaN(py)) py = s.player[1]
  let sx = cx(px)
  let sy = cy(py)
  if (impact && now >= impact.start && now < impact.end) {
    const [dx, dy] = DIR_VEC[impact.dir]
    const approachDuration = Math.max(1, impact.contactAt - impact.start)
    const offset = now < impact.contactAt
      ? Math.sin(((now - impact.start) / approachDuration) * Math.PI / 2) * cell * 0.16
      : (1 - easeOutCubic((now - impact.contactAt) / Math.max(1, impact.end - impact.contactAt))) * cell * 0.16
    sx += dx * offset
    sy += dy * offset
  }
  if (shake) {
    const age = now - shake.start
    if (age < SHAKE_MS) {
      const [dx, dy] = DIR_VEC[shake.dir]
      const blockedCenter = lastState?.centers.findIndex(
        (c) => c.pos[0] === lastState!.player[0] + dx && c.pos[1] === lastState!.player[1] + dy,
      )
      const nozzleBlocked =
        lastState !== null &&
        blockedCenter !== undefined &&
        blockedCenter >= 0 &&
        getEjectionPreview(lastState, blockedCenter)?.landing === null
      if (!nozzleBlocked) {
        const t = age / SHAKE_MS
        const amp = (1 - easeOutCubic(t)) * cell * 0.12
        const off = amp * Math.sin(t * Math.PI * 4)
        sx += dx * off
        sy += dy * off
      }
    } else {
      shake = null
    }
  }
  ctx.save()
  ctx.strokeStyle = palette.ink
  ctx.globalAlpha = 0.22
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(sx, sy, cell * 0.36, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
  // 玩家使用“亮环 + 暗芯”，与目标圈、中心原子和游离珠形成不同轮廓。
  ctx.fillStyle = palette.ink
  ctx.beginPath()
  ctx.arc(sx, sy, cell * 0.3, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = palette.playerCore
  ctx.beginPath()
  ctx.arc(sx, sy, cell * 0.2, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = palette.ink
  ctx.beginPath()
  ctx.arc(sx, sy, cell * 0.07, 0, Math.PI * 2)
  ctx.fill()

  // 手持色珠：玩家右上角小原子 + 键线；拾取/换手时脉冲扩散
  const displayHolding = pendingExchange
    ? now < pendingExchange.start
      ? pendingExchange.injected
      : null
    : s.holding
  if (displayHolding !== null) {
    const hx = sx + cell * 0.3
    const hy = sy - cell * 0.3
    ctx.strokeStyle = palette.bond
    ctx.lineWidth = Math.max(1, cell * 0.04)
    line(ctx, sx + cell * 0.14, sy - cell * 0.14, hx, hy)
    drawAtom(ctx, hx, hy, cell * 0.12, displayHolding)
  }
  if (handPulse) {
    const age = now - handPulse.start
    if (age >= 0 && age < 220 && handPulse.color !== null) {
      const t = age / 220
      ctx.save()
      ctx.strokeStyle = colorOf(handPulse.color)
      ctx.globalAlpha = 1 - t
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(sx + cell * 0.3, sy - cell * 0.3, cell * (0.14 + t * 0.22), 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    } else if (age >= 220) {
      handPulse = null
    }
  }

  // ---------- 认知外置层（design §11）：按住预演 / 标记 / Inspect ----------

  if (preview && !s.won) {
    const p = preview
    // 整体压暗：当前态退后，「将发生的变化」浮到最上层
    ctx.fillStyle = palette.previewVeil
    ctx.fillRect(0, 0, W, H)

    // 预演后的当前段目标（分步关卡一步连进多段时，直接展示新段目标）
    if (p.stage < p.stages.length) {
      for (const g of p.stages[p.stage].goals) drawGoal(g, 0.7, p, p.stage)
    }

    // 变化的中心：切换为「动作后构型」ghost + 共振链 ①②③。
    // 正式交互传入了引擎 transition 时，徽标与启动延迟只读真实 wave / depth；
    // 外部仅注入结果态时可以显示最终 ghost，但不再凭几何关系猜传播顺序。
    if (previewChanged.length > 0) {
      const firstFlipByCenter = new Map<number, ChemFlipEvent>()
      for (const event of previewFlipEvents) {
        if (!firstFlipByCenter.has(event.center)) firstFlipByCenter.set(event.center, event)
      }
      const directMaxDepth = previewFlipEvents
        .filter((event) => event.wave === 0)
        .reduce((depth, event) => Math.max(depth, event.depth), 0)
      const previewEjection = previewTransition?.events.find(
        (event): event is ChemEjectionEvent => event.type === 'ejection',
      )
      const remoteDelay =
        directMaxDepth * timing.hopMs +
        timing.flipMs +
        (previewEjection ? Math.max(1, previewEjection.path.length) * timing.ejectMsPerCell : 0)
      const delayOf = (center: number): number => {
        const event = firstFlipByCenter.get(center)
        if (!event) return 0
        return (event.wave === 0 ? 0 : remoteDelay) + event.depth * timing.hopMs
      }
      const ordered = [...previewChanged].sort(
        (a, b) => delayOf(a) - delayOf(b) || a - b,
      )
      ordered.forEach((i, n) => {
        const pc = p.centers[i]
        const c = s.centers[i]
        const gx = cx(pc.pos[0])
        const gy = cy(pc.pos[1])
        const armChanged = c.arms !== pc.arms
        const progress =
          (now - previewStartedAt - delayOf(i)) / timing.flipMs
        const pose = armChanged
          ? flipPose(c, pc, progress)
          : { arms: pc.arms, leaving: pc.leaving, rot: 0 }
        // ghost 晕圈：虚线 = 尚未发生
        ctx.save()
        ctx.strokeStyle = palette.ink
        ctx.globalAlpha = 0.5
        ctx.lineWidth = 2
        ctx.setLineDash([5, 4])
        ctx.beginPath()
        ctx.arc(gx, gy, cell * 0.58, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
        // 复用正式执行的翻转姿态；共振链也按当前节奏逐级启动。
        // 仅开口变化（光照格转轴）不是翻转，仍直接展示动作后方向。
        drawCenter(
          ctx,
          gx,
          gy,
          cell,
          pose.arms,
          pose.leaving,
          pose.rot,
          neighborsOf(i),
          pc.kind,
          pc.ejects,
          pose.armRot,
        )
        if (isShielded(p, pc)) {
          const shieldLabel =
            pc.shieldUntilStage !== undefined && p.stage < pc.shieldUntilStage
              ? pc.shieldUntilStage + 1
              : 'R'
          drawShield(ctx, gx, gy, cell, shieldLabel)
        } else if (pc.reactiveTo) {
          drawDormantReactiveShield(ctx, gx, gy, cell)
        }
        // 动作后的锁定圈（预演态判定：这一步之后谁达标）
        const goals =
          s.stage < s.stages.length
            ? s.stages[s.stage].goals.filter((g) => g.center === i)
            : []
        if (goals.length > 0 && goals.every((g) => pc.arms[g.arm] === g.color)) {
          drawLockRing(ctx, gx, gy, cell)
        }
        // 染色落点预览（被进攻的中心；落点由当前开口决定）
        if (s.holding !== null && !isShielded(s, c)) {
          const [adx, ady] = DIR_VEC[c.leaving]
          if (s.player[0] + adx === c.pos[0] && s.player[1] + ady === c.pos[1]) {
            const ejection = getEjectionPreview(s, i)
            const landing = opposite(c.leaving)
            const [ldx, ldy] = DIR_VEC[landing]
            const len = neighborsOf(i)[landing] ? ARM_LEN_SHORT : ARM_LEN
            if (!c.ejects || ejection?.landing != null) {
              drawLandingPreview(
                ctx,
                cx(s.player[0]),
                cy(s.player[1]),
                gx + ldx * cell * len,
                gy + ldy * cell * len,
                cell,
                s.holding,
                now,
              )
            }
            if (ejection) drawEjectionTrajectory(ctx, ejection, cx, cy, cell, now, true)
          }
        }
        // 共振链徽标 ①②③（≥2 个中心变化才有链可言）
        if (ordered.length >= 2) drawChainBadge(ctx, gx, gy, cell, n)
      })
    }

    // 若预演动作完成当前阶段，单独显示护罩将解除；中心不会被追加进同回合连锁。
    for (const i of previewShieldReleased) {
      const c = s.centers[i]
      drawShieldReleasePreview(
        ctx,
        cx(c.pos[0]),
        cy(c.pos[1]),
        cell,
        c.shieldUntilStage ?? 0,
        now,
      )
    }
    // 再生罩生成也属于规则结果；即使受保护中心本身没有翻转，也要在一步预演里显式出现。
    for (const i of previewShieldFormed) {
      const c = p.centers[i]
      drawShield(ctx, cx(c.pos[0]), cy(c.pos[1]), cell, 'R')
    }

    // 场上珠增减 ghost：新出现的珠（换落 / 弹射落点）半透明画出
    for (const g of p.groups) {
      const cur = s.groups.find((o) => o.pos[0] === g.pos[0] && o.pos[1] === g.pos[1])
      if (!cur || cur.color !== g.color) {
        const gx = cx(g.pos[0])
        const gy = cy(g.pos[1])
        ctx.save()
        ctx.globalAlpha = 0.8
        dashedCircle(ctx, gx, gy, cell * 0.26, colorOf(g.color), 0.9)
        drawAtom(ctx, gx, gy, cell * 0.15, g.color)
        ctx.restore()
      }
    }
    // 将消失的珠（被拾取 / 被发射）：淡虚线圈标记原位
    for (const g of s.groups) {
      const nxt = p.groups.find((o) => o.pos[0] === g.pos[0] && o.pos[1] === g.pos[1])
      if (!nxt) dashedCircle(ctx, cx(g.pos[0]), cy(g.pos[1]), cell * 0.26, palette.ink, 0.35)
    }

    // 玩家 ghost：移动
    if (p.player[0] !== s.player[0] || p.player[1] !== s.player[1]) {
      const gx = cx(p.player[0])
      const gy = cy(p.player[1])
      ctx.save()
      ctx.strokeStyle = palette.ink
      ctx.globalAlpha = 0.9
      ctx.lineWidth = 2
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.arc(gx, gy, cell * 0.3, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 0.12
      ctx.fillStyle = palette.ink
      ctx.fill()
      ctx.restore()
      // 移动箭头（起止缩短，避免压住本体与 ghost）
      const ax = cx(s.player[0])
      const ay = cy(s.player[1])
      const dx = gx - ax
      const dy = gy - ay
      const len = Math.hypot(dx, dy)
      const ux = dx / len
      const uy = dy / len
      ctx.save()
      ctx.strokeStyle = palette.ink
      ctx.fillStyle = palette.ink
      ctx.globalAlpha = 0.65
      ctx.lineWidth = 2
      line(ctx, ax + ux * cell * 0.36, ay + uy * cell * 0.36, gx - ux * cell * 0.38, gy - uy * cell * 0.38)
      const head = Math.max(5, cell * 0.12)
      const angle = Math.atan2(dy, dx)
      const ex = gx - ux * cell * 0.38
      const ey = gy - uy * cell * 0.38
      ctx.beginPath()
      ctx.moveTo(ex, ey)
      ctx.lineTo(ex - head * Math.cos(angle - 0.5), ey - head * Math.sin(angle - 0.5))
      ctx.lineTo(ex - head * Math.cos(angle + 0.5), ey - head * Math.sin(angle + 0.5))
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }

    // 手持变化 ghost：换出物（进攻 / 换珠）或清空（弹射中心注入）
    if (p.holding !== s.holding) {
      const hx = sx + cell * 0.34
      const hy = sy - cell * 0.34
      if (p.holding !== null) {
        ctx.save()
        ctx.globalAlpha = 0.9
        drawAtom(ctx, hx, hy, cell * 0.12, p.holding)
        ctx.globalAlpha = 0.7
        dashedCircle(ctx, hx, hy, cell * 0.2, colorOf(p.holding), 0.8)
        ctx.restore()
      } else {
        // 手将被清空
        dashedCircle(ctx, hx, hy, cell * 0.2, palette.ink, 0.4)
        ctx.save()
        ctx.strokeStyle = palette.ink
        ctx.globalAlpha = 0.55
        ctx.lineWidth = 1.5
        const t = cell * 0.08
        line(ctx, hx - t, hy - t, hx + t, hy + t)
        line(ctx, hx - t, hy + t, hx + t, hy - t)
        ctx.restore()
      }
    }

    // 预演提示条（输入模型可发现性）
    drawPreviewBanner(ctx, W)
  }

  // 玩家标记：预演压暗之后重画，保持可读（design §11 层 ③）
  if (marks) drawMarks(ctx, s, cx, cy, cell)

  // Inspect 检视面板：构型周期（design §11 层 ①）
  if (inspect !== null && s.centers[inspect] !== undefined) {
    drawInspectPanel(ctx, s, inspect, cx, cy, cell, W)
  }
  if (successfulImpact && now >= successfulImpact.end) successfulImpact = null
}

const stageTone = (stageIndex: number): string =>
  palette.stageTones[stageIndex % palette.stageTones.length]

/** 仪器式小标签：切角轮廓 + 普通数字，避免小圆里的粗等宽字在不同系统上挤压变形。 */
function drawTelemetryTag(
  ctx: CanvasRenderingContext2D,
  bx: number,
  by: number,
  cell: number,
  label: string,
  tone: string,
  alpha = 1,
): void {
  const w = cell * (label.length > 1 ? 0.34 : 0.28)
  const h = cell * 0.2
  const cut = Math.min(w, h) * 0.24
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = palette.anchorFill
  ctx.strokeStyle = tone
  ctx.lineWidth = Math.max(1.25, cell * 0.022)
  ctx.beginPath()
  ctx.moveTo(bx - w / 2 + cut, by - h / 2)
  ctx.lineTo(bx + w / 2, by - h / 2)
  ctx.lineTo(bx + w / 2, by + h / 2 - cut)
  ctx.lineTo(bx + w / 2 - cut, by + h / 2)
  ctx.lineTo(bx - w / 2, by + h / 2)
  ctx.lineTo(bx - w / 2, by - h / 2 + cut)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // 左侧短刻度强化“读数”而不是“气泡”的语义。
  ctx.globalAlpha = alpha * 0.7
  ctx.lineWidth = Math.max(1, cell * 0.016)
  line(ctx, bx - w * 0.34, by - h * 0.18, bx - w * 0.34, by + h * 0.18)

  ctx.globalAlpha = alpha
  ctx.fillStyle = tone
  ctx.font = `700 ${Math.max(8, Math.floor(cell * 0.125))}px ${CANVAS_NUM_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, bx + cell * 0.018, by + 0.25, w * 0.72)
  ctx.restore()
}

/** 分步目标的阶段牌：与相同阈值的护罩共用两位编号与颜色。 */
function drawStageBadge(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
  stageIndex: number,
  alpha: number,
): void {
  drawTelemetryTag(
    ctx,
    px + cell * 0.23,
    py - cell * 0.23,
    cell,
    String(stageIndex + 1).padStart(2, '0'),
    stageTone(stageIndex),
    Math.max(0.28, alpha),
  )
}

/** 再生护罩到控制臂的常显因果线；亮度表达当前是闭合还是休眠。 */
function drawReactiveLinks(
  ctx: CanvasRenderingContext2D,
  s: ChemState,
  cx: (x: number) => number,
  cy: (y: number) => number,
  cell: number,
  visualPoses: ReadonlyMap<number, CenterPose>,
  visuallyShielded: (index: number) => boolean,
): void {
  for (let guardedIndex = 0; guardedIndex < s.centers.length; guardedIndex++) {
    const guarded = s.centers[guardedIndex]
    const trigger = guarded.reactiveTo
    if (!trigger) continue
    const controller = s.centers[trigger.center]
    if (!controller) continue

    const [adx, ady] = DIR_VEC[trigger.arm]
    const tx = cx(controller.pos[0]) + adx * cell * ARM_LEN
    const ty = cy(controller.pos[1]) + ady * cell * ARM_LEN
    const gx = cx(guarded.pos[0])
    const gy = cy(guarded.pos[1])
    const vx = tx - gx
    const vy = ty - gy
    const distance = Math.max(1, Math.hypot(vx, vy))
    const ux = vx / distance
    const uy = vy / distance
    const startX = gx + ux * cell * 0.58
    const startY = gy + uy * cell * 0.58
    const bend = Math.min(cell * 0.16, distance * 0.12)
    const midX = (startX + tx) / 2 - uy * bend
    const midY = (startY + ty) / 2 + ux * bend
    const active = visuallyShielded(guardedIndex)
    const controllerArms = visualPoses.get(trigger.center)?.arms ?? controller.arms
    const tone = colorOf(trigger.color)

    ctx.save()
    ctx.strokeStyle = tone
    ctx.globalAlpha = active ? 0.78 : idleLinkAlpha()
    ctx.lineWidth = Math.max(1.5, cell * (active ? 0.035 : 0.025))
    ctx.setLineDash([cell * 0.09, cell * 0.065])
    ctx.beginPath()
    ctx.moveTo(startX, startY)
    ctx.quadraticCurveTo(midX, midY, tx, ty)
    ctx.stroke()
    ctx.setLineDash([])
    // 控制臂端点：目标色空心环，当前臂匹配时补一个实心点。
    ctx.globalAlpha = active ? 0.82 : 0.58
    ctx.fillStyle = palette.anchorFill
    ctx.beginPath()
    ctx.arc(tx, ty, cell * 0.095, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = tone
    ctx.lineWidth = Math.max(1.5, cell * 0.025)
    ctx.stroke()
    if (controllerArms[trigger.arm] === trigger.color) {
      ctx.fillStyle = tone
      ctx.beginPath()
      ctx.arc(tx, ty, cell * 0.038, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }
}

/** 打开状态的再生罩仍常显：断开的淡六边形 = 当前可通过，但此处受控制臂管辖。 */
function drawDormantReactiveShield(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
): void {
  const tone = stageTone(0)
  const radius = cell * 0.54
  ctx.save()
  ctx.strokeStyle = tone
  ctx.globalAlpha = idleShieldAlpha()
  ctx.lineWidth = Math.max(1.5, cell * 0.022)
  for (let k = 0; k < 6; k++) {
    const a1 = -Math.PI / 2 + (k * Math.PI) / 3
    const a2 = a1 + Math.PI / 3
    const x1 = px + Math.cos(a1) * radius
    const y1 = py + Math.sin(a1) * radius
    const x2 = px + Math.cos(a2) * radius
    const y2 = py + Math.sin(a2) * radius
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1 + (x2 - x1) * 0.68, y1 + (y2 - y1) * 0.68)
    ctx.stroke()
  }
  ctx.restore()
  drawTelemetryTag(ctx, px + cell * 0.43, py - cell * 0.43, cell, 'R', tone, 0.72)
}

/** 阶段护罩 / 再生护罩：强六边形双轮廓 + 编号 / R（常规与预演共用）。 */
function drawShield(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
  label: number | string,
): void {
  const tone = stageTone(typeof label === 'number' ? label - 1 : 0)
  ctx.save()
  for (const [radius, alpha, width] of [
    [0.57, 0.92, 0.045],
    [0.5, 0.42, 0.022],
  ] as const) {
    ctx.strokeStyle = tone
    ctx.globalAlpha = alpha
    ctx.lineWidth = Math.max(1.5, cell * width)
    ctx.beginPath()
    for (let k = 0; k < 6; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 3
      const hx = px + Math.cos(a) * cell * radius
      const hy = py + Math.sin(a) * cell * radius
      if (k === 0) ctx.moveTo(hx, hy)
      else ctx.lineTo(hx, hy)
    }
    ctx.closePath()
    ctx.stroke()
  }
  ctx.globalAlpha = 0.1
  ctx.fillStyle = tone
  ctx.fill()
  ctx.restore()
  const displayLabel = typeof label === 'number' ? String(label).padStart(2, '0') : label
  drawTelemetryTag(ctx, px + cell * 0.43, py - cell * 0.43, cell, displayLabel, tone)
}

/** 阶段推进后的护罩碎裂 / 消散反馈。 */
function drawShieldBurst(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
  unlockStage: number,
  progress: number,
): void {
  const tone = stageTone(unlockStage)
  const radius = cell * (0.52 + progress * 0.24)
  ctx.save()
  ctx.strokeStyle = tone
  ctx.globalAlpha = 1 - progress
  ctx.lineWidth = Math.max(1.5, cell * 0.035 * (1 - progress * 0.5))
  for (let k = 0; k < 6; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 3
    const a2 = a + Math.PI / 3
    const mx = px + Math.cos((a + a2) / 2) * radius * 1.08
    const my = py + Math.sin((a + a2) / 2) * radius * 1.08
    line(
      ctx,
      px + Math.cos(a) * radius,
      py + Math.sin(a) * radius,
      mx,
      my,
    )
    line(
      ctx,
      mx,
      my,
      px + Math.cos(a2) * radius,
      py + Math.sin(a2) * radius,
    )
  }
  ctx.restore()
}

/** 按住预演中显示“本步结算后护罩解除”；只画碎纹，不追加任何共振 ghost。 */
function drawShieldReleasePreview(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
  unlockStage: number,
  now: number,
): void {
  const pulse = 0.65 + 0.2 * Math.sin(now / 150)
  drawShieldBurst(ctx, px, py, cell, unlockStage, 0.22)
  ctx.save()
  ctx.strokeStyle = stageTone(unlockStage)
  ctx.globalAlpha = pulse
  ctx.lineWidth = Math.max(1.5, cell * 0.03)
  for (const angle of [-0.7, 0.2, 1.15]) {
    const x1 = px + Math.cos(angle) * cell * 0.28
    const y1 = py + Math.sin(angle) * cell * 0.28
    const x2 = px + Math.cos(angle + 0.3) * cell * 0.52
    const y2 = py + Math.sin(angle + 0.3) * cell * 0.52
    line(ctx, x1, y1, x2, y2)
  }
  ctx.restore()
}

/** 已达标锁定圈 + ✓ 徽标（常规与预演共用） */
function drawLockRing(ctx: CanvasRenderingContext2D, px: number, py: number, cell: number): void {
  ctx.save()
  ctx.strokeStyle = palette.ink
  ctx.globalAlpha = 0.34
  ctx.lineWidth = Math.max(1.5, cell * 0.025)
  ctx.beginPath()
  // 只环住中心核，避免旧版大圆穿过四个臂原子、与目标圈叠成一团。
  ctx.arc(px, py, cell * 0.28, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
  const r = cell * 0.105
  const bx = px + cell * 0.27
  const by = py - cell * 0.27
  ctx.fillStyle = palette.ink
  ctx.beginPath()
  ctx.arc(bx, by, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = palette.lockCheck
  ctx.lineWidth = Math.max(1.5, r * 0.28)
  ctx.beginPath()
  ctx.moveTo(bx - r * 0.45, by + r * 0.05)
  ctx.lineTo(bx - r * 0.12, by + r * 0.4)
  ctx.lineTo(bx + r * 0.5, by - r * 0.35)
  ctx.stroke()
}

/** 共振链徽标：01/02/03…（正式预演按引擎事件的真实 wave / depth 排序） */
function drawChainBadge(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
  order: number,
): void {
  const bx = px - cell * 0.46
  const by = py - cell * 0.46
  drawTelemetryTag(ctx, bx, by, cell, String(order + 1).padStart(2, '0'), stageTone(0))
}

/** 预演提示条：告诉玩家当前处于预演、如何执行 / 取消（输入模型可发现性） */
function drawPreviewBanner(ctx: CanvasRenderingContext2D, W: number): void {
  const text = '预演中 · 松开执行 · 回到原位 / Esc 取消'
  // 宽度按字符估算（CJK ≈ 12px / ASCII ≈ 7px @12px 字号），不依赖 measureText
  const textW = [...text].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) > 0x2e80 ? 12 : 7), 0)
  const w = textW + 28
  const h = 24
  const x = Math.floor((W - w) / 2)
  ctx.save()
  ctx.font = `500 12px ${CANVAS_UI_FONT}`
  ctx.fillStyle = palette.previewPanel
  ctx.strokeStyle = palette.previewBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(x, 8, w, h, 12)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = stageTone(0)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, W / 2, 8 + h / 2)
  ctx.restore()
}

/** 玩家标记徽章：格左上角小圆牌（顺序 ①–⑤ 金色；★/？/× 白色） */
function drawMarks(
  ctx: CanvasRenderingContext2D,
  s: ChemState,
  cx: (x: number) => number,
  cy: (y: number) => number,
  cell: number,
): void {
  if (!marks) return
  for (const [key, mark] of marks) {
    const [x, y] = key.split(',').map(Number)
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) continue
    if (x >= s.width || y >= s.height) continue
    const bx = cx(x) - cell / 2 + cell * 0.17
    const by = cy(y) - cell / 2 + cell * 0.17
    const r = cell * 0.14
    const seq = mark !== 'star' && mark !== 'question' && mark !== 'cross'
    const glyph = seq ? mark : mark === 'star' ? '★' : mark === 'question' ? '?' : '×'
    ctx.save()
    ctx.fillStyle = palette.markFill
    ctx.strokeStyle = seq ? stageTone(0) : palette.ink
    ctx.globalAlpha = 0.95
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(bx, by, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = seq ? stageTone(0) : palette.ink
    ctx.font = `${seq ? 700 : 500} ${Math.max(9, Math.floor(cell * (seq ? 0.16 : 0.19)))}px ${seq ? CANVAS_NUM_FONT : CANVAS_UI_FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(glyph, bx, by + 0.5)
    ctx.restore()
  }
}

/**
 * Inspect 检视面板：并排显示该中心的全部构型周期（peekFlip 逐次推进），
 * 当前态高亮——回答「这个中心翻完是什么样 / 我是不是已经翻过它」。纯展示，不消耗回合。
 */
function drawInspectPanel(
  ctx: CanvasRenderingContext2D,
  s: ChemState,
  index: number,
  cx: (x: number) => number,
  cy: (y: number) => number,
  cell: number,
  W: number,
): void {
  const c = s.centers[index]
  if (!c) return
  // 棋盘上：被检视中心的虚线高亮环
  ctx.save()
  ctx.strokeStyle = stageTone(0)
  ctx.globalAlpha = 0.75
  ctx.lineWidth = 2
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.arc(cx(c.pos[0]), cy(c.pos[1]), cell * 0.62, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  // 四臂 / 三臂中心都保持模 2；三臂中心的缺口在两态间移到对侧。
  const cycle: ChemCenterState[] = [c, peekFlip(c)]
  const labels = ['现在', '翻一次后']

  const miniW = 62
  const padX = 14
  const panelW = cycle.length * miniW + padX * 2
  const panelH = 104
  const x = W - panelW - 10
  const y = 10

  ctx.save()
  ctx.fillStyle = palette.panel
  ctx.strokeStyle = palette.bond
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(x, y, panelW, panelH, 12)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = palette.ink
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = `600 12px ${CANVAS_UI_FONT}`
  ctx.fillText(
    `中心 ${String(index + 1).padStart(2, '0')}${c.kind === 'trigonal' ? ' · 三臂' : ''}`,
    x + padX,
    y + 18,
  )
  ctx.font = `400 10px ${CANVAS_UI_FONT}`
  ctx.fillStyle = palette.panelMuted
  ctx.fillText('翻转前后 · 撞一次翻一次', x + padX, y + 34)

  cycle.forEach((cfg, i) => {
    const mx = x + padX + i * miniW + miniW / 2
    const my = y + 62
    const isCurrent = i === 0
    if (isCurrent) {
      ctx.strokeStyle = stageTone(0)
      ctx.globalAlpha = 0.85
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(mx - miniW / 2 + 3, my - 30, miniW - 6, 64, 8)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    drawMiniCenter(ctx, mx, my, cfg.arms, cfg.leaving, cfg.kind, cfg.ejects, isCurrent)
    ctx.fillStyle = isCurrent ? stageTone(0) : palette.panelMuted
    ctx.font = `500 10px ${CANVAS_UI_FONT}`
    ctx.textAlign = 'center'
    ctx.fillText(labels[i], mx, y + 88)
  })
  ctx.restore()
}

/** Inspect 面板里的迷你中心：小号骨架 + 臂原子 + 中心核方向箭头（当前态加亮） */
function drawMiniCenter(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  arms: Partial<Record<Dir, string>>,
  leaving: Dir,
  kind: CenterKind,
  ejects: boolean,
  bright: boolean,
): void {
  const dirs = (['N', 'E', 'S', 'W'] as const).filter((d) => arms[d] !== undefined)
  const len = 15
  ctx.save()
  ctx.globalAlpha = bright ? 1 : 0.72
  ctx.strokeStyle = palette.bond
  ctx.lineWidth = 1.5
  for (const d of dirs) {
    const [ax, ay] = ARM_VEC[d]
    line(ctx, px, py, px + ax * len, py + ay * len)
  }
  for (const d of dirs) {
    const color = arms[d]
    if (!color) continue
    const [ax, ay] = ARM_VEC[d]
    drawAtom(ctx, px + ax * len, py + ay * len, 6, color)
  }
  if (ejects) {
    ctx.beginPath()
    ctx.moveTo(px, py - 7)
    ctx.lineTo(px + 7, py)
    ctx.lineTo(px, py + 7)
    ctx.lineTo(px - 7, py)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  } else if (kind === 'trigonal') {
    const missing = (['N', 'E', 'S', 'W'] as const).find((d) => arms[d] === undefined)
    if (missing) {
      const [ax, ay] = ARM_VEC[missing]
      ctx.save()
      ctx.strokeStyle = palette.bond
      ctx.globalAlpha = 0.45
      ctx.setLineDash([2, 2])
      ctx.beginPath()
      ctx.arc(px + ax * len, py + ay * len, 3.5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
  }
  // 中心原子（三臂中心画小三角）
  ctx.fillStyle = palette.faint
  ctx.strokeStyle = palette.centerOutline
  ctx.lineWidth = 1
  if (kind === 'trigonal') {
    ctx.beginPath()
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / 3
      const tx = px + Math.cos(a) * 5
      const ty = py + Math.sin(a) * 5
      if (k === 0) ctx.moveTo(tx, ty)
      else ctx.lineTo(tx, ty)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.arc(px, py, 4.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  if (ejects) drawEjectOutlet(ctx, px, py, 40, ARM_ANGLE[leaving] + Math.PI)
  drawCenterDirection(ctx, px, py, 40, ARM_ANGLE[leaving])
  ctx.restore()
}

/**
 * 中心分子骨架：键线 + 臂原子 + 中心核方向箭头。rot=0 且无 armRot 时与静态布局完全一致。
 * 朝向相邻中心的臂缩短（避免压到邻居），开口以朝外的白色箭头标记进攻方向。
 * trigonal：四槽中恰好缺一臂，中心原子画成小三角（三臂中心一眼可辨）。
 */
function drawCenter(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
  arms: Partial<Record<Dir, string>>,
  leaving: Dir,
  rot: number,
  neighbors: Record<Dir, boolean>,
  kind: CenterKind,
  ejects: boolean,
  armRot?: Partial<Record<Dir, number>>,
): void {
  const dirs = (['N', 'E', 'S', 'W'] as const).filter((d) => arms[d] !== undefined)
  const armLen = (arm: Dir): number => (neighbors[arm] ? ARM_LEN_SHORT : ARM_LEN)
  const armPos = (arm: Dir): [number, number] => {
    const a = ARM_ANGLE[arm] + rot + (armRot?.[arm] ?? 0)
    const len = armLen(arm) * cell
    return [px + Math.cos(a) * len, py + Math.sin(a) * len]
  }

  // 键线（先画线，原子点压在线端上）
  ctx.strokeStyle = palette.bond
  ctx.lineWidth = Math.max(1.5, cell * 0.05)
  for (const arm of dirs) {
    const [ax, ay] = armPos(arm)
    line(ctx, px, py, ax, ay)
  }

  // 臂原子
  for (const arm of dirs) {
    const color = arms[arm]
    if (!color) continue
    const [ax, ay] = armPos(arm)
    const r = neighbors[arm] ? cell * 0.13 : cell * 0.19
    drawAtom(ctx, ax, ay, r, color)

  }

  // 三臂中心保留一个暗淡空槽，明确区分「结构缺口」与中心核内的进攻箭头。
  if (kind === 'trigonal') {
    const missing = (['N', 'E', 'S', 'W'] as const).find((d) => arms[d] === undefined)
    if (missing) {
      const a = ARM_ANGLE[missing] + rot + (armRot?.[missing] ?? 0)
      const mx = px + Math.cos(a) * cell * ARM_LEN
      const my = py + Math.sin(a) * cell * ARM_LEN
      ctx.save()
      ctx.strokeStyle = palette.bond
      ctx.globalAlpha = dimBondAlpha()
      ctx.lineWidth = Math.max(1.5, cell * 0.035)
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.arc(mx, my, cell * 0.085, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
  }

  // 中心原子：弹射中心用菱形喷嘴核；普通三臂用三角，普通四臂用圆形。
  ctx.fillStyle = palette.faint
  ctx.strokeStyle = palette.centerOutline
  ctx.lineWidth = 1
  if (ejects) {
    const r = cell * 0.18
    ctx.beginPath()
    ctx.moveTo(px, py - r)
    ctx.lineTo(px + r, py)
    ctx.lineTo(px, py + r)
    ctx.lineTo(px - r, py)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.strokeStyle = stageTone(0)
    ctx.globalAlpha = 0.72
    ctx.lineWidth = Math.max(1.5, cell * 0.025)
    ctx.beginPath()
    ctx.arc(px, py, cell * 0.1, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  } else if (kind === 'trigonal') {
    ctx.beginPath()
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + rot + (k * 2 * Math.PI) / 3
      const tx = px + Math.cos(a) * cell * 0.16
      const ty = py + Math.sin(a) * cell * 0.16
      if (k === 0) ctx.moveTo(tx, ty)
      else ctx.lineTo(tx, ty)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.arc(px, py, cell * 0.13, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  // 方向提示固定在中心核内并最后绘制：玩家、目标圈和相邻中心都不会再遮住它。
  // 动画中沿用开口臂的即时角度，因此会跟随四臂 / 三臂中心整体翻转。
  const directionAngle = ARM_ANGLE[leaving] + rot + (armRot?.[leaving] ?? 0)
  if (ejects) drawEjectOutlet(ctx, px, py, cell, directionAngle + Math.PI)
  drawCenterDirection(ctx, px, py, cell, directionAngle)
}

/** 弹射中心常驻喷流标记：在开口对侧画短尾迹 + 双箭头，随开口轴一起转动。 */
function drawEjectOutlet(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
  angle: number,
): void {
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const vx = -uy
  const vy = ux
  ctx.save()
  ctx.strokeStyle = stageTone(0)
  ctx.globalAlpha = 0.88
  ctx.lineWidth = Math.max(1.5, cell * 0.03)
  ctx.lineCap = 'round'
  for (const distance of [0.24, 0.34]) {
    const tx = px + ux * cell * distance
    const ty = py + uy * cell * distance
    const back = cell * 0.08
    const wing = cell * 0.055
    ctx.beginPath()
    ctx.moveTo(tx - ux * back + vx * wing, ty - uy * back + vy * wing)
    ctx.lineTo(tx, ty)
    ctx.lineTo(tx - ux * back - vx * wing, ty - uy * back - vy * wing)
    ctx.stroke()
  }
  ctx.globalAlpha = 0.35
  line(
    ctx,
    px + ux * cell * 0.16,
    py + uy * cell * 0.16,
    px + ux * cell * 0.42,
    py + uy * cell * 0.42,
  )
  ctx.restore()
}

/** 中心核内的进攻方向短箭头：不占用臂端和相邻格空间。 */
function drawCenterDirection(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
  angle: number,
): void {
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const vx = -uy
  const vy = ux
  const tailR = cell * 0.045
  const neckR = cell * 0.025
  const tipR = cell * 0.105
  const wing = cell * 0.038

  ctx.save()
  ctx.strokeStyle = palette.ink
  ctx.globalAlpha = 0.94
  ctx.lineWidth = Math.max(1.5, cell * 0.025)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  line(ctx, px - ux * tailR, py - uy * tailR, px + ux * neckR, py + uy * neckR)
  ctx.beginPath()
  ctx.moveTo(px + ux * neckR + vx * wing, py + uy * neckR + vy * wing)
  ctx.lineTo(px + ux * tipR, py + uy * tipR)
  ctx.lineTo(px + ux * neckR - vx * wing, py + uy * neckR - vy * wing)
  ctx.stroke()
  ctx.restore()
}

/** 色珠内部纹样：颜色之外再给一条稳定编码，避免只靠红绿区分。 */
/** 同相加深：浅色主题下色珠描边用填充色自身的深色变体（藏青圈在暖色珠上会显脏，2026-08-28）。 */
export function shadeColor(hex: string, factor: number): string {
  const to = (v: number): string => Math.max(0, Math.min(255, Math.round(v * factor)))
    .toString(16)
    .padStart(2, '0')
  return `#${to(parseInt(hex.slice(1, 3), 16))}${to(parseInt(hex.slice(3, 5), 16))}${to(
    parseInt(hex.slice(5, 7), 16),
  )}`
}

function drawAtom(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
): void {
  const fill = colorOf(color)
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  // 深色：近黑描边（既定观感）；浅色：填充色派生的同相深色环，保持清亮不挂灰
  ctx.strokeStyle =
    renderTheme === 'light' ? shadeColor(fill, 0.62) : palette.atomOutline
  ctx.lineWidth = Math.max(1, r * 0.16)
  ctx.stroke()

  ctx.save()
  ctx.strokeStyle = palette.atomPattern
  ctx.fillStyle = palette.atomPattern
  ctx.lineWidth = Math.max(1.2, r * 0.16)
  ctx.lineCap = 'round'
  if (color === 'red') {
    ctx.beginPath()
    ctx.arc(x, y, r * 0.22, 0, Math.PI * 2)
    ctx.fill()
  } else if (color === 'blue') {
    line(ctx, x - r * 0.38, y, x + r * 0.38, y)
  } else if (color === 'green') {
    line(ctx, x, y - r * 0.38, x, y + r * 0.38)
  } else if (color === 'yellow') {
    line(ctx, x - r * 0.3, y - r * 0.3, x + r * 0.3, y + r * 0.3)
    line(ctx, x + r * 0.3, y - r * 0.3, x - r * 0.3, y + r * 0.3)
  } else {
    ctx.beginPath()
    ctx.arc(x, y, r * 0.3, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * 清晰节奏的取代分镜：两颗珠沿平行弧线反向交换，明确“谁离开 / 谁进入”。
 * 中心开口与玩家手持的静态珠在这段时间隐藏，避免结果态瞬间覆盖因果过程。
 */
function drawSubstitutionTransfer(
  ctx: CanvasRenderingContext2D,
  exchange: SubstitutionAnim,
  centerX: number,
  centerY: number,
  cx: (x: number) => number,
  cy: (y: number) => number,
  cell: number,
  now: number,
): void {
  const raw = (now - exchange.start) / Math.max(1, exchange.end - exchange.start)
  const t = easeInOutQuad(Math.max(0, Math.min(1, raw)))
  const [dx, dy] = DIR_VEC[exchange.dir]
  const armX = centerX + dx * cell * ARM_LEN
  const armY = centerY + dy * cell * ARM_LEN
  const handX = cx(exchange.player[0]) + cell * 0.3
  const handY = cy(exchange.player[1]) - cell * 0.3
  const vx = armX - handX
  const vy = armY - handY
  const length = Math.max(1, Math.hypot(vx, vy))
  const nx = -vy / length
  const ny = vx / length
  const arc = Math.sin(Math.PI * t) * cell * 0.11
  const injectedX = handX + vx * t + nx * arc
  const injectedY = handY + vy * t + ny * arc
  const extractedX = armX - vx * t - nx * arc
  const extractedY = armY - vy * t - ny * arc

  ctx.save()
  ctx.lineWidth = Math.max(1.5, cell * 0.025)
  ctx.setLineDash([4, 4])
  ctx.globalAlpha = 0.48
  ctx.strokeStyle = colorOf(exchange.injected)
  line(ctx, handX, handY, armX, armY)
  ctx.strokeStyle = colorOf(exchange.extracted)
  line(ctx, armX, armY, handX, handY)
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  drawAtom(ctx, injectedX, injectedY, cell * 0.13, exchange.injected)
  drawAtom(ctx, extractedX, extractedY, cell * 0.13, exchange.extracted)
  ctx.restore()
}

/** 染色落点预览：从玩家手中流向翻转后的最终臂位。 */
function drawLandingPreview(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  cell: number,
  color: string,
  now: number,
): void {
  const tone = colorOf(color)
  const pulse = 0.72 + 0.18 * Math.sin(now / 180)
  const angle = Math.atan2(toY - fromY, toX - fromX)
  const tipX = toX - Math.cos(angle) * cell * 0.26
  const tipY = toY - Math.sin(angle) * cell * 0.26
  const head = cell * 0.1

  ctx.save()
  ctx.strokeStyle = tone
  ctx.fillStyle = tone
  ctx.globalAlpha = pulse
  ctx.lineWidth = Math.max(2, cell * 0.04)
  ctx.setLineDash([3, 4])
  line(
    ctx,
    fromX + Math.cos(angle) * cell * 0.28,
    fromY + Math.sin(angle) * cell * 0.28,
    tipX,
    tipY,
  )
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - head * Math.cos(angle - 0.55), tipY - head * Math.sin(angle - 0.55))
  ctx.lineTo(tipX - head * Math.cos(angle + 0.55), tipY - head * Math.sin(angle + 0.55))
  ctx.closePath()
  ctx.fill()

  ctx.globalAlpha = 0.14 + 0.06 * Math.sin(now / 180)
  ctx.beginPath()
  ctx.arc(toX, toY, cell * 0.25, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = pulse
  ctx.lineWidth = Math.max(2, cell * 0.045)
  ctx.beginPath()
  ctx.arc(toX, toY, cell * 0.29, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

/** 弹射中心完整弹道：被顶出珠颜色、逐格射线和最终落点；空路径显示喷口受阻。 */
function drawEjectionTrajectory(
  ctx: CanvasRenderingContext2D,
  plan: ChemEjectionPreview,
  cx: (x: number) => number,
  cy: (y: number) => number,
  cell: number,
  now: number,
  ghost = false,
): void {
  const [dx, dy] = DIR_VEC[plan.dir]
  const startX = cx(plan.from[0]) + dx * cell * 0.26
  const startY = cy(plan.from[1]) + dy * cell * 0.26
  if (plan.path.length === 0) {
    const bx = cx(plan.from[0]) + dx * cell * 0.72
    const by = cy(plan.from[1]) + dy * cell * 0.72
    ctx.save()
    ctx.strokeStyle = palette.flash
    ctx.globalAlpha = 0.78 + 0.18 * Math.sin(now / 110)
    ctx.lineWidth = Math.max(2, cell * 0.045)
    const r = cell * 0.14
    line(ctx, bx - r, by - r, bx + r, by + r)
    line(ctx, bx - r, by + r, bx + r, by - r)
    ctx.restore()
    return
  }

  const landing = plan.landing!
  const endX = cx(landing[0])
  const endY = cy(landing[1])
  const tone = colorOf(plan.color)
  ctx.save()
  ctx.strokeStyle = tone
  ctx.fillStyle = tone
  ctx.globalAlpha = ghost ? 0.92 : 0.72 + 0.16 * Math.sin(now / 170)
  ctx.lineWidth = Math.max(2, cell * 0.035)
  ctx.setLineDash([cell * 0.1, cell * 0.08])
  line(ctx, startX, startY, endX, endY)
  ctx.setLineDash([])
  for (const [x, y] of plan.path) {
    ctx.globalAlpha = ghost ? 0.62 : 0.38
    ctx.beginPath()
    ctx.arc(cx(x), cy(y), cell * 0.035, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = ghost ? 0.94 : 0.82
  dashedCircle(ctx, endX, endY, cell * 0.25, tone, 0.9, goalDash(plan.color))
  drawAtom(ctx, endX, endY, cell * 0.13, plan.color)
  const arrowX = endX - dx * cell * 0.26
  const arrowY = endY - dy * cell * 0.26
  const px = -dy
  const py = dx
  ctx.beginPath()
  ctx.moveTo(arrowX, arrowY)
  ctx.lineTo(arrowX - dx * cell * 0.12 + px * cell * 0.08, arrowY - dy * cell * 0.12 + py * cell * 0.08)
  ctx.lineTo(arrowX - dx * cell * 0.12 - px * cell * 0.08, arrowY - dy * cell * 0.12 - py * cell * 0.08)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** 正式执行：被顶出珠沿与预演相同的逐格路径飞到落点。 */
function drawEjectionFlight(
  ctx: CanvasRenderingContext2D,
  anim: EjectionAnim,
  cx: (x: number) => number,
  cy: (y: number) => number,
  cell: number,
  now: number,
): void {
  const points = [anim.from, ...anim.path]
  const duration = Math.max(1, anim.path.length) * animationTiming().ejectMsPerCell
  const scaled = Math.min(0.999, Math.max(0, (now - anim.start) / duration)) * (points.length - 1)
  const segment = Math.min(points.length - 2, Math.floor(scaled))
  const local = scaled - segment
  const a = points[segment]
  const b = points[segment + 1]
  const x = cx(a[0]) + (cx(b[0]) - cx(a[0])) * local
  const y = cy(a[1]) + (cy(b[1]) - cy(a[1])) * local
  ctx.save()
  ctx.globalAlpha = 0.32
  ctx.strokeStyle = colorOf(anim.color)
  ctx.lineWidth = Math.max(2, cell * 0.05)
  line(ctx, cx(anim.from[0]), cy(anim.from[1]), x, y)
  ctx.globalAlpha = 1
  drawAtom(ctx, x, y, cell * 0.14, anim.color)
  ctx.restore()
}

/** 有效进攻的接触帧：蓝白冲击环与短射线，和无效进攻的红色撞面弧明确区分。 */
function drawSuccessfulImpact(
  ctx: CanvasRenderingContext2D,
  anim: SuccessfulImpactAnim,
  cx: (x: number) => number,
  cy: (y: number) => number,
  cell: number,
  now: number,
): void {
  const progress = Math.max(0, Math.min(1, (now - anim.contactAt) / Math.max(1, anim.end - anim.contactAt)))
  const eased = easeOutCubic(progress)
  const [dx, dy] = DIR_VEC[anim.dir]
  const px = -dy
  const py = dx
  const x = cx(anim.target[0]) - dx * cell * 0.42
  const y = cy(anim.target[1]) - dy * cell * 0.42
  ctx.save()
  ctx.strokeStyle = palette.impact
  ctx.fillStyle = palette.impact
  ctx.globalAlpha = 1 - eased
  ctx.lineWidth = Math.max(2, cell * 0.045 * (1 - progress * 0.35))
  ctx.beginPath()
  ctx.arc(x, y, cell * (0.08 + eased * 0.22), 0, Math.PI * 2)
  ctx.stroke()
  for (const side of [-1, 0, 1]) {
    const spread = side * cell * 0.14
    const inner = cell * (0.08 + eased * 0.04)
    const outer = cell * (0.2 + eased * 0.18)
    line(
      ctx,
      x + px * spread - dx * inner,
      y + py * spread - dy * inner,
      x + px * spread - dx * outer,
      y + py * spread - dy * outer,
    )
  }
  ctx.beginPath()
  ctx.arc(x, y, Math.max(2, cell * 0.045 * (1 - progress)), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 喷口身后第一格被堵：在堵塞侧显示交叉火花，替代普通“撞错面”弧线。 */
function drawBlockedNozzle(
  ctx: CanvasRenderingContext2D,
  state: ChemState,
  target: ChemCenterState,
  cx: (x: number) => number,
  cy: (y: number) => number,
  cell: number,
  alpha: number,
): void {
  const index = state.centers.indexOf(target)
  const plan = getEjectionPreview(state, index)
  if (!plan) return
  const [dx, dy] = DIR_VEC[plan.dir]
  const bx = cx(plan.from[0]) + dx * cell * 0.72
  const by = cy(plan.from[1]) + dy * cell * 0.72
  const r = cell * 0.16
  ctx.save()
  ctx.strokeStyle = palette.flash
  ctx.globalAlpha = alpha
  ctx.lineWidth = Math.max(2.5, cell * 0.055)
  line(ctx, bx - r, by - r, bx + r, by + r)
  line(ctx, bx - r, by + r, bx + r, by - r)
  ctx.beginPath()
  ctx.arc(bx, by, cell * 0.24, -0.8, 0.8)
  ctx.stroke()
  ctx.restore()
}

/** v3.2 特殊格：仅保留光照（金色放射纹）。 */
function drawSpecialCells(
  ctx: CanvasRenderingContext2D,
  s: ChemState,
  cx: (x: number) => number,
  cy: (y: number) => number,
  cell: number,
  now: number,
): void {
  // 光照格：中心点 + 八条放射线（缓慢呼吸）
  for (const [x, y] of s.lights) {
    const px = cx(x)
    const py = cy(y)
    ctx.save()
    ctx.strokeStyle = palette.lightCell
    ctx.fillStyle = palette.lightCell
    // 浅色下呼吸下限提高到 0.9：光照格是必读信息，不能靠低 alpha 稀释成隐形
    ctx.globalAlpha =
      renderTheme === 'light' ? 0.9 + 0.1 * Math.sin(now / 500) : 0.55 + 0.2 * Math.sin(now / 500)
    ctx.lineWidth = Math.max(1.5, cell * 0.04)
    ctx.beginPath()
    ctx.arc(px, py, cell * 0.1, 0, Math.PI * 2)
    ctx.fill()
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4 + Math.PI / 8
      line(
        ctx,
        px + Math.cos(a) * cell * 0.18,
        py + Math.sin(a) * cell * 0.18,
        px + Math.cos(a) * cell * 0.32,
        py + Math.sin(a) * cell * 0.32,
      )
    }
    ctx.restore()
  }
}

/** 背景：极低透明度的四面体线框（《109.5°》的几何本体），缓慢自转 */
function drawBackdrop(ctx: CanvasRenderingContext2D, W: number, H: number, now: number): void {
  const t = now * TETRA_SPIN
  tetra(ctx, W * 0.16, H * 0.2, W * 0.15, 0.55 + t, 0.4, 0.06)
  tetra(ctx, W * 0.86, H * 0.28, W * 0.11, -0.3 - t * 0.7, 0.7, 0.05)
  tetra(ctx, W * 0.22, H * 0.86, W * 0.13, 0.9 + t * 0.5, -0.35, 0.05)
  tetra(ctx, W * 0.84, H * 0.82, W * 0.16, 0.2 + t * 0.3, 0.95, 0.045)
}

/** 棋盘四角的仪器边框角标（不占棋盘内部空间） */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cell: number,
): void {
  const L = Math.min(14, cell * 0.4)
  const o = 5
  ctx.strokeStyle = palette.faint
  ctx.lineWidth = 1
  const corner = (cx: number, cy: number, sx: number, sy: number): void => {
    line(ctx, cx + 0.5, cy + 0.5, cx + sx * L + 0.5, cy + 0.5)
    line(ctx, cx + 0.5, cy + 0.5, cx + 0.5, cy + sy * L + 0.5)
  }
  corner(x - o, y - o, 1, 1)
  corner(x + w + o, y - o, -1, 1)
  corner(x - o, y + h + o, 1, -1)
  corner(x + w + o, y + h + o, -1, -1)
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function dashedCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  alpha = 0.85,
  dash: readonly number[] = [4, 3],
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.globalAlpha = alpha
  ctx.setLineDash([...dash])
  ctx.lineWidth = Math.max(2, r * 0.08)
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

/** 目标环的节奏与色珠内部纹样对应：即使低饱和/色弱状态也能区分目标色。 */
function goalDash(color: string): readonly number[] {
  if (color === 'red') return [2, 4]
  if (color === 'blue') return [7, 3]
  if (color === 'green') return [8, 3, 2, 3]
  if (color === 'yellow') return [12, 4]
  return [1, 3]
}

/** 正四面体线框（正交投影；顶点即「原子点」）。109.5° 的几何本体。 */
const TETRA_V: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
]
const TETRA_E: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
]

function tetra(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  rotZ: number,
  rotX: number,
  alpha: number,
): void {
  const k = r * 0.58 // |v| = √3，归一到半径约 1
  const pts = TETRA_V.map(([x, y, z]) => {
    const x1 = x * Math.cos(rotZ) - y * Math.sin(rotZ)
    const y1 = x * Math.sin(rotZ) + y * Math.cos(rotZ)
    const y2 = y1 * Math.cos(rotX) - z * Math.sin(rotX)
    return [cx + x1 * k, cy + y2 * k] as const
  })
  ctx.save()
  ctx.strokeStyle = palette.tetra
  ctx.fillStyle = palette.tetra
  ctx.globalAlpha = alpha
  ctx.lineWidth = 1
  for (const [a, b] of TETRA_E) {
    line(ctx, pts[a][0], pts[a][1], pts[b][0], pts[b][1])
  }
  for (const [px, py] of pts) {
    ctx.beginPath()
    ctx.arc(px, py, 1.5, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
