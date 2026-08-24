/**
 * 《109.5°》最短解走路税审计。
 *
 * pnpm audit:chem                  # 审计全部关卡
 * pnpm audit:chem level-13 14 20  # 可混用 level-XX / XX
 *
 * 「有效交互」指成功进攻，或一步移动同时改变了手持 / 场珠 / 中心 / 保护状态；
 * 其余只改变玩家坐标的动作记为普通移动。指标用于发现纯通勤，不是关卡质量硬阈值。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Dir } from '../src/core/protocol'
import { solve } from '../src/core/solver'
import { chemGame } from '../src/games/chem'
import { initialState, step } from '../src/games/chem/engine'
import type { ChemState } from '../src/games/chem/engine'

type ActionKind = '进攻' | '机制格/换珠' | '普通移动'

const levelsDir = resolve(process.cwd(), 'src/games/chem/levels')

function normalizeName(raw: string): string {
  const stem = basename(raw, '.json')
  if (stem.startsWith('level-')) return stem
  return `level-${stem.padStart(2, '0')}`
}

function mechanismKey(s: ChemState): string {
  return JSON.stringify({
    holding: s.holding,
    centers: s.centers.map((c) => ({ arms: c.arms, leaving: c.leaving })),
    groups: s.groups,
    deprotected: s.deprotected,
  })
}

function classify(before: ChemState, after: ChemState): ActionKind {
  if (before.player[0] === after.player[0] && before.player[1] === after.player[1]) {
    return '进攻'
  }
  return mechanismKey(before) === mechanismKey(after) ? '普通移动' : '机制格/换珠'
}

const requested = process.argv.slice(2)
const names =
  requested.length > 0
    ? requested.map(normalizeName)
    : readdirSync(levelsDir)
        .filter((file) => /^level-\d+\.json$/.test(file))
        .map((file) => basename(file, '.json'))
        .sort()

console.log('关卡      步数  交互  普通移动  决策密度  最长通勤  访问状态')
for (const name of names) {
  const file = resolve(levelsDir, `${name}.json`)
  const level = chemGame.parseLevel(JSON.parse(readFileSync(file, 'utf-8')))
  const result = solve(chemGame, level, { maxDepth: 30, maxVisits: 500_000 })
  if (!result.solved) {
    console.log(`${name.padEnd(10)} 无解${result.truncated ? '（搜索被截断）' : ''}`)
    process.exitCode = 1
    continue
  }

  let state = initialState(level)
  let interactions = 0
  let walkRun = 0
  let maxWalkRun = 0
  for (const action of result.solution as readonly Dir[]) {
    const next = step(state, action)
    if (classify(state, next) === '普通移动') {
      walkRun++
      maxWalkRun = Math.max(maxWalkRun, walkRun)
    } else {
      interactions++
      walkRun = 0
    }
    state = next
  }

  const steps = result.solution.length
  const walking = steps - interactions
  const density = steps === 0 ? 0 : interactions / steps
  console.log(
    [
      name.padEnd(10),
      String(steps).padStart(4),
      String(interactions).padStart(4),
      String(walking).padStart(8),
      `${Math.round(density * 100)}%`.padStart(9),
      String(maxWalkRun).padStart(8),
      String(result.visited).padStart(8),
    ].join('  '),
  )
}
