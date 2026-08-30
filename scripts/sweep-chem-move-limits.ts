/**
 * 对已通过多代理门槛的关卡扫描最小可接受 moveLimit。
 * pnpm difficulty:chem:budget-sweep level-64 level-70 level-74
 *   [--planning-budget=128] [--trials=40] [--seeds=20260830,20260930,20261030]
 *   [--max-extra=8] [--output=artifacts/difficulty/move-limit-sweep.json]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { simulateRandomizedChemPlayer } from '../src/games/chem/difficulty-agent'
import { listOption, loadChemLevels, numberOption, option, positionalArgs } from './difficulty-shared'

const planningBudget = numberOption('planning-budget', 128)
const trials = numberOption('trials', 40)
const seeds = listOption('seeds', [20_260_830, 20_260_930, 20_261_030])
const maxExtra = numberOption('max-extra', 8)
const output = resolve(
  process.cwd(),
  option('output') ?? 'artifacts/difficulty/move-limit-sweep.json',
)
const levels = loadChemLevels(positionalArgs())

if (levels.length === 0) throw new Error('至少指定一个候选关卡')
if (seeds.length < 3) throw new Error('正式预算扫描至少需要 3 个 seed')
if (!Number.isInteger(maxExtra) || maxExtra < 0) throw new Error('max-extra 必须是非负整数')

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

const rows = levels.map(({ file, ordinal, level }) => {
  if (level.moveLimit === undefined) throw new Error(`${file} 没有 moveLimit，不能扫描红线`)
  const candidates = Array.from({ length: maxExtra + 1 }, (_, offset) => level.moveLimit! + offset)
    .map((moveLimit) => {
      const seedReports = seeds.map((seed) => simulateRandomizedChemPlayer(
        { ...level, moveLimit },
        { planningBudget, trials, seed, maxMovesPerAttempt: moveLimit },
      ))
      const successRates = seedReports.map((report) => report.summary.successRate)
      return {
        moveLimit,
        successRates,
        medianSuccessRate: median(successRates),
        minimumSuccessRate: Math.min(...successRates),
      }
    })
  const recommendation = candidates.find(
    (candidate) => candidate.medianSuccessRate >= 0.8 && candidate.minimumSuccessRate >= 0.7,
  )?.moveLimit ?? null
  console.log([
    file,
    `current=${level.moveLimit}`,
    ...candidates.map((candidate) =>
      `${candidate.moveLimit}:${Math.round(candidate.medianSuccessRate * 100)}%/${Math.round(candidate.minimumSuccessRate * 100)}%`),
    `recommend=${recommendation ?? 'keep'}`,
  ].join('\t'))
  return {
    file,
    ordinal,
    levelId: level.id,
    name: level.name,
    par: level.par ?? null,
    currentMoveLimit: level.moveLimit,
    recommendation,
    candidates,
  }
})

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: 'machine-proxy-human-uncalibrated',
  rule: {
    medianSuccessRateAtLeast: 0.8,
    minimumSuccessRateAtLeast: 0.7,
  },
  config: { planningBudget, trials, seeds, maxExtra },
  levels: rows,
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`已写入 ${output}`)
