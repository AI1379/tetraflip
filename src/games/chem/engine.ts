import { DIRS, DIR_VEC, cellKey, opposite } from '../../core/protocol'
import type { Dir, GameDefinition, Vec } from '../../core/protocol'
import { parseChemLevel } from './level'
import type { ChemLevel } from './level'

/**
 * Inversion（chem）引擎（v0 占位规则，见 docs/design.md §5）。
 *
 * - 玩家方向键移动；撞向中心格 = 尝试进攻（玩家不进入中心格）。
 * - 进攻有效 ⇔ 玩家移动方向 === 中心当前开口臂方向（即从开口臂背面撞入）。
 * - 进攻成功：四臂 180° 对调（N↔S、E↔W，Walden 翻转的 2D 抽象），
 *   开口臂翻转到对侧。玩家留在原地，消耗一回合。
 * - 无效进攻 / 撞墙 / 撞边界：无效果，不消耗回合（返回原状态）。
 */

export interface ChemCenterState {
  pos: Vec
  arms: Record<Dir, string>
  leaving: Dir
}

export interface ChemGoalRef {
  center: number
  arm: Dir
  color: string
}

export interface ChemState {
  width: number
  height: number
  /** cellKey 集合 */
  walls: readonly string[]
  player: Vec
  centers: readonly ChemCenterState[]
  goals: readonly ChemGoalRef[]
  /** 纯计数器，不参与 stateKey */
  moves: number
  won: boolean
}

export function initialState(level: ChemLevel): ChemState {
  const state: ChemState = {
    width: level.width,
    height: level.height,
    walls: level.walls.map(([x, y]) => cellKey(x, y)),
    player: level.player,
    centers: level.centers.map((c) => ({ pos: c.pos, arms: { ...c.arms }, leaving: c.leaving })),
    goals: level.goals,
    moves: 0,
    won: false,
  }
  return { ...state, won: isWin(state) }
}

export function step(s: ChemState, dir: Dir): ChemState {
  if (s.won) return s
  const [dx, dy] = DIR_VEC[dir]
  const nx = s.player[0] + dx
  const ny = s.player[1] + dy
  if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) return s
  if (s.walls.includes(cellKey(nx, ny))) return s

  const ci = s.centers.findIndex((c) => c.pos[0] === nx && c.pos[1] === ny)
  if (ci >= 0) {
    const center = s.centers[ci]
    if (dir !== center.leaving) return s // 非背面进攻：无效果
    const arms: Record<Dir, string> = {
      N: center.arms.S,
      S: center.arms.N,
      E: center.arms.W,
      W: center.arms.E,
    }
    const centers = s.centers.map((c, i) =>
      i === ci ? { ...c, arms, leaving: opposite(center.leaving) } : c,
    )
    const next: ChemState = { ...s, centers, moves: s.moves + 1 }
    return { ...next, won: isWin(next) }
  }

  const next: ChemState = { ...s, player: [nx, ny], moves: s.moves + 1 }
  return { ...next, won: isWin(next) }
}

export function isWin(s: ChemState): boolean {
  return s.goals.every((g) => s.centers[g.center].arms[g.arm] === g.color)
}

export function stateKey(s: ChemState): string {
  const centers = s.centers
    .map(
      (c) =>
        `${cellKey(c.pos[0], c.pos[1])}:${c.arms.N}/${c.arms.E}/${c.arms.S}/${c.arms.W}@${c.leaving}`,
    )
    .join('|')
  return `P${cellKey(s.player[0], s.player[1])}|${centers}`
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
