import { DIRS, DIR_VEC, cellKey, opposite } from '../../core/protocol'
import type { Dir, GameDefinition, Vec } from '../../core/protocol'
import { parseChemLevel } from './level'
import type { CenterKind, ChemGoal, ChemLevel, ChemStage } from './level'

/**
 * Inversion（chem）引擎（v1 搬运 + v2 共振 + v3 机制群，见 docs/design.md §5）。
 *
 * 基础（v0–v2）：
 * - 玩家方向键移动；撞向中心格 = 尝试进攻（玩家不进入中心格）。
 * - 进攻有效 ⇔ 目标中心当前阶段未受保护 且 玩家移动方向 === 中心当前开口臂方向。
 * - 空手进攻 = 纯翻转；持基团进攻 = 取代 + 翻转（装入正对攻击者的臂，开口臂基团换入手中）。
 * - 共振传导：翻转后，面对臂同色的相邻未翻中心被传导纯翻转；保护罩中心传不进去（链闸）。
 *
 * v3 机制群：
 * - 三臂中心（kind='trigonal'）：四槽中恰好缺一臂；与普通中心同样整体翻转 180°，
 *   三颗珠、缺口与开口一起转到对侧，持珠取代也完全复用普通中心语义（周期 2）。
 * - 弹射中心（ejects）：持珠进攻时，携带珠照常注入（手变空），被顶出的基团沿攻击反方向
 *   从玩家身后飞出，落到射线第一个障碍前一格；身后第一格即被堵 ⇒ 进攻无效。
 * - 光照格：玩家走入的一瞬，所有中心的开口顺时针移到下一条现存臂（三臂中心跳过缺口）。
 * - 阶段护罩：stage < shieldUntilStage 时阻挡进攻与共振；阶段在整次连锁结算后推进，
 *   因此刚解除的护罩不会让同一步连锁追溯穿透。光照仍可移动罩内开口。
 * - 分步目标：按段顺序达成；一步可连进多段；全部段完成 = 胜利。
 *
 * 无效进攻 / 撞墙 / 撞边界：无效果，不消耗回合（返回原状态）。
 */

const ROT_CW: Record<Dir, Dir> = { N: 'E', E: 'S', S: 'W', W: 'N' }

export interface ChemCenterState {
  pos: Vec
  arms: Partial<Record<Dir, string>>
  leaving: Dir
  kind: CenterKind
  shieldUntilStage?: number
  ejects: boolean
  hitLights: boolean
  hitCenters: boolean
  reactiveTo?: ChemGoal
}

export interface ChemGroupState {
  pos: Vec
  color: string
}

export interface ChemEjectionPreview {
  /** 被直接进攻的弹射中心下标 */
  center: number
  /** 喷流起点（进攻者所在格；色珠从其身后离开） */
  from: Vec
  /** 喷流方向（进攻方向的反向） */
  dir: Dir
  /** 将被顶出的开口臂色珠 */
  color: string
  /** 从玩家身后第一格到最终落点的完整空格射线；空数组表示喷口紧邻处被堵 */
  path: readonly Vec[]
  /** 射线最后空格；喷口受阻时为 null */
  landing: Vec | null
  /** 射线最终被哪个中心挡住（若被中心挡住则为其下标，否则 null） */
  blockedCenter: number | null
}

export interface ChemState {
  width: number
  height: number
  /** cellKey 集合 */
  walls: readonly string[]
  player: Vec
  /** 手持基团颜色（v1）；空手为 null */
  holding: string | null
  centers: readonly ChemCenterState[]
  /** 场上游离基团（v1） */
  groups: readonly ChemGroupState[]
  /** 分步目标（v3 规约：旧格式 goals ⇒ 单段） */
  stages: readonly ChemStage[]
  /** 当前进行到的段（0 起）；>= stages.length 即胜利 */
  stage: number
  /** 关卡静态光照格（不进 stateKey） */
  lights: readonly Vec[]
  /** 总步数预算（v6）：moves 达到后一切动作无效；未定义 = 无限制 */
  moveLimit?: number
  /** 标准杆（纯展示，不进 stateKey） */
  par?: number
  /** 纯计数器，不参与 stateKey */
  moves: number
  won: boolean
}

