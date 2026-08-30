/**
 * 精确状态图 + 多预算随机玩家。
 * pnpm difficulty:chem [level-01 ...] [--budgets=8,32,128] [--trials=40]
 *   [--max-states=100000] [--output=artifacts/difficulty/machine.json]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { analyzeChemDifficulty } from '../src/games/chem/difficulty'
import { simulateRandomizedChemPlayer } from '../src/games/chem/difficulty-agent'
import { listOption, loadChemLevels, numberOption, option, positionalArgs } from './difficulty-shared'

const budgets = listOption('budgets', [8, 32, 128])
const trials = numberOption('trials', 40)
const seed = numberOption('seed', 20_260_829)
const maxStates = numberOption('max-states', 100_000)
const output = resolve(process.cwd(), option('output') ?? 'artifacts/difficulty/machine.json')
const levels = loadChemLevels(positionalArgs())

const rows = []
for (const { file, ordinal, level } of levels) {
  const exact = analyzeChemDifficulty(level, { maxStates })
  const randomized = budgets.map((planningBudget) => simulateRandomizedChemPlayer(level, {
    planningBudget,
    trials,
    seed,
  }))
  const withoutLimit = level.moveLimit === undefined ? null : { ...level, moveLimit: undefined }
  const counterfactualWithoutMoveLimit = withoutLimit === null ? null : {
    exact: analyzeChemDifficulty(withoutLimit, { maxStates }),
    randomized: budgets.map((planningBudget) => simulateRandomizedChemPlayer(withoutLimit, {
      planningBudget,
      trials,
      seed,
    })),
  }
  rows.push({ file, ordinal, exact, randomized, counterfactualWithoutMoveLimit })
  console.log([
    file,
    `par=${level.par ?? '-'}`,
    `states=${exact.graph.reachableStates}${exact.graph.graphComplete ? '' : '+'}`,
    ...randomized.map((report) => `B${report.summary.planningBudget}=${Math.round(report.summary.successRate * 100)}%`),
    ...(counterfactualWithoutMoveLimit
      ? [`no-limit-B${budgets.at(-1)}=${Math.round(counterfactualWithoutMoveLimit.randomized.at(-1)!.summary.successRate * 100)}%`]
      : []),
  ].join('\t'))
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  config: { budgets, trials, seed, maxStates },
  levels: rows,
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`已写入 ${output}`)
