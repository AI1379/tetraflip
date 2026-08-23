import { DIRS, DIR_VEC, cellKey } from '../../core/protocol'
import type { Dir, GameDefinition, Vec } from '../../core/protocol'
import { parseT3Level } from './level'
import type { T3Level } from './level'

/**
 * t+3 引擎（v0）。
 *
 * 时序：第 t 回合输入 u_t —— 当前棋子立即执行；
 * 延迟为 d 的回声棋子在第 t+d 回合执行 u_t。
 * 被墙 / 边界挡住的移动原地不动，但输入仍消耗回合并进入回声队列（刻意设计）。
 */

export interface T3EchoState {
  color: string
  pos: Vec
  goal: Vec
  delay: number
}

export interface T3State {
  width: number
  height: number
  /** cellKey 集合 */
  walls: readonly string[]
  player: { pos: Vec; goal: Vec }
  echoes: readonly T3EchoState[]
  /** 完整输入历史；回声队列由它派生（stateKey 只取最后 maxDelay 个） */
  history: readonly Dir[]
  won: boolean
}

export function initialState(level: T3Level): T3State {
  const state: T3State = {
    width: level.width,
    height: level.height,
    walls: level.walls.map(([x, y]) => cellKey(x, y)),
    player: { pos: level.player.start, goal: level.player.goal },
    echoes: level.echoes.map((e) => ({ color: e.color, pos: e.start, goal: e.goal, delay: e.delay })),
    history: [],
    won: false,
  }
  return { ...state, won: isWin(state) }
}

export function step(s: T3State, dir: Dir): T3State {
  if (s.won) return s
  const walls = new Set(s.walls)
  const tryMove = (pos: Vec, d: Dir): Vec => {
    const [dx, dy] = DIR_VEC[d]
    const nx = pos[0] + dx
    const ny = pos[1] + dy
    if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) return pos
    if (walls.has(cellKey(nx, ny))) return pos
    return [nx, ny]
  }

  const playerPos = tryMove(s.player.pos, dir)
  const echoes = s.echoes.map((echo) => {
    // 当前是第 history.length + 1 回合；回声回放第 (当前回合 - delay) 回合的输入
    const idx = s.history.length - echo.delay
    const fired = idx >= 0 ? s.history[idx] : undefined
    return fired ? { ...echo, pos: tryMove(echo.pos, fired) } : echo
  })

  const next: T3State = {
    ...s,
    player: { ...s.player, pos: playerPos },
    echoes,
    history: [...s.history, dir],
  }
  return { ...next, won: isWin(next) }
}

export function isWin(s: T3State): boolean {
  const on = (pos: Vec, goal: Vec): boolean => pos[0] === goal[0] && pos[1] === goal[1]
  return on(s.player.pos, s.player.goal) && s.echoes.every((e) => on(e.pos, e.goal))
}

export function maxDelay(s: T3State): number {
  return s.echoes.reduce((m, e) => Math.max(m, e.delay), 1)
}

export function stateKey(s: T3State): string {
  return [
    `P${cellKey(s.player.pos[0], s.player.pos[1])}`,
    ...s.echoes.map((e) => `${e.color}${cellKey(e.pos[0], e.pos[1])}`),
    `H${s.history.slice(-maxDelay(s)).join('')}`,
  ].join('|')
}

export const t3Game: GameDefinition<T3Level, T3State, Dir> = {
  id: 't3',
  parseLevel: parseT3Level,
  initialState,
  actions: () => DIRS,
  step,
  isWin,
  stateKey,
}
