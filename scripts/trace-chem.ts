/**
 * 调试脚本：回放 solver 最短解，逐步打印 玩家位置 / 手持 / 各中心臂与开口。
 * 用于「预期解 vs 实际最短解」比对（design §7 pipeline 证据留档）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DIR_ARROW } from '../src/core/protocol'
import type { Dir } from '../src/core/protocol'
import { solve } from '../src/core/solver'
import { chemGame } from '../src/games/chem'
import { initialState, step } from '../src/games/chem/engine'
import { isShielded } from '../src/games/chem/engine'
import type { ChemState } from '../src/games/chem/engine'

const name = process.argv[2] ?? 'level-15'
const manual = process.argv[3]
const file = resolve(process.cwd(), 'src/games/chem/levels', `${name}.json`)
const level = chemGame.parseLevel(JSON.parse(readFileSync(file, 'utf-8')))

const fmt = (s: ChemState): string => {
  const activeGoals = s.stage < s.stages.length ? s.stages[s.stage].goals : []
  return [
    `P(${s.player}) 手持=${s.holding ?? '—'} 段${s.stage}/${s.stages.length}`,
    ...s.centers.map(
      (c, i) =>
        `#${i}${c.pos}${c.kind === 'trigonal' ? '(三)' : ''} 臂[${(
          ['N', 'E', 'S', 'W'] as const
        )
          .map((d) => `${d}${c.arms[d] ?? '·'}`)
          .join('|')}] 开口${c.leaving}${isShielded(s, c) ? ` 🛡→${c.shieldUntilStage}` : ''}` +
        (activeGoals
          .filter((g) => g.center === i)
          .every((g) => c.arms[g.arm] === g.color)
          ? ' ✓达标'
          : ''),
    ),
    `场珠=${s.groups.map((g) => `${g.pos}:${g.color}`).join(' ') || '—'}`,
  ].join('  ')
}

const parsedManual = manual
  ?.split('')
  .filter((d): d is Dir => ['N', 'E', 'S', 'W'].includes(d))
const result = parsedManual
  ? { solved: true, solution: parsedManual }
  : solve(chemGame, level, { maxDepth: 30, maxVisits: 500_000 })
if (!result.solved) {
  console.error(`无解：${name}`)
  process.exit(1)
}
console.log(`${name} ${parsedManual ? '指定轨迹' : '最短解'} ${result.solution.length} 步`)
let s = initialState(level)
console.log(`  初始  ${fmt(s)}`)
result.solution.forEach((a, i) => {
  s = step(s, a as Dir)
  console.log(`  ${String(i + 1).padStart(2)} ${DIR_ARROW[a as Dir]}  ${fmt(s)}${s.won ? '  ★WIN' : ''}`)
})