export interface ChemAttackEvent {
  type: 'attack'
  center: number
  dir: Dir
  player: Vec
  injected: string | null
  extracted: string | null
}

export interface ChemFlipEvent {
  type: 'flip'
  center: number
  /** null = 本波的直接源；非 null = 由该中心沿亮键传来。 */
  source: number | null
  cause: 'attack' | 'resonance' | 'ejection'
  /** 0 = 直接进攻波；1 = 同一步中的弹射撞核波。 */
  wave: number
  /** 相对本波源头的共振层级；同层分支可同时播放。 */
  depth: number
  before: ChemCenterState
  after: ChemCenterState
}

export interface ChemEjectionEvent extends ChemEjectionPreview {
  type: 'ejection'
}

export type ChemTransitionEvent = ChemAttackEvent | ChemFlipEvent | ChemEjectionEvent

/** 一次动作的规则结果与真实因果轨迹；events 不进入 ChemState / stateKey / solver。 */
export interface ChemStepResult {
  state: ChemState
  action: Dir
  events: readonly ChemTransitionEvent[]
}

const hasVec = (list: readonly Vec[], x: number, y: number): boolean =>
  list.some((v) => v[0] === x && v[1] === y)

export const isShielded = (
  s: Pick<ChemState, 'stage' | 'centers'>,
  c: ChemCenterState,
): boolean => {
  // v4 护罩再生：reactiveTo 中间产物被破坏时，护罩重新出现
  if (c.reactiveTo) {
    const target = s.centers[c.reactiveTo.center]
    if (!target || target.arms[c.reactiveTo.arm] !== c.reactiveTo.color) return true
  }
  return c.shieldUntilStage !== undefined && s.stage < c.shieldUntilStage
}

const presentArmDirs = (center: Pick<ChemCenterState, 'arms'>): Dir[] =>
  DIRS.filter((d) => center.arms[d] !== undefined)

/** 对现存臂做 180° 翻转；Partial 保证三臂中心的缺口也随结构转到对侧。 */
function rotateArms(arms: Partial<Record<Dir, string>>): Partial<Record<Dir, string>> {
  const rotated: Partial<Record<Dir, string>> = {}
  for (const d of DIRS) {
    const color = arms[d]
    if (color !== undefined) rotated[opposite(d)] = color
  }
  return rotated
}

/** 纯翻转：四臂 / 三臂中心统一为整体 180° 对换，周期均为 2。 */
function flipCenter(centers: ChemCenterState[], i: number): ChemCenterState[] {
  const c = centers[i]
  const arms = rotateArms(c.arms)
  return centers.map((cc, j) => (j === i ? { ...cc, arms, leaving: opposite(cc.leaving) } : cc))
}

/**
 * 共振传导（v2 + v3 链闸）：从 start 起逐层传播纯翻转。
 * 保护罩中心不翻、链在其停下；三臂中心只通过当前实际存在的面对臂连接。
 */
