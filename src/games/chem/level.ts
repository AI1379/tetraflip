import { z } from 'zod'
import { cellKey } from '../../core/protocol'
import type { Dir, Vec } from '../../core/protocol'

/** Inversion（chem）关卡格式（JSON 化，zod 校验 + 手动语义校验） */

export interface ChemCenterDef {
  pos: Vec
  /** 四臂各持一个颜色基团 */
  arms: Record<Dir, string>
  /** 开口臂方向：攻击者必须朝这个方向移动撞入（= 从它的背面进攻） */
  leaving: Dir
}

export interface ChemGoal {
  center: number
  arm: Dir
  color: string
}

export interface ChemLevel {
  id: string
  name?: string
  width: number
  height: number
  walls: Vec[]
  player: Vec
  centers: ChemCenterDef[]
  goals: ChemGoal[]
}

const vec = z.tuple([z.number().int().min(0), z.number().int().min(0)])
const dir = z.enum(['N', 'E', 'S', 'W'])

const schema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  width: z.number().int().min(2).max(12),
  height: z.number().int().min(2).max(12),
  walls: z.array(vec).default([]),
  player: vec,
  centers: z
    .array(
      z.object({
        pos: vec,
        arms: z.object({
          N: z.string().min(1),
          E: z.string().min(1),
          S: z.string().min(1),
          W: z.string().min(1),
        }),
        leaving: dir,
      }),
    )
    .min(1),
  goals: z
    .array(z.object({ center: z.number().int().min(0), arm: dir, color: z.string().min(1) }))
    .min(1),
})

export function parseChemLevel(json: unknown): ChemLevel {
  const level = schema.parse(json)
  const { width: w, height: h } = level
  const fail = (msg: string): never => {
    throw new Error(`chem 关卡校验失败（${level.id}）：${msg}`)
  }
  const inBounds = (v: Vec, what: string): void => {
    if (v[0] >= w || v[1] >= h) fail(`${what} ${v} 超出边界`)
  }

  inBounds(level.player, '玩家')
  const wallSet = new Set<string>()
  for (const wall of level.walls) {
    inBounds(wall, '墙')
    const key = cellKey(wall[0], wall[1])
    if (wallSet.has(key)) fail(`墙重复 ${wall}`)
    wallSet.add(key)
  }

  const blocked = new Set<string>(wallSet)
  const playerKey = cellKey(level.player[0], level.player[1])
  if (blocked.has(playerKey)) fail('玩家位于墙上')
  blocked.add(playerKey)
  for (const c of level.centers) {
    inBounds(c.pos, '中心')
    const key = cellKey(c.pos[0], c.pos[1])
    if (blocked.has(key)) fail(`中心 ${c.pos} 与墙 / 玩家 / 其他中心重叠`)
    blocked.add(key)
    const colors = Object.values(c.arms)
    if (new Set(colors).size !== colors.length) fail(`中心 ${c.pos} 的四臂颜色必须互不相同`)
  }

  for (const g of level.goals) {
    const center = level.centers[g.center]
    if (!center) fail(`目标引用了不存在的中心 ${g.center}`)
    if (!Object.values(center.arms).includes(g.color)) {
      fail(`目标颜色 ${g.color} 不在其引用中心的四臂中（不可解）`)
    }
  }
  return level
}
