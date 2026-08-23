import { z } from 'zod'
import { cellKey } from '../../core/protocol'
import type { Vec } from '../../core/protocol'

/** t+3 关卡格式（JSON 化，zod 校验 + 手动语义校验） */

export interface T3EchoDef {
  color: string
  start: Vec
  goal: Vec
  delay: number
}

export interface T3Level {
  id: string
  name?: string
  width: number
  height: number
  walls: Vec[]
  player: { start: Vec; goal: Vec }
  echoes: T3EchoDef[]
}

const vec = z.tuple([z.number().int().min(0), z.number().int().min(0)])

const schema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  width: z.number().int().min(2).max(12),
  height: z.number().int().min(2).max(12),
  walls: z.array(vec).default([]),
  player: z.object({ start: vec, goal: vec }),
  echoes: z
    .array(
      z.object({
        color: z.string().min(1),
        start: vec,
        goal: vec,
        delay: z.number().int().min(1).max(9),
      }),
    )
    .default([]),
})

export function parseT3Level(json: unknown): T3Level {
  const level = schema.parse(json)
  const { width: w, height: h } = level
  const fail = (msg: string): never => {
    throw new Error(`t+3 关卡校验失败（${level.id}）：${msg}`)
  }
  const inBounds = (v: Vec, what: string): void => {
    if (v[0] >= w || v[1] >= h) fail(`${what} ${v} 超出边界`)
  }

  inBounds(level.player.start, '玩家起点')
  inBounds(level.player.goal, '玩家目标')
  const wallSet = new Set<string>()
  for (const wall of level.walls) {
    inBounds(wall, '墙')
    const key = cellKey(wall[0], wall[1])
    if (wallSet.has(key)) fail(`墙重复 ${wall}`)
    wallSet.add(key)
  }

  const cells: Array<[Vec, string]> = [
    [level.player.start, '玩家起点'],
    [level.player.goal, '玩家目标'],
  ]
  const seenColors = new Set<string>()
  const starts = new Set<string>()
  for (const echo of level.echoes) {
    inBounds(echo.start, `回声(${echo.color})起点`)
    inBounds(echo.goal, `回声(${echo.color})目标`)
    if (seenColors.has(echo.color)) fail(`回声颜色重复：${echo.color}`)
    seenColors.add(echo.color)
    if (echo.color === 'white') fail('回声颜色不能为 white（white 是玩家）')
    cells.push([echo.start, `回声(${echo.color})起点`], [echo.goal, `回声(${echo.color})目标`])
    const sk = cellKey(echo.start[0], echo.start[1])
    if (starts.has(sk) || sk === cellKey(level.player.start[0], level.player.start[1])) {
      fail(`回声(${echo.color})起点与其他棋子重叠`)
    }
    starts.add(sk)
  }
  for (const [v, what] of cells) {
    if (wallSet.has(cellKey(v[0], v[1]))) fail(`${what}落在墙上`)
  }
  return level
}