function propagate(
  centers: ChemCenterState[],
  start: number,
  stage: number,
  events?: ChemTransitionEvent[],
  wave = 0,
): ChemCenterState[] {
  const flipped = new Set<number>([start])
  const queue: { center: number; depth: number }[] = [{ center: start, depth: 0 }]
  while (queue.length > 0) {
    const { center: x, depth } = queue.shift()!
    const xc = centers[x]
    for (const d of presentArmDirs(xc)) {
      const [ex, ey] = DIR_VEC[d]
      const yi = centers.findIndex(
        (c) => c.pos[0] === xc.pos[0] + ex && c.pos[1] === xc.pos[1] + ey,
      )
      if (yi < 0 || flipped.has(yi)) continue
      const yc = centers[yi]
      if (isShielded({ stage, centers }, yc)) continue // 阶段护罩 / 再生护罩挡住共振
      const sourceColor = centers[x].arms[d]
      const targetColor = centers[yi].arms[opposite(d)]
      if (sourceColor !== undefined && targetColor !== undefined && sourceColor === targetColor) {
        const before = centers[yi]
        centers = flipCenter(centers, yi)
        events?.push({
          type: 'flip',
          center: yi,
          source: x,
          cause: 'resonance',
          wave,
          depth: depth + 1,
          before,
          after: centers[yi],
        })
        flipped.add(yi)
        queue.push({ center: yi, depth: depth + 1 })
      }
    }
  }
  return centers
}

/**
 * 取代计算：四臂 / 三臂中心完全复用同一语义，返回新臂面、新开口与被顶出的基团颜色。
 * dir = 进攻/命中方向（= 开口方向）。
 */
function substitute(
  center: ChemCenterState,
  dir: Dir,
  carried: string | null,
): { arms: Partial<Record<Dir, string>>; leaving: Dir; extracted: string | undefined } {
  const injected = { ...center.arms }
  if (carried !== null) injected[dir] = carried
  return {
    arms: rotateArms(injected),
    leaving: opposite(dir),
    extracted: center.arms[dir],
  }
}

/** 光照把开口顺时针移到下一条当前存在的臂；三臂中心自动跳过缺口。 */
function nextPresentOpening(center: ChemCenterState): Dir {
  let d = ROT_CW[center.leaving]
  while (center.arms[d] === undefined) d = ROT_CW[d]
  return d
}

/**
 * 沿 dir 从 from 的下一格起扫描，返回最后一个空格（射线落点）；第一步就被堵 ⇒ null。
 * 墙 / 中心 / 游离基团 / 边界都会挡住射线。
 */
function scanPath(s: ChemState, from: Vec, dir: Dir): Vec[] {
  const [dx, dy] = DIR_VEC[dir]
  let cx = from[0] + dx
  let cy = from[1] + dy
  const path: Vec[] = []
  while (cx >= 0 && cy >= 0 && cx < s.width && cy < s.height) {
    if (s.walls.includes(cellKey(cx, cy))) break
    if (s.centers.some((c) => c.pos[0] === cx && c.pos[1] === cy)) break
    if (s.groups.some((g) => g.pos[0] === cx && g.pos[1] === cy)) break
    path.push([cx, cy])
    cx += dx
    cy += dy
  }
  return path
}

/**
 * 弹射中心的只读弹道预演。只有玩家持珠、站在合法背面且护罩已解除时返回。
 * 即使身后第一格被堵也返回（path=[] / landing=null），供渲染区分“喷口受阻”与普通撞面。
 */
export function getEjectionPreview(s: ChemState, centerIndex: number): ChemEjectionPreview | null {
  const center = s.centers[centerIndex]
  if (!center?.ejects || s.holding === null || isShielded(s, center)) return null
  const [dx, dy] = DIR_VEC[center.leaving]
  if (s.player[0] + dx !== center.pos[0] || s.player[1] + dy !== center.pos[1]) return null
  const color = center.arms[center.leaving]
  if (color === undefined) return null
  const dir = opposite(center.leaving)
  const path = scanPath(s, s.player, dir)
  const landing = path[path.length - 1] ?? null
  let blockedCenter: number | null = null
  if (landing) {
    const [lx, ly] = DIR_VEC[dir]
    const bi = s.centers.findIndex(
      (c) => c.pos[0] === landing[0] + lx && c.pos[1] === landing[1] + ly,
    )
    blockedCenter = bi >= 0 ? bi : null
  }
  return {
    center: centerIndex,
    from: s.player,
    dir,
    color,
    path,
    landing,
    blockedCenter,
  }
}

