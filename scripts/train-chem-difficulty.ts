/**
 * 每关独立、固定种子的 tabular Q-learning 样本效率基线。
 * pnpm difficulty:chem:rl [level-01 ...] [--episodes=3000] [--seeds=11,29,47]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { quantile } from '../src/core/statistics'
import { trainTabularChemQ } from '../src/games/chem/difficulty-rl'
import { listOption, loadChemLevels, numberOption, option, positionalArgs } from './difficulty-shared'

const episodes = numberOption('episodes', 3_000)
const seeds = listOption('seeds', [11, 29, 47])
const evaluationEvery = numberOption('evaluation-every', 100)
const evaluationTrials = numberOption('evaluation-trials', 40)
const output = resolve(process.cwd(), option('output') ?? 'artifacts/difficulty/rl.json')
const levels = loadChemLevels(positionalArgs())

function aggregateRuns(runs: ReturnType<typeof trainTabularChemQ>[]) {
  const threshold = runs.map((run) => run.episodesToThreshold ?? episodes + evaluationEvery)
  const finalRates = runs.map((run) => run.finalSuccessRate)
  const learningAuc = runs.map((run) => run.learningAuc)
  return {
    medianEpisodesToThreshold: quantile(threshold, 0.5)!,
    thresholdReachedSeeds: runs.filter((run) => run.episodesToThreshold !== null).length,
    meanFinalSuccessRate: finalRates.reduce((sum, value) => sum + value, 0) / runs.length,
    meanLearningAuc: learningAuc.reduce((sum, value) => sum + value, 0) / runs.length,
  }
}

const rows = []
for (const { file, ordinal, level } of levels) {
  const runs = seeds.map((seed) => trainTabularChemQ(level, {
    episodes,
    seed,
    evaluationEvery,
    evaluationTrials,
  }))
  const aggregate = aggregateRuns(runs)
  const withoutLimit = level.moveLimit === undefined ? null : { ...level, moveLimit: undefined }
  const counterfactualRuns = withoutLimit === null ? null : seeds.map((seed) => trainTabularChemQ(withoutLimit, {
    episodes,
    seed,
    evaluationEvery,
    evaluationTrials,
  }))
  const counterfactualWithoutMoveLimit = counterfactualRuns === null ? null : {
    aggregate: aggregateRuns(counterfactualRuns),
    runs: counterfactualRuns,
  }
  rows.push({ file, ordinal, levelId: level.id, aggregate, runs, counterfactualWithoutMoveLimit })
  console.log([
    file,
    `threshold=${aggregate.medianEpisodesToThreshold}`,
    `seeds=${aggregate.thresholdReachedSeeds}/${seeds.length}`,
    `final=${Math.round(aggregate.meanFinalSuccessRate * 100)}%`,
    ...(counterfactualWithoutMoveLimit
      ? [`no-limit=${counterfactualWithoutMoveLimit.aggregate.medianEpisodesToThreshold}`]
      : []),
  ].join('\t'))
}

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  config: {
    episodes,
    seeds,
    evaluationEvery,
    evaluationTrials,
    rewardModel: 'normalized-progress-potential-v2',
  },
  levels: rows,
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`已写入 ${output}`)
