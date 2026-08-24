import { DIRS, DIR_VEC, cellKey, opposite } from '../../core/protocol'
import type { Dir, GameDefinition, Vec } from '../../core/protocol'
import { parseChemLevel } from './level'
import type { CenterKind, ChemLauncherDef, ChemLevel, ChemStage } from './level'

/**
 * Inversion（chem）引擎（v1 搬运 + v2 共振 + v3 机制群，见 docs/design.md §5）。
 *
 * 基础（v0–v2）：
 * - 玩家方向键移动；撞向中心格 = 尝试进攻（玩家不进入中心格）。
 * - 进攻有效 ⇔ 目标中心未受保护 且 玩家移动方向 === 中心当前开口臂方向。
 * - 空手进攻 = 纯翻转；持基团进攻 = 取代 + 翻转（装入正对攻击者的臂，开口臂基团换入手中）。
 * - 共振传导：翻转后，面对臂同色的相邻未翻中心被传导纯翻转；保护罩中心传不进去（链闸）。
 *
 * v3 机制群：
 * - 三臂中心（kind='trigonal'）：四槽中恰好缺一臂；与普通中心同样整体翻转 180°，
 *   三颗珠、缺口与开口一起转到对侧，持珠取代也完全复用普通中心语义（周期 2）。
 * - 弹射中心（ejects）：持珠进攻时，携带珠照常注入（手变空），被顶出的基团沿攻击反方向
 *   从玩家身后飞出，落到射线第一个障碍前一格；身后第一格即被堵 ⇒ 进攻无效。
 * - 光照格：玩家走入的一瞬，所有中心的开口顺时针移到下一条现存臂（三臂中心跳过缺口）。
 * - 回收格：手持色珠走入 ⇒ 销毁、手变空。
 * - 保护基 / 脱保护格：受保护中心进攻无效、共振不入；首次走上脱保护格永久解除全场保护。
 * - 弹射台：手持色珠走入 ⇒ 色珠沿台面方向直线飞出（远程取代 / 落珠），手清空。
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
  shielded: boolean
  ejects: boolean
}

export interface ChemGroupState {
  pos: Vec
  color: string
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
  /** 是否已脱保护（v3） */
  deprotected: boolean
  /** 关卡静态特殊格（不进 stateKey） */
  lights: readonly Vec[]
  disposals: readonly Vec[]
  deprotections: readonly Vec[]
  launchers: readonly ChemLauncherDef[]
  /** 标准杆（纯展示，不进 stateKey） */
  par?: number
  /** 纯计数器，不参与 stateKey */
  moves: number
  won: boolean
}

const hasVec = (list: readonly Vec[], x: number, y: number): boolean =>
  list.some((v) => v[0] === x && v[1] === y)

const isShielded = (s: Pick<ChemState, 'deprotected'>, c: ChemCenterState): boolean =>
  c.shielded && !s.deprotected

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
  deprotected: boolean,
): ChemCenterState[] {
  const flipped = new Set<number>([start])
  const queue: number[] = [start]
  while (queue.length > 0) {
    const x = queue.shift()!
    const xc = centers[x]
    for (const d of presentArmDirs(xc)) {
      const [ex, ey] = DIR_VEC[d]
      const yi = centers.findIndex(
        (c) => c.pos[0] === xc.pos[0] + ex && c.pos[1] === xc.pos[1] + ey,
      )
      if (yi < 0 || flipped.has(yi)) continue
      const yc = centers[yi]
      if (yc.shielded && !deprotected) continue // 链闸：保护罩挡住共振
      if (centers[x].arms[d] === centers[yi].arms[opposite(d)]) {
        centers = flipCenter(centers, yi)
        flipped.add(yi)
        queue.push(yi)
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
function scanLanding(s: ChemState, from: Vec, dir: Dir): Vec | null {
  const [dx, dy] = DIR_VEC[dir]
  let cx = from[0] + dx
  let cy = from[1] + dy
  let last: Vec | null = null
  while (cx >= 0 && cy >= 0 && cx < s.width && cy < s.height) {
    if (s.walls.includes(cellKey(cx, cy))) break
    if (s.centers.some((c) => c.pos[0] === cx && c.pos[1] === cy)) break
    if (s.groups.some((g) => g.pos[0] === cx && g.pos[1] === cy)) break
    last = [cx, cy]
    cx += dx
    cy += dy
  }
  return last
}

/** 落点修正：落点不能是玩家所在格；若是，沿 backDir 向后找空格，找不到则销毁（null） */
function resolveLanding(s: ChemState, preferred: Vec, backDir: Dir): Vec | null {
  if (preferred[0] !== s.player[0] || preferred[1] !== s.player[1]) return preferred
  return scanLanding(s, s.player, backDir)
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
      shielded: c.shielded ?? false,
      ejects: c.ejects ?? false,
    })),
    groups: level.groups.map((g) => ({ pos: g.pos, color: g.color })),
    stages: level.stages,
    stage: 0,
    deprotected: false,
    lights: level.lights,
    disposals: level.disposals,
    deprotections: level.deprotections,
    launchers: level.launchers,
    par: level.par,
    moves: 0,
    won: false,
  }
  const advanced = advance(state)
  return { ...advanced, won: isWin(advanced) }
}