/** 段推进：当前段目标全部满足则进入下一段（一步可连进多段） */
function advance(s: ChemState): ChemState {
  let stage = s.stage
  while (
    stage < s.stages.length &&
    s.stages[stage].goals.every((g) => s.centers[g.center].arms[g.arm] === g.color)
  ) {
    stage++
  }
  return stage === s.stage ? s : { ...s, stage }
}

export function initialState(level: ChemLevel): ChemState {
  const state: ChemState = {
    width: level.width,
    height: level.height,
    walls: level.walls.map(([x, y]) => cellKey(x, y)),
    player: level.player,
    holding: null,
    centers: level.centers.map((c) => ({
      pos: c.pos,
      arms: { ...c.arms },
      leaving: c.leaving,
      kind: c.kind ?? 'tetra',
      shieldUntilStage: c.shieldUntilStage,
      ejects: c.ejects ?? false,
      hitLights: c.hitLights ?? false,
      hitCenters: c.hitCenters ?? false,
      reactiveTo: c.reactiveTo,
    })),
    groups: level.groups.map((g) => ({ pos: g.pos, color: g.color })),
    stages: level.stages,
    stage: 0,
    lights: level.lights,
    moveLimit: level.moveLimit,
    par: level.par,
    moves: 0,
    won: false,
  }
  const advanced = advance(state)
  return { ...advanced, won: isWin(advanced) }
}

function resolveState(
  s: ChemState,
  dir: Dir,
  events?: ChemTransitionEvent[],
): ChemState {
  if (s.won) return s
  // v6 步数预算：用尽后一切动作无效（与撞墙同语义，状态不变）
  if (s.moveLimit !== undefined && s.moves >= s.moveLimit) return s
  const [dx, dy] = DIR_VEC[dir]
  const nx = s.player[0] + dx
  const ny = s.player[1] + dy
  if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) return s
  if (s.walls.includes(cellKey(nx, ny))) return s

  // ---------- 进攻 ----------
  const ci = s.centers.findIndex((c) => c.pos[0] === nx && c.pos[1] === ny)
  if (ci >= 0) {
    const center = s.centers[ci]
    if (isShielded(s, center)) return s // 保护罩：进攻无效
    if (dir !== center.leaving) return s // 非背面进攻：无效果

    // 弹射中心 + 手持：被顶出的基团要从玩家身后飞出，身后第一步就被堵 ⇒ 进攻无效
    const ejectionPreview =
      center.ejects && s.holding !== null ? getEjectionPreview(s, ci) : null
    const ejectLanding = ejectionPreview?.landing ?? null
    if (center.ejects && s.holding !== null && ejectLanding === null) return s

    const { arms, leaving, extracted } = substitute(center, dir, s.holding)
    const directAfter = { ...center, arms, leaving }
    events?.push({
      type: 'attack',
      center: ci,
      dir,
      player: s.player,
      injected: s.holding,
      extracted: extracted ?? null,
    })
    events?.push({
      type: 'flip',
      center: ci,
      source: null,
      cause: 'attack',
      wave: 0,
      depth: 0,
      before: center,
      after: directAfter,
    })
    let centers = s.centers.map((c, i) => (i === ci ? directAfter : c))
    centers = propagate(centers, ci, s.stage, events, 0)

    let holding = s.holding
    let groups = s.groups
    if (s.holding !== null) {
      if (center.ejects) {
        // 携带珠已注入中心 ⇒ 手变空；被顶出的基团飞出（不入手）
        groups = [...groups, { pos: ejectLanding!, color: extracted! }]
        holding = null
      } else {
        holding = extracted ?? null
      }
    }

    // v4 弹射打结构联动：先触发落地光照，再判定中心撞入（可选，仅对显式开启的弹射中心）
    if (center.ejects && ejectionPreview !== null && ejectLanding !== null) {
      events?.push({ type: 'ejection', ...ejectionPreview })
      if (center.hitLights && hasVec(s.lights, ejectLanding[0], ejectLanding[1])) {
        centers = centers.map((c) => ({ ...c, leaving: nextPresentOpening(c) }))
      }
      const hi = ejectionPreview.blockedCenter
      if (center.hitCenters && hi !== null) {
        const hitCenter = centers[hi]
        const [adx, ady] = DIR_VEC[hitCenter.leaving]
        const onAttackFace =
          ejectLanding[0] === hitCenter.pos[0] - adx &&
          ejectLanding[1] === hitCenter.pos[1] - ady
        if (onAttackFace && !isShielded({ stage: s.stage, centers }, hitCenter)) {
          const before = centers[hi]
          centers = flipCenter(centers, hi)
          events?.push({
            type: 'flip',
            center: hi,
            source: null,
            cause: 'ejection',
            wave: 1,
            depth: 0,
            before,
            after: centers[hi],
          })
          centers = propagate(centers, hi, s.stage, events, 1)
        }
      }
    }

    const next: ChemState = { ...s, centers, holding, groups, moves: s.moves + 1 }
    const advanced = advance(next)
    return { ...advanced, won: isWin(advanced) }
  }

  // ---------- 普通移动（拾取 / 交换 + 光照格） ----------
  const gi = s.groups.findIndex((g) => g.pos[0] === nx && g.pos[1] === ny)
  let holding = s.holding
  let groups = s.groups
  if (gi >= 0) {
    const picked = s.groups[gi]
    groups = s.groups.filter((_, i) => i !== gi)
    if (s.holding !== null) {
      groups = [...groups, { pos: [nx, ny], color: s.holding }]
    }
    holding = picked.color
  }

  let centers = s.centers
  if (hasVec(s.lights, nx, ny)) {
    centers = centers.map((c) => ({
      ...c,
      leaving: nextPresentOpening(c),
    }))
  }

  const next: ChemState = {
    ...s,
    player: [nx, ny],
    holding,
    groups,
    centers,
    moves: s.moves + 1,
  }
  const advanced = advance(next)
  return { ...advanced, won: isWin(advanced) }
}

