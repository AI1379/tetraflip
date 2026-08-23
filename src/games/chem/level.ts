import { z } from 'zod'
import { cellKey } from '../../core/protocol'
import type { Dir, Vec } from '../../core/protocol'

/** Inversion（chem）关卡格式（JSON 化，zod 校验 + 手动语义校验） */

export type CenterKind = 'tetra' | 'trigonal'

export interface ChemCenterDef {
  pos: Vec
  /** tetra：N/E/S/W 四臂；trigonal：只有 N/E/S 三臂（v3，见 design §5） */
  arms: Partial<Record<Dir, string>>
  /** 开口臂方向：攻击者必须朝这个方向移动撞入（= 从它的背面进攻） */
  leaving: Dir
  /** 三元中心（v3）：进攻 = 三臂轮换（mod 3）。缺省 tetra */
  kind?: CenterKind
  /** 保护基（v3）：脱保护前进攻无效、共振传不进去 */
  shielded?: boolean
  /** 弹射中心（v3）：持珠进攻时，被顶出的基团沿攻击反方向飞出（不入手） */
  ejects?: boolean
}

export interface ChemGoal {
  center: number
  arm: Dir
  color: string
}

/** 分步目标的一段（反应中间体，v3）：段内目标须同时满足，段间按顺序达成 */
export interface ChemStage {
  goals: ChemGoal[]
}

export interface ChemGroupDef {
  pos: Vec
  color: string
}

export interface ChemLauncherDef {
  pos: Vec
  dir: Dir
}

export interface ChemLevel {
  id: string
  name?: string
  /** 教学/点拨文案（纯展示，不进引擎与 stateKey） */
  hint?: string
  width: number
  height: number
  walls: Vec[]
  player: Vec
  centers: ChemCenterDef[]
  /** 游离基团（v1）：走上去拾取 / 交换。可选，缺省空 */
  groups: ChemGroupDef[]
  /** 分步目标（v3 规约化结果）：旧格式 `goals` 解析为单段 */
  stages: ChemStage[]
  /** v3 特殊格（全部可行走；互不重叠） */
  lights: Vec[]
  disposals: Vec[]
  deprotections: Vec[]
  launchers: ChemLauncherDef[]
  /** 标准杆（设计最短解，纯展示） */
  par?: number
}

const vec = z.tuple([z.number().int().min(0), z.number().int().min(0)])
const dir = z.enum(['N', 'E', 'S', 'W'])

const goalSchema = z.object({
  center: z.number().int().min(0),
  arm: dir,
  color: z.string().min(1),
})

const schema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    hint: z.string().optional(),
    width: z.number().int().min(2).max(12),
    height: z.number().int().min(2).max(12),
    walls: z.array(vec).default([]),
    player: vec,
    centers: z
      .array(
        z.object({
          pos: vec,
          arms: z.record(dir, z.string().min(1)),
          leaving: dir,
          kind: z.enum(['tetra', 'trigonal']).optional(),
          shielded: z.boolean().optional(),
          ejects: z.boolean().optional(),
        }),
      )
      .min(1),
    groups: z.array(z.object({ pos: vec, color: z.string().min(1) })).default([]),
    goals: z.array(goalSchema).min(1).optional(),
    stages: z.array(z.object({ goals: z.array(goalSchema).min(1) })).min(1).optional(),
    lights: z.array(vec).default([]),
    disposals: z.array(vec).default([]),
    deprotections: z.array(vec).default([]),
    launchers: z.array(z.object({ pos: vec, dir })).default([]),
    par: z.number().int().min(1).optional(),
  })
  .refine((l) => l.goals !== undefined || l.stages !== undefined, {
    message: 'goals 与 stages 至少提供一个',
  })
  .refine((l) => l.goals === undefined || l.stages === undefined, {
    message: 'goals 与 stages 不能同时提供（旧格式用 goals，分步用 stages）',
  })

/** 三元中心的臂方向与顺时针轮转（N→E→S→N） */
export const TRI_DIRS = ['N', 'E', 'S'] as const
export const triNext = (d: Dir): Dir =>
  d === 'N' ? 'E' : d === 'E' ? 'S' : d === 'S' ? 'N' : 'N'
export const triPrev = (d: Dir): Dir =>
  d === 'N' ? 'S' : d === 'S' ? 'E' : d === 'E' ? 'N' : 'N'

