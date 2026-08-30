/**
 * 把匿名完整尝试拟合为 Rasch 人类难度，并检验机器指标能否留一关预测真人结果。
 * 没有人类数据时仍生成明确标注“未校准”的报告，不回退到伪精确综合分。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  bootstrapRaschByPlayer,
  calibrateSyntheticFeatures,
  fitRasch,
  pairedAdjacentComparisons,
  summarizeHumanLevels,
} from '../src/games/chem/difficulty-calibration'
import type {
  HumanAttemptObservation,
  RidgeCalibrationReport,
  SyntheticFeatureRow,
} from '../src/games/chem/difficulty-calibration'
import type { ChemExactDifficulty } from '../src/games/chem/difficulty'
import type { RandomizedPlayerReport } from '../src/games/chem/difficulty-agent'
import { numberOption, option } from './difficulty-shared'

interface MachineLevel {
  file: string
  ordinal: number
  exact: ChemExactDifficulty
  randomized: RandomizedPlayerReport[]
  counterfactualWithoutMoveLimit: null | {
    exact: ChemExactDifficulty
    randomized: RandomizedPlayerReport[]
  }
}

interface MachineReport {
  config: unknown
  levels: MachineLevel[]
}

interface RlReport {
  config: { episodes: number }
  levels: Array<{
    levelId: string
    aggregate: {
      medianEpisodesToThreshold: number
      thresholdReachedSeeds: number
      meanFinalSuccessRate: number
      meanLearningAuc: number
    }
    counterfactualWithoutMoveLimit: null | {
      aggregate: {
        medianEpisodesToThreshold: number
        thresholdReachedSeeds: number
        meanFinalSuccessRate: number
        meanLearningAuc: number
      }
    }
  }>
}

function readJson<T>(path: string): T | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line, index) => {
    try {
      return [JSON.parse(line) as unknown]
    } catch {
      console.warn(`忽略 ${path} 第 ${index + 1} 行：不是合法 JSON`)
      return []
    }
  })
}

function isAttempt(row: unknown): row is HumanAttemptObservation {
  if (!row || typeof row !== 'object') return false
  const value = row as Record<string, unknown>
  return typeof value.participantId === 'string' &&
    typeof value.levelId === 'string' &&
    typeof value.startedAt === 'string' &&
    typeof value.completed === 'boolean' &&
    typeof value.assisted === 'boolean' &&
    typeof value.activeMs === 'number' &&
    typeof value.finalMoves === 'number' &&
    !!value.counters && typeof value.counters === 'object'
}

interface SubjectiveFeedback {
  levelId: string
  difficulty: number
  fun: number
  attemptId?: string
}

function isSubjectiveFeedback(row: unknown): row is SubjectiveFeedback {
  if (!row || typeof row !== 'object') return false
  const value = row as Record<string, unknown>
  return typeof value.levelId === 'string' &&
    typeof value.difficulty === 'number' && value.difficulty >= 1 && value.difficulty <= 5 &&
    typeof value.fun === 'number' && value.fun >= 1 && value.fun <= 5
}

const finite = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

function machineFeatures(machine: MachineReport, rl: RlReport | null): SyntheticFeatureRow[] {
  const rlByLevel = new Map(rl?.levels.map((row) => [row.levelId, row]) ?? [])
  return machine.levels.map((row) => {
    const exact = row.exact
    const features: Record<string, number> = {
      shortest: finite(exact.graph.shortestDistance),
      logReachable: Math.log1p(finite(exact.graph.reachableStates)),
      logShortestSolutions: finite(exact.graph.logShortestSolutionCount),
      forcedDecisionRate: finite(exact.graph.forcedDecisionRate),
      meanOptimalActions: finite(exact.graph.meanOptimalActions),
      meanRecoveryCost: finite(exact.graph.meanRecoveryCost),
      invalidActionRate: finite(exact.graph.invalidActionRateOnShortestDag),
      interactionSteps: finite(exact.execution.interactionSteps),
      walkingSteps: finite(exact.execution.walkingSteps),
      interactionDensity: finite(exact.execution.interactionDensity),
      maxWalkingRun: finite(exact.execution.maxWalkingRun),
      budgetTight: exact.execution.budgetSlack === 0 ? 1 : 0,
      maxFlips: finite(exact.causal.maxFlipsPerAction),
      propagationDepth: finite(exact.causal.maxPropagationDepth),
      maxWaves: finite(exact.causal.maxWavesPerAction),
      stageAdvanceActions: finite(exact.causal.stageAdvanceActions),
      ejectionActions: finite(exact.causal.ejectionActions),
      mechanismCount: finite(exact.mechanisms.activeCount),
    }
    for (const report of row.randomized) {
      const budget = report.summary.planningBudget
      const counterfactual = row.counterfactualWithoutMoveLimit?.randomized
        .find((candidate) => candidate.summary.planningBudget === budget)
      const reasoningReport = counterfactual ?? report
      features[`B${budget}Failure`] = 1 - finite(reasoningReport.summary.successRate)
      features[`B${budget}Restarts`] = finite(reasoningReport.summary.meanRestarts)
      if (counterfactual) {
        features[`B${budget}BudgetPenalty`] = Math.max(
          0,
          counterfactual.summary.successRate - report.summary.successRate,
        )
      }
    }
    const rlRow = rlByLevel.get(exact.levelId)
    if (rlRow && rl) {
      const reasoningAggregate = rlRow.counterfactualWithoutMoveLimit?.aggregate ?? rlRow.aggregate
      features.rlThresholdFraction = Math.min(
        1.1,
        reasoningAggregate.medianEpisodesToThreshold / rl.config.episodes,
      )
      features.rlFailure = 1 - reasoningAggregate.meanFinalSuccessRate
      features.rlLearningDeficit = 1 - reasoningAggregate.meanLearningAuc
      if (rlRow.counterfactualWithoutMoveLimit) {
        features.rlBudgetThresholdPenalty = Math.max(
          0,
          rlRow.aggregate.medianEpisodesToThreshold - reasoningAggregate.medianEpisodesToThreshold,
        ) / rl.config.episodes
        features.rlBudgetSuccessPenalty = Math.max(
          0,
          reasoningAggregate.meanFinalSuccessRate - rlRow.aggregate.meanFinalSuccessRate,
        )
      }
    }
    return { levelId: exact.levelId, features }
  })
}

function fmt(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits)
}

const average = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
}

const pct = (value: number): string => `${Math.round(value * 100)}%`

const CHAPTERS = [
  { name: '核心搬运', from: 1, to: 6 },
  { name: '共振', from: 7, to: 12 },
  { name: '光照 / 分步', from: 13, to: 17 },
  { name: '空穴', from: 18, to: 23 },
  { name: '弹射', from: 24, to: 29 },
  { name: '阶段护罩', from: 30, to: 36 },
  { name: '结构碰撞', from: 37, to: 43 },
  { name: '主线 mastery', from: 44, to: 50 },
  { name: '赛后扩展', from: 51, to: 56 },
  { name: '全机制组合', from: 57, to: 66 },
  { name: '转辙与红线', from: 67, to: 74 },
] as const

const attemptsPath = resolve(process.cwd(), option('attempts') ?? 'server/data/attempts.jsonl')
const feedbackPath = resolve(process.cwd(), option('feedback') ?? 'server/data/feedback.jsonl')
const machinePath = resolve(process.cwd(), option('machine') ?? 'artifacts/difficulty/machine.json')
const rlPath = resolve(process.cwd(), option('rl') ?? 'artifacts/difficulty/rl.json')
const outputPath = resolve(process.cwd(), option('output') ?? 'artifacts/difficulty/calibration.json')
const markdownPath = resolve(process.cwd(), option('markdown') ?? 'docs/difficulty-report.md')
const bootstrapSamples = numberOption('bootstrap', 500)
const permutationSamples = numberOption('permutations', 1_000)

const machine = readJson<MachineReport>(machinePath)
if (!machine) throw new Error(`缺少机器报告：${machinePath}；先运行 pnpm difficulty:chem`)
const rl = readJson<RlReport>(rlPath)
const curveLevels = machine.levels.filter((row) => row.ordinal <= 74)
const curveLevelIds = new Set(curveLevels.map((row) => row.exact.levelId as string))
const hiddenLevel = machine.levels.find((row) => row.ordinal === 75) ?? null
const allAttempts = readJsonl(attemptsPath).filter(isAttempt)
const feedback = readJsonl(feedbackPath).filter(isSubjectiveFeedback)
// 主曲线定义为正常可见棋盘 + 教程开启；盲测与关闭教程仍保留在原始数据中，另作条件对照。
const attempts = allAttempts.filter((attempt) => {
  if (!curveLevelIds.has(attempt.levelId)) return false
  const condition = attempt.condition
  return condition === undefined || (
    condition.tutorialEnabled &&
    !condition.visualBlindMode &&
    (condition.cohort === undefined || condition.cohort === 'natural')
  )
})
const primary = fitRasch(attempts, { outcome: 'unassisted_completion' })
const human = primary.status === 'calibrated'
  ? bootstrapRaschByPlayer(attempts, {
      outcome: 'unassisted_completion',
      samples: bootstrapSamples,
      seed: 20_260_829,
    })
  : primary
const summaries = summarizeHumanLevels(attempts)
const subjective = [...new Set(feedback.map((row) => row.levelId))].map((levelId) => {
  const rows = feedback.filter((row) => row.levelId === levelId)
  return {
    levelId,
    ratings: rows.length,
    meanDifficulty: average(rows.map((row) => row.difficulty)),
    meanFun: average(rows.map((row) => row.fun)),
  }
})
const featureRows = machineFeatures(machine, rl).filter((row) => curveLevelIds.has(row.levelId))
const rlById = new Map(rl?.levels.map((row) => [row.levelId, row]) ?? [])
const noCalibration: RidgeCalibrationReport = {
  status: 'insufficient',
  reasons: ['Rasch 人类难度尚未达到校准门槛'],
  levels: 0,
  featureNames: [],
  alpha: null,
  cvR2: null,
  cvRmse: null,
  discoveryLevels: [],
  confirmationLevels: [],
  confirmationR2: null,
  confirmationRmse: null,
  permutationPValue: null,
  predictions: {},
}
const ridge = human.status === 'calibrated'
  ? calibrateSyntheticFeatures(featureRows, human.levelEstimates, {
      permutations: permutationSamples,
      seed: 20_260_829,
    })
  : noCalibration
const order = curveLevels.map((row) => row.exact.levelId as string)
const paired = pairedAdjacentComparisons(attempts, order)
const fullCoverage = curveLevelIds.size === 74 && human.levels === curveLevelIds.size
const calibrationStatus = human.status === 'calibrated' && ridge.status === 'calibrated' && fullCoverage
const curve = curveLevels.map((row) => {
  const noLimit = row.counterfactualWithoutMoveLimit
  const actualB128 = row.randomized.find((report) => report.summary.planningBudget === 128)
  const noLimitB128 = noLimit?.randomized.find((report) => report.summary.planningBudget === 128)
  const rlRow = rlById.get(row.exact.levelId)
  const rlReasoning = rlRow?.counterfactualWithoutMoveLimit?.aggregate ?? rlRow?.aggregate
  const validMistakes = row.exact.graph.validMistakeEdges
  return {
    ordinal: row.ordinal,
    levelId: row.exact.levelId,
    reasoning: {
      shortestSteps: row.exact.execution.shortestSteps,
      searchB128Success: noLimitB128?.summary.successRate ?? actualB128?.summary.successRate ?? null,
      rlEpisodesToThreshold: rlReasoning?.medianEpisodesToThreshold ?? null,
      rlFinalSuccess: rlReasoning?.meanFinalSuccessRate ?? null,
    },
    fragility: {
      moveLimit: row.exact.mechanisms.budget,
      budgetSlack: row.exact.execution.budgetSlack,
      searchB128BudgetPenalty: noLimitB128 && actualB128
        ? noLimitB128.summary.successRate - actualB128.summary.successRate
        : null,
      meanRecoveryCost: row.exact.graph.meanRecoveryCost,
      recoverableMistakeRate: validMistakes === 0
        ? null
        : row.exact.graph.recoverableMistakeEdges / validMistakes,
      graphComplete: row.exact.graph.graphComplete,
    },
    causalLoad: row.exact.causal,
    executionTax: row.exact.execution,
    humanDifficulty: human.levelEstimates.find((estimate) => estimate.levelId === row.exact.levelId) ?? null,
  }
})

const hiddenStress = hiddenLevel === null ? null : (() => {
  const actualB128 = hiddenLevel.randomized.find((report) => report.summary.planningBudget === 128)
  const noLimitB128 = hiddenLevel.counterfactualWithoutMoveLimit?.randomized
    .find((report) => report.summary.planningBudget === 128)
  const rlRow = rlById.get(hiddenLevel.exact.levelId)
  return {
    ordinal: hiddenLevel.ordinal,
    levelId: hiddenLevel.exact.levelId,
    excludedFromCurve: true,
    par: hiddenLevel.exact.par,
    moveLimit: hiddenLevel.exact.execution.budgetSlack === 0,
    actualB128Success: actualB128?.summary.successRate ?? null,
    noLimitB128Success: noLimitB128?.summary.successRate ?? null,
    actualRlEpisodesToThreshold: rlRow?.aggregate.medianEpisodesToThreshold ?? null,
    noLimitRlEpisodesToThreshold:
      rlRow?.counterfactualWithoutMoveLimit?.aggregate.medianEpisodesToThreshold ?? null,
    mechanismCount: hiddenLevel.exact.mechanisms.activeCount,
  }
})()

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sources: { attemptsPath, feedbackPath, machinePath, rlPath: rl ? rlPath : null },
  status: calibrationStatus ? 'human-calibrated' : 'machine-controlled-human-uncalibrated',
  excludedExperimentalAttempts: allAttempts.length - attempts.length,
  levelCoverage: { observed: human.levels, required: curveLevelIds.size, complete: fullCoverage },
  human,
  summaries,
  subjective,
  ridge,
  paired,
  curve,
  hiddenStress,
  machineFeatures: featureRows,
}
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const summaryByLevel = new Map(summaries.map((row) => [row.levelId, row]))
const subjectiveByLevel = new Map(subjective.map((row) => [row.levelId, row]))
const estimateByLevel = new Map(human.levelEstimates.map((row) => [row.levelId, row]))
const lines = [
  '# 《109.5°》难度测量报告',
  '',
  `生成时间：${report.generatedAt}`,
  '',
  `校准状态：**${report.status === 'human-calibrated' ? '已通过真人校准' : '机器代理控制中，未通过真人校准'}**。`,
  '',
  `当前共有 ${human.observations} 条玩家×关卡首次尝试、${human.participants} 名匿名玩家、${human.levels} 个有关卡数据。`,
  ...(
    human.reasons.length > 0 || !fullCoverage
      ? ['', `未校准原因：${[...human.reasons, ...(!fullCoverage ? [`真人数据只覆盖 ${human.levels}/${curveLevelIds.size} 个曲线关`] : [])].join('；')}。`]
      : []
  ),
  '',
  '机器侧报告包含精确状态图、多搜索预算随机玩家与多种子 Q-learning。真人完整样本不可得时，它们作为 01–74 的发布代理目标；仍不合成或冒充“真实玩家难度分”。',
  '',
  `机器指标 → 真人 Rasch 难度：${ridge.status}；发现集 LOEO R² ${fmt(ridge.cvR2)}；置换 p ${fmt(ridge.permutationPValue, 3)}；20% 确认关 R² ${fmt(ridge.confirmationR2)}。`,
  '',
  '## 当前机器画像（发布代理，未真人校准）',
  '',
  '下表按机制章节汇总。`search-B` 是每步最多展开 B 个状态的冻结随机玩家成功率；RL 阈值是三个共同种子中位数达到 80% 独立评估成功率所需 episode，`>3000` 表示本轮截尾。章节首关允许教学性回落，因此只审查段内坡度与章节峰值。',
  '',
  '| 章节 | 关卡 | 平均 par | search-B8 | search-B32 | B128 实际 | B128 无红线 | RL 实际 / 无红线阈值 | RL 未达阈值关 |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
]
for (const chapter of CHAPTERS) {
  const rows = machine.levels.filter((row) => row.ordinal >= chapter.from && row.ordinal <= chapter.to)
  const budgetRate = (budget: number): number => average(rows.map((row) =>
    row.randomized.find((report) => report.summary.planningBudget === budget)?.summary.successRate ?? 0,
  ))
  const noLimitB128 = average(rows.map((row) =>
    (
      row.counterfactualWithoutMoveLimit?.randomized ?? row.randomized
    ).find((report) => report.summary.planningBudget === 128)?.summary.successRate ?? 0,
  ))
  const thresholds = rows.map((row) =>
    rlById.get(row.exact.levelId)?.aggregate.medianEpisodesToThreshold ?? 3_100,
  )
  const noLimitThresholds = rows.map((row) => {
    const rlRow = rlById.get(row.exact.levelId)
    return rlRow?.counterfactualWithoutMoveLimit?.aggregate.medianEpisodesToThreshold ??
      rlRow?.aggregate.medianEpisodesToThreshold ?? 3_100
  })
  const missed = rows.filter((row) =>
    (rlById.get(row.exact.levelId)?.aggregate.thresholdReachedSeeds ?? 0) === 0,
  ).length
  const threshold = median(thresholds)
  const noLimitThreshold = median(noLimitThresholds)
  lines.push(`| ${chapter.name} | ${String(chapter.from).padStart(2, '0')}–${String(chapter.to).padStart(2, '0')} | ${fmt(average(rows.map((row) => row.exact.par ?? 0)), 1)} | ${pct(budgetRate(8))} | ${pct(budgetRate(32))} | ${pct(budgetRate(128))} | ${pct(noLimitB128)} | ${threshold > 3_000 ? '>3000' : threshold} / ${noLimitThreshold > 3_000 ? '>3000' : noLimitThreshold} | ${missed} |`)
}

const highSearch = curveLevels.filter((row) =>
  (row.randomized.find((report) => report.summary.planningBudget === 128)?.summary.successRate ?? 0) < 0.8,
)
const rlCensored = curveLevels.filter((row) =>
  (rlById.get(row.exact.levelId)?.aggregate.thresholdReachedSeeds ?? 0) === 0,
)
const misleadingHeuristic = curveLevels.filter((row) => {
  const b8 = row.randomized.find((report) => report.summary.planningBudget === 8)?.summary.successRate ?? 0
  const b32 = row.randomized.find((report) => report.summary.planningBudget === 32)?.summary.successRate ?? 0
  return b8 - b32 >= 0.15
})
const budgetDominated = curveLevels.filter((row) => {
  const actual = row.randomized.find((report) => report.summary.planningBudget === 128)?.summary.successRate ?? 0
  const noLimit = row.counterfactualWithoutMoveLimit?.randomized
    .find((report) => report.summary.planningBudget === 128)?.summary.successRate
  return noLimit !== undefined && noLimit - actual >= 0.2
})
const rlBudgetDominated = curveLevels.filter((row) => {
  const rlRow = rlById.get(row.exact.levelId)
  const noLimit = rlRow?.counterfactualWithoutMoveLimit?.aggregate.medianEpisodesToThreshold
  return noLimit !== undefined && rlRow!.aggregate.medianEpisodesToThreshold - noLimit >= 1_000
})
lines.push(
  '',
  `- 高预算搜索仍低于 80%：${highSearch.map((row) => String(row.ordinal).padStart(2, '0')).join('、') || '无'}。`,
  `- 3000 episode 内三个 RL 种子均未达阈值：${rlCensored.map((row) => String(row.ordinal).padStart(2, '0')).join('、') || '无'}。`,
  `- 中预算比低预算至少差 15 个百分点（局部可见进度会误导）：${misleadingHeuristic.map((row) => String(row.ordinal).padStart(2, '0')).join('、') || '无'}。`,
  `- 移除红线后 B128 成功率至少回升 20 个百分点（难度主要含容错惩罚）：${budgetDominated.map((row) => String(row.ordinal).padStart(2, '0')).join('、') || '无'}。`,
  `- 移除红线后 RL 达标至少提前 1000 episode：${rlBudgetDominated.map((row) => String(row.ordinal).padStart(2, '0')).join('、') || '无'}。`,
  '',
  '### 本轮机器控制结论',
  '',
  `- 01–50 当前高预算搜索尖峰：${highSearch.filter((row) => row.ordinal <= 50).map((row) => `${String(row.ordinal).padStart(2, '0')}《${row.exact.name ?? row.exact.levelId}》`).join('、') || '无'}；RL 截尾尖峰：${rlCensored.filter((row) => row.ordinal <= 50).map((row) => `${String(row.ordinal).padStart(2, '0')}《${row.exact.name ?? row.exact.levelId}》`).join('、') || '无'}。单一代理异常只保留观察，两类以上同向才进入下一轮改图。`,
  '- 本轮已按 design §7.2 完成章节内重排，并对旧 38 / 41 的一致尖峰降噪；报告中的序号均为迁移后的新序号。',
  '- 57–74 同时报告实际红线与无红线反事实。红线造成的差值只进入 fragility；章节的 reasoning 只读无红线列。',
  '',
  '### 逐关机器轴',
  '',
  '| 关卡 | par | 已枚举状态（截断用 +） | B8 | B32 | B128 | B128 无红线 | RL 实际 / 无红线 | 达阈值种子 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
)
for (const row of curveLevels) {
  const rates = [8, 32, 128].map((budget) =>
    row.randomized.find((report) => report.summary.planningBudget === budget)?.summary.successRate ?? 0,
  )
  const rlRow = rlById.get(row.exact.levelId)
  const threshold = rlRow?.aggregate.medianEpisodesToThreshold ?? 3_100
  const noLimitRate = row.counterfactualWithoutMoveLimit?.randomized
    .find((report) => report.summary.planningBudget === 128)?.summary.successRate
  const noLimitThreshold = rlRow?.counterfactualWithoutMoveLimit?.aggregate.medianEpisodesToThreshold
  lines.push(`| ${String(row.ordinal).padStart(2, '0')} | ${row.exact.par ?? '—'} | ${row.exact.graph.reachableStates}${row.exact.graph.graphComplete ? '' : '+'} | ${rates.map(pct).join(' | ')} | ${noLimitRate === undefined ? '—' : pct(noLimitRate)} | ${threshold > 3_000 ? '>3000' : threshold} / ${noLimitThreshold === undefined ? '—' : noLimitThreshold > 3_000 ? '>3000' : noLimitThreshold} | ${rlRow?.aggregate.thresholdReachedSeeds ?? 0}/3 |`)
}
if (hiddenStress) {
  const hiddenActual = hiddenStress.actualRlEpisodesToThreshold ?? 3_100
  const hiddenNoLimit = hiddenStress.noLimitRlEpisodesToThreshold ?? 3_100
  lines.push(
    '',
    '### LV.999 独立压力签名（不参与曲线）',
    '',
    `物理 75 / \`${hiddenStress.levelId}\` 是隐藏彩蛋，明确排除于章节均值、相邻倒挂和排序建议。par=${hiddenStress.par ?? '—'}；B128 实际 / 无红线=${pct(hiddenStress.actualB128Success ?? 0)} / ${pct(hiddenStress.noLimitB128Success ?? 0)}；RL 实际 / 无红线=${hiddenActual > 3_000 ? '>3000' : hiddenActual} / ${hiddenNoLimit > 3_000 ? '>3000' : hiddenNoLimit}；机制轴=${hiddenStress.mechanismCount}。`,
  )
}
lines.push('', '## 真人观测', '')
if (summaries.length === 0) {
  lines.push('_尚无完整真人尝试。机器画像不能替代这一栏。_')
} else {
  lines.push(
    '| 关卡 | 首次尝试 | 无辅助通关率 | 有效时间中位数（秒） | Rasch 难度（95% 玩家 bootstrap） | 主观难度 / 趣味 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const row of curveLevels) {
    const levelId = row.exact.levelId as string
    const summary = summaryByLevel.get(levelId)
    const subjectiveRow = subjectiveByLevel.get(levelId)
    const estimate = estimateByLevel.get(levelId)
    const interval = estimate?.interval
    lines.push(`| ${String(row.ordinal).padStart(2, '0')} ${levelId} | ${summary?.attempts ?? 0} | ${summary ? `${Math.round(summary.unassistedRate * 100)}%` : '—'} | ${fmt(summary?.medianActiveSeconds, 1)} | ${estimate ? `${fmt(estimate.difficulty)}${interval ? ` [${fmt(interval.low)}, ${fmt(interval.high)}]` : ''}` : '—'} | ${subjectiveRow ? `${fmt(subjectiveRow.meanDifficulty)} / ${fmt(subjectiveRow.meanFun)} (n=${subjectiveRow.ratings})` : '—'} |`)
  }
}
lines.push(
  '',
  '## 解释边界',
  '',
  '- 主难度模型使用每名玩家每关的第一次尝试；重试保留在原始数据中，用于另行研究学习速度。',
  '- 通关、重开、换关和离开页面都会形成记录；页面不可见时间不计入有效解题时间。',
  '- 当前版本以机器代理控制 01–74 的曲线；章节开头允许教学性回落，单一代理异常不自动触发改图。',
  '- 真人样本以后若达到门槛，仍须通过 LOEO R² 与置换检验才能覆盖当前代理排序；LV.999 永久不参与曲线校准。',
  '',
)
writeFileSync(markdownPath, `${lines.join('\n')}\n`, 'utf8')
console.log(`校准状态：${report.status}；Rasch=${human.status}；Ridge=${ridge.status}`)
console.log(`已写入 ${outputPath}`)
console.log(`已写入 ${markdownPath}`)