export function resolveChemStep(s: ChemState, dir: Dir): ChemStepResult {
  const events: ChemTransitionEvent[] = []
  return { state: resolveState(s, dir, events), action: dir, events }
}

export function step(s: ChemState, dir: Dir): ChemState {
  return resolveState(s, dir)
}

/**
 * 检视（Inspect，design §11 认知外置层）用：中心再被**纯翻转**一次后的构型。
 * 不含取代与共振——只回答「这个中心翻一次会变成什么」。纯函数，渲染层专用。
 */
export function peekFlip(center: ChemCenterState): ChemCenterState {
  return flipCenter([center], 0)[0]
}

export function isWin(s: ChemState): boolean {
  return s.stage >= s.stages.length
}

export function stateKey(s: ChemState): string {
  const centers = s.centers
    .map((c) => {
      const armsKey = DIRS
        .map((d) => c.arms[d] ?? '-')
        .join('/')
      return `${cellKey(c.pos[0], c.pos[1])}:${armsKey}@${c.leaving}`
    })
    .join('|')
  const groups = s.groups
    .map((g) => `${cellKey(g.pos[0], g.pos[1])}:${g.color}`)
    .sort()
    .join(',')
  // v6：预算关把剩余步数纳入 stateKey（solver/hint 正确性）；无预算关保持原格式
  const budget = s.moveLimit !== undefined ? `|L${s.moveLimit - s.moves}` : ''
  return `P${cellKey(s.player[0], s.player[1])}|H${s.holding ?? '-'}|T${s.stage}|G${groups}|${centers}${budget}`
}

export const chemGame: GameDefinition<ChemLevel, ChemState, Dir> = {
  id: 'chem',
  parseLevel: parseChemLevel,
  initialState,
  actions: () => DIRS,
  step,
  isWin,
  stateKey,
}
