/**
 * 命令行 solver：pnpm solve chem <level-XX>
 * 验证关卡可解并打印最短解。未来 AI 关卡 pipeline 的「验证」环节复用同一逻辑。
 *
 * 引擎是零 DOM 纯函数，因此可以直接在 Node 侧被 import —— 这是架构刻意保证的。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DIR_ARROW } from '../src/core/protocol'
import type { AnyGame, Dir } from '../src/core/protocol'
import { solve } from '../src/core/solver'
import { chemGame } from '../src/games/chem'

const registry: Record<string, AnyGame> = { chem: chemGame }

const [gameId = 'chem', levelName = 'level-01'] = process.argv.slice(2)
const game = registry[gameId]
if (!game) {
  console.error(`未知游戏：${gameId}（可选：${Object.keys(registry).join(', ')}）`)
  process.exit(1)
}

const file = resolve(process.cwd(), 'src/games', gameId, 'levels', `${levelName}.json`)
let json: unknown
try {
  json = JSON.parse(readFileSync(file, 'utf-8'))
} catch (err) {
  console.error(`无法读取关卡：${file}\n${String(err)}`)
  process.exit(1)
}

const level = game.parseLevel(json)
const result = solve(game, level, { maxDepth: 30, maxVisits: 500_000 })

if (!result.solved) {
  console.error(
    `✗ ${gameId}/${levelName} 无解（访问 ${result.visited} 个状态，深度 ${result.depth}${result.truncated ? '，因限额截断' : ''}）`,
  )
  process.exit(1)
}

const pretty = result.solution
  .map((a) => (typeof a === 'string' && a in DIR_ARROW ? DIR_ARROW[a as Dir] : String(a)))
  .join(' ')
console.log(`✓ ${gameId}/${levelName}：最短解 ${result.solution.length} 步 → ${pretty}（访问 ${result.visited} 个状态）`)
