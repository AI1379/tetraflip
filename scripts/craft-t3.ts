/**
 * t+3 关卡构造-验证工具（AI 关卡 pipeline 的第一块，见 docs/design.md §7）。
 *
 * 用法：pnpm craft:t3 <spec.json> [--write]
 *
 * spec 格式：{
 *   id, name?, hint?, file,           // file = level-XX（不含 .json）
 *   width, height, walls,
 *   playerStart: [x, y],
 *   echoes: [{ color, start: [x, y], delay }],
 *   seq: "EESWN..."                   // 预期解序列
 * }
 *
 * 行为：
 *   1. 用真实引擎跑一遍 seq（临时关卡 goal=start），各棋子末位置即为目标格；
 *   2. 生成关卡 JSON，走 parseLevel（zod + 语义）校验；
 *   3. 用通用 solver 核对可解性与最短解长度：
 *      - 最短解 == len(seq)：符合设计意图；
 *      - 最短解 <  len(seq)：存在捷径，需按设计意图决定是否改图；
 *      - 无解：构造错误（理论上不会发生，seq 本身就是一组解）。
 *   4. 仅在 --write 时写入 src/games/t3/levels/<file>.json。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DIR_ARROW } from '../src/core/protocol'
import type { Dir, Vec } from '../src/core/protocol'
import { solve } from '../src/core/solver'
import { initialState, step, t3Game } from '../src/games/t3/engine'

const [, , specPath, flag] = process.argv
if (!specPath) {
  console.error('用法：pnpm craft:t3 <spec.json> [--write]')
  process.exit(1)
}

interface Spec {
  id: string
  name?: string
  hint?: string
  file: string
  width: number
  height: number
  walls: [number, number][]
  playerStart: [number, number]
  echoes: { color: string; start: [number, number]; delay: number }[]
  seq: string
}

const spec: Spec = JSON.parse(readFileSync(resolve(process.cwd(), specPath), 'utf-8'))
const seq = spec.seq.toUpperCase().split('') as Dir[]
for (const c of seq) {
  if (!['N', 'E', 'S', 'W'].includes(c)) {
    console.error(`seq 含非法方向字符：${c}`)
    process.exit(1)
  }
}

// 1) 临时关卡（统一假目标，保证初始未胜利）跑 seq，得到轨迹与末位置
// 假目标取第一个「不是墙、不是任何起点」的格子——否则初始即胜利，step 会拒绝移动
const starts = [spec.playerStart, ...spec.echoes.map((e) => e.start)]
const wallSet = new Set(spec.walls.map(([x, y]) => `${x},${y}`))
let dummyGoal: [number, number] | undefined
for (let y = 0; y < spec.height && !dummyGoal; y++) {
  for (let x = 0; x < spec.width && !dummyGoal; x++) {
    const isStart = starts.some(([sx, sy]) => sx === x && sy === y)
    if (!wallSet.has(`${x},${y}`) && !isStart) dummyGoal = [x, y]
  }
}
if (!dummyGoal) {
  console.error('棋盘上找不到可用的假目标格')
  process.exit(1)
}
const temp = {
  id: spec.id,
  width: spec.width,
  height: spec.height,
  walls: spec.walls,
  player: { start: spec.playerStart, goal: dummyGoal },
  echoes: spec.echoes.map((e) => ({ ...e, goal: dummyGoal })),
}
let s = initialState(t3Game.parseLevel(temp))
const traces: Record<string, Vec[]> = { P: [s.player.pos] }
for (const e of s.echoes) traces[e.color] = [e.pos]
for (const dir of seq) {
  s = step(s, dir)
  traces.P.push(s.player.pos)
  for (const e of s.echoes) traces[e.color].push(e.pos)
}

const level: Record<string, unknown> = {
  id: spec.id,
  ...(spec.name !== undefined ? { name: spec.name } : {}),
  ...(spec.hint !== undefined ? { hint: spec.hint } : {}),
  width: spec.width,
  height: spec.height,
  walls: spec.walls,
  player: { start: spec.playerStart, goal: s.player.pos },
  echoes: spec.echoes.map((e, i) => ({
    color: e.color,
    start: e.start,
    goal: s.echoes[i].pos,
    delay: e.delay,
  })),
}

/** 紧凑格式：与手写关卡（level-01）的排版一致 */
function formatLevel(l: typeof level): string {
  const vec = (v: readonly [number, number]): string => `[${v[0]}, ${v[1]}]`
  const walls = (l.walls as [number, number][]).map(vec).join(', ')
  const player = l.player as { start: [number, number]; goal: [number, number] }
  const echoes = (l.echoes as { color: string; start: [number, number]; goal: [number, number]; delay: number }[]).map(
    (e) =>
      `    { "color": ${JSON.stringify(e.color)}, "start": ${vec(e.start)}, "goal": ${vec(e.goal)}, "delay": ${e.delay} }`,
  )
  const body = [
    `  "id": ${JSON.stringify(l.id)},`,
    l.name !== undefined ? `  "name": ${JSON.stringify(l.name)},` : null,
    l.hint !== undefined ? `  "hint": ${JSON.stringify(l.hint)},` : null,
    `  "width": ${l.width},`,
    `  "height": ${l.height},`,
    `  "walls": [${walls}],`,
    `  "player": { "start": ${vec(player.start)}, "goal": ${vec(player.goal)} },`,
    echoes.length === 0 ? '  "echoes": []' : `  "echoes": [\n${echoes.join(',\n')}\n  ]`,
  ].filter((x): x is string => x !== null)
  return `{\n${body.join('\n')}\n}\n`
}

// 2) zod + 语义校验
const parsed = t3Game.parseLevel(level)

// 3) solver 核对
const result = solve(t3Game, parsed, {
  maxDepth: Math.max(32, seq.length + 8),
  maxVisits: 500_000,
})

console.log(`轨迹（${seq.join(' ')}）：`)
for (const [name, trace] of Object.entries(traces)) {
  console.log(`  ${name}: ${trace.map(([x, y]) => `(${x},${y})`).join(' ')}`)
}
console.log(`生成关卡 ${spec.id}：`)
console.log(formatLevel(level))

if (!result.solved) {
  console.error('✗ 构造异常：预期解序列应保证可解，请检查脚本')
  process.exit(1)
}
const pretty = result.solution.map((d) => DIR_ARROW[d]).join(' ')
if (result.solution.length === seq.length) {
  console.log(`✓ 最短解 ${result.solution.length} 步 == 预期序列长度（${pretty}；访问 ${result.visited} 状态）`)
} else {
  console.warn(
    `⚠ 最短解 ${result.solution.length} 步 < 预期序列 ${seq.length} 步，存在捷径（${pretty}）——按设计意图决定是否改图`,
  )
}

// 4) 写盘
if (flag === '--write') {
  const out = resolve(process.cwd(), 'src/games/t3/levels', `${spec.file}.json`)
  writeFileSync(out, formatLevel(level), 'utf-8')
  console.log(`已写入 ${out}`)
} else {
  console.log('（未写盘；确认后加 --write 重跑）')
}