export function parseChemLevel(json: unknown): ChemLevel {
  const raw = schema.parse(json)
  const { width: w, height: h } = raw
  const fail = (msg: string): never => {
    throw new Error(`chem 关卡校验失败（${raw.id}）：${msg}`)
  }
  const inBounds = (v: Vec, what: string): void => {
    if (v[0] >= w || v[1] >= h) fail(`${what} ${v} 超出边界`)
  }

  inBounds(raw.player, '玩家')
  const wallSet = new Set<string>()
  for (const wall of raw.walls) {
    inBounds(wall, '墙')
    const key = cellKey(wall[0], wall[1])
    if (wallSet.has(key)) fail(`墙重复 ${wall}`)
    wallSet.add(key)
  }

  const blocked = new Set<string>(wallSet)
  const playerKey = cellKey(raw.player[0], raw.player[1])
  if (blocked.has(playerKey)) fail('玩家位于墙上')
  blocked.add(playerKey)

  for (const c of raw.centers) {
    inBounds(c.pos, '中心')
    const key = cellKey(c.pos[0], c.pos[1])
    if (blocked.has(key)) fail(`中心 ${c.pos} 与墙 / 玩家 / 其他中心重叠`)
    blocked.add(key)
    const kind = c.kind ?? 'tetra'
    const required = kind === 'tetra' ? (['N', 'E', 'S', 'W'] as const) : TRI_DIRS
    const arms = Object.keys(c.arms) as Dir[]
    for (const d of required) {
      if (!c.arms[d]) fail(`${kind} 中心 ${c.pos} 缺少 ${d} 臂`)
    }
    if (kind === 'trigonal' && arms.length !== 3) fail(`trigonal 中心 ${c.pos} 只能有 N/E/S 三臂`)
    if (kind === 'trigonal' && c.leaving === 'W') fail(`trigonal 中心 ${c.pos} 的开口不能是 W`)
    const colors = Object.values(c.arms)
    if (new Set(colors).size !== colors.length) fail(`中心 ${c.pos} 的各臂颜色必须互不相同`)
  }

  // 游离基团：不与墙 / 玩家 / 中心 / 其他基团 / 特殊格重叠
  const groupSet = new Set<string>()
  const specialCells = new Set<string>()
  const registerSpecial = (v: Vec, what: string): void => {
    inBounds(v, what)
    const key = cellKey(v[0], v[1])
    if (blocked.has(key)) fail(`${what} ${v} 与墙 / 玩家 / 中心重叠`)
    if (specialCells.has(key)) fail(`特殊格重叠 ${v}`)
    specialCells.add(key)
  }
  for (const v of raw.lights) registerSpecial(v, '光照格')
  for (const v of raw.disposals) registerSpecial(v, '回收格')
  for (const v of raw.deprotections) registerSpecial(v, '脱保护格')
  for (const l of raw.launchers) registerSpecial(l.pos, '弹射台')

  for (const g of raw.groups) {
    inBounds(g.pos, '游离基团')
    const key = cellKey(g.pos[0], g.pos[1])
    if (blocked.has(key)) fail(`游离基团 ${g.pos} 与墙 / 玩家 / 中心重叠`)
    if (specialCells.has(key)) fail(`游离基团 ${g.pos} 不能放在特殊格上`)
    if (groupSet.has(key)) fail(`游离基团重复 ${g.pos}`)
    groupSet.add(key)
  }

  // 规约化：旧格式 goals ⇒ 单段 stages
  const stages: ChemStage[] = raw.stages
    ? raw.stages.map((s) => ({ goals: [...s.goals] }))
    : [{ goals: [...(raw.goals ?? [])] }]

  // 目标校验：中心存在、臂存在（trigonal 无 W 臂）、颜色存在于任一臂或游离基团
  const palette = new Set<string>([
    ...raw.centers.flatMap((c) => Object.values(c.arms)),
    ...raw.groups.map((g) => g.color),
  ])
  for (const [si, stage] of stages.entries()) {
    for (const g of stage.goals) {
      const center = raw.centers[g.center]
      if (!center) fail(`第 ${si + 1} 段目标引用了不存在的中心 ${g.center}`)
      if (!center.arms[g.arm]) {
        fail(`第 ${si + 1} 段目标引用了中心 ${g.center} 不存在的 ${g.arm} 臂`)
      }
      if (!palette.has(g.color)) {
        fail(`第 ${si + 1} 段目标颜色 ${g.color} 不在本关任何中心臂或游离基团中（不可解）`)
      }
    }
  }

  return {
    id: raw.id,
    name: raw.name,
    hint: raw.hint,
    width: w,
    height: h,
    walls: raw.walls,
    player: raw.player,
    centers: raw.centers.map((c) => ({
      pos: c.pos,
      arms: { ...c.arms },
      leaving: c.leaving,
      kind: c.kind ?? 'tetra',
      shielded: c.shielded ?? false,
      ejects: c.ejects ?? false,
    })),
    groups: raw.groups,
    stages,
    lights: raw.lights,
    disposals: raw.disposals,
    deprotections: raw.deprotections,
    launchers: raw.launchers,
    par: raw.par,
  }
}