export function step(s: ChemState, dir: Dir): ChemState {
  if (s.won) return s
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
    let ejectLanding: Vec | null = null
    if (center.ejects && s.holding !== null) {
      ejectLanding = scanLanding(s, s.player, opposite(dir))
      if (ejectLanding === null) return s
    }

    const { arms, leaving, extracted } = substitute(center, dir, s.holding)
    let centers = s.centers.map((c, i) => (i === ci ? { ...c, arms, leaving } : c))
    centers = propagate(centers, ci, s.deprotected)

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
    const next: ChemState = { ...s, centers, holding, groups, moves: s.moves + 1 }
    const advanced = advance(next)
    return { ...advanced, won: isWin(advanced) }
  }

  // ---------- 弹射台：手持走入 ⇒ 发射 ----------
  const launcher = s.launchers.find((l) => l.pos[0] === nx && l.pos[1] === ny)
  if (launcher && s.holding !== null) {
    const fired = fireBead(s, launcher, s.holding)
    const next: ChemState = {
      ...s,
      player: [nx, ny],
      holding: null,
      centers: fired.centers,
      groups: fired.groups,
      moves: s.moves + 1,
    }
    const advanced = advance(next)
    return { ...advanced, won: isWin(advanced) }
  }

  // ---------- 普通移动（拾取 / 交换 + 特殊格） ----------
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
  let deprotected = s.deprotected
  if (hasVec(s.lights, nx, ny)) {
    centers = centers.map((c) => ({
      ...c,
      leaving: nextPresentOpening(c),
    }))
  }
  if (hasVec(s.disposals, nx, ny) && holding !== null) holding = null
  if (hasVec(s.deprotections, nx, ny)) deprotected = true

  const next: ChemState = {
    ...s,
    player: [nx, ny],
    holding,
    groups,
    centers,
    deprotected,
    moves: s.moves + 1,
  }
  const advanced = advance(next)
  return { ...advanced, won: isWin(advanced) }
}

/**
 * 弹射台发射（v3）：色珠沿台面方向直线飞出。
 * - 命中开口方向一致且未受保护的中心 ⇒ 远程取代：色珠装入，被顶出的基团落回色珠刚离开的格子，触发共振。
 * - 命中方向不合 / 保护罩中心 / 墙 / 其他色珠 ⇒ 停在障碍前一格变游离珠。
 * - 飞出棋盘 ⇒ 停在最后一格。
 */
function fireBead(
  s: ChemState,
  launcher: ChemLauncherDef,
  color: string,
): { centers: ChemCenterState[]; groups: ChemGroupState[] } {
  const [dx, dy] = DIR_VEC[launcher.dir]
  let prev: Vec = launcher.pos
  let cx = launcher.pos[0] + dx
  let cy = launcher.pos[1] + dy
  let centers = [...s.centers]
  let groups = [...s.groups]
  const drop = (at: Vec, c: string): void => {
    // 发射时玩家已站上弹射台：落点判定以台面为新玩家位
    const ctx: ChemState = { ...s, player: launcher.pos, centers, groups }
    const landing = resolveLanding(ctx, at, opposite(launcher.dir))
    if (landing !== null) groups = [...groups, { pos: landing, color: c }]
  }
  while (cx >= 0 && cy >= 0 && cx < s.width && cy < s.height) {
    if (s.walls.includes(cellKey(cx, cy))) {
      drop(prev, color)
      return { centers, groups }
    }
    const ci = centers.findIndex((c) => c.pos[0] === cx && c.pos[1] === cy)
    if (ci >= 0) {
      const target = centers[ci]
      if (!isShielded(s, target) && target.leaving === launcher.dir) {
        const { arms, leaving, extracted } = substitute(target, launcher.dir, color)
        centers = centers.map((c, i) => (i === ci ? { ...c, arms, leaving } : c))
        centers = propagate(centers, ci, s.deprotected)
        if (extracted !== undefined) drop(prev, extracted)
        return { centers, groups }
      }
      drop(prev, color)
      return { centers, groups }
    }
    if (groups.some((g) => g.pos[0] === cx && g.pos[1] === cy)) {
      drop(prev, color)
      return { centers, groups }
    }
    prev = [cx, cy]
    cx += dx
    cy += dy
  }
  drop(prev, color) // 飞出棋盘：停在界内最后一格
  return { centers, groups }
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
  return `P${cellKey(s.player[0], s.player[1])}|H${s.holding ?? '-'}|D${s.deprotected ? 1 : 0}|T${s.stage}|G${groups}|${centers}`
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
