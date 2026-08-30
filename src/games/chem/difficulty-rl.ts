import { DIRS, type Dir } from '../../core/protocol'
import { SeededRandom } from '../../core/random'
import { wilsonInterval } from '../../core/statistics'
import { chemGame, initialState, step } from './engine'
import type { ChemState } from './engine'
import type { ChemLevel } from './level'

const ACTIONS: readonly Dir[] = DIRS

export interface ChemQTrainingOptions {
  episodes?: number
  seed?: number
  alpha?: number
  gamma?: number
  epsilonStart?: number
  epsilonEnd?: number
  /** 访问稀有 state-action 的 count bonus；默认 0.02。 */
  explorationBonus?: number
  maxMovesPerEpisode?: number
  evaluationEvery?: number
  evaluationTrials?: number
  successThreshold?: number
  /** true 时不探索无效方向；默认 false，保留规则/操作试错成本。 */
  maskInvalidActions?: boolean
}

export interface ChemQLearningCheckpoint {
  episode: number
  successRate: number
  successInterval: { low: number; high: number }
  meanMovesSolved: number | null
}

export interface ChemQTrainingReport {
  levelId: string
  options: Required<ChemQTrainingOptions>
  firstSolveEpisode: number | null
  episodesToThreshold: number | null
  trainingSolveRate: number
  finalSuccessRate: number
  finalSuccessInterval: { low: number; high: number }
  finalMeanMovesSolved: number | null
  learningAuc: number
  uniqueStates: number
  stateActionEntries: number
  checkpoints: ChemQLearningCheckpoint[]
}

type QTable = Map<string, Float64Array>
type CountTable = Map<string, Uint32Array>

function optionsFor(level: ChemLevel, options: ChemQTrainingOptions): Required<ChemQTrainingOptions> {
  const normalized: Required<ChemQTrainingOptions> = {
    episodes: options.episodes ?? 5_000,
    seed: options.seed ?? 0,
    alpha: options.alpha ?? 0.2,
    gamma: options.gamma ?? 0.98,
    epsilonStart: options.epsilonStart ?? 1,
    epsilonEnd: options.epsilonEnd ?? 0.05,
    explorationBonus: options.explorationBonus ?? 0.02,
    maxMovesPerEpisode:
      options.maxMovesPerEpisode ?? level.moveLimit ?? Math.max(20, (level.par ?? 10) * 3),
    evaluationEvery: options.evaluationEvery ?? 100,
    evaluationTrials: options.evaluationTrials ?? 40,
    successThreshold: options.successThreshold ?? 0.8,
    maskInvalidActions: options.maskInvalidActions ?? false,
  }
  for (const [name, value] of Object.entries(normalized)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${name} 必须是有限数`)
  }
  if (!Number.isInteger(normalized.episodes) || normalized.episodes <= 0) {
    throw new Error('episodes 必须是正整数')
  }
  if (normalized.alpha <= 0 || normalized.alpha > 1) throw new Error('alpha 必须在 (0, 1]')
  if (normalized.gamma < 0 || normalized.gamma > 1) throw new Error('gamma 必须在 [0, 1]')
  if (
    normalized.epsilonStart < 0 ||
    normalized.epsilonStart > 1 ||
    normalized.epsilonEnd < 0 ||
    normalized.epsilonEnd > 1
  ) {
    throw new Error('epsilon 必须在 [0, 1]')
  }
  return normalized
}

const valuesFor = (table: QTable, key: string): Float64Array => {
  let values = table.get(key)
  if (!values) {
    values = new Float64Array(ACTIONS.length)
    table.set(key, values)
  }
  return values
}

const countsFor = (table: CountTable, key: string): Uint32Array => {
  let values = table.get(key)
  if (!values) {
    values = new Uint32Array(ACTIONS.length)
    table.set(key, values)
  }
  return values
}

function candidateIndices(state: ChemState, maskInvalid: boolean): number[] {
  if (!maskInvalid) return ACTIONS.map((_, index) => index)
  const key = chemGame.stateKey(state)
  const valid = ACTIONS.flatMap((action, index) =>
    chemGame.stateKey(step(state, action)) === key ? [] : [index],
  )
  return valid.length > 0 ? valid : ACTIONS.map((_, index) => index)
}

function greedyIndex(
  state: ChemState,
  values: Float64Array,
  rng: SeededRandom,
  maskInvalid: boolean,
): number {
  const candidates = candidateIndices(state, maskInvalid)
  const best = Math.max(...candidates.map((index) => values[index]))
  return rng.pick(candidates.filter((index) => Math.abs(values[index] - best) < 1e-12))
}

/**
 * 与 JSON 如何拆 stages 无关的归一化进度势函数。
 *
 * 已完成阶段占整数进度；当前阶段按已满足目标比例补足小数进度，最后再除以总阶段数。
 * 单阶段三目标和三阶段各一目标因此都从 0 平滑走到 1，不会因为作者把目标拆段就白拿奖励。
 */
export function chemProgressPotential(state: ChemState): number {
  const totalStages = Math.max(1, state.stages.length)
  if (state.stage >= state.stages.length) return 1
  const active = state.stages[state.stage]
  const matches = active.goals.filter(
    (goal) => state.centers[goal.center].arms[goal.arm] === goal.color,
  ).length
  return (state.stage + matches / Math.max(1, active.goals.length)) / totalStages
}

function reward(
  before: ChemState,
  after: ChemState,
  visits: number,
  bonus: number,
  gamma: number,
): number {
  const effective = chemGame.stateKey(before) !== chemGame.stateKey(after)
  const stepCost = effective ? -0.01 : -0.03
  // 势函数差分会对达成 / 破坏目标对称计分，并保持最优策略不因 shaping 改变。
  const progressReward = 0.2 * (
    gamma * chemProgressPotential(after) - chemProgressPotential(before)
  )
  const terminal = after.won ? 1 : 0
  return terminal + progressReward + stepCost + bonus / Math.sqrt(Math.max(1, visits))
}

interface EvaluationResult {
  successes: number
  meanMovesSolved: number | null
}

function evaluateGreedy(
  level: ChemLevel,
  q: QTable,
  options: Required<ChemQTrainingOptions>,
  seed: number,
): EvaluationResult {
  let successes = 0
  const solvedMoves: number[] = []
  for (let trial = 0; trial < options.evaluationTrials; trial++) {
    const rng = new SeededRandom(seed + trial * 97_409)
    let state = initialState(level)
    const inputCap = Math.max(16, options.maxMovesPerEpisode * 4)
    for (let input = 0; input < inputCap && !state.won && state.moves < options.maxMovesPerEpisode; input++) {
      const key = chemGame.stateKey(state)
      const index = greedyIndex(
        state,
        q.get(key) ?? new Float64Array(ACTIONS.length),
        rng,
        options.maskInvalidActions,
      )
      state = step(state, ACTIONS[index])
    }
    if (state.won) {
      successes++
      solvedMoves.push(state.moves)
    }
  }
  return {
    successes,
    meanMovesSolved:
      solvedMoves.length === 0
        ? null
        : solvedMoves.reduce((sum, value) => sum + value, 0) / solvedMoves.length,
  }
}

/**
 * 每关独立的 tabular Q-learning 基线。它不读取关卡名、solver 距离或手打路线；训练奖励只包含
 * 通关、不可逆阶段推进、步成本与访问计数探索奖励，因此测的是反复试错的样本效率。
 */
export function trainTabularChemQ(
  level: ChemLevel,
  rawOptions: ChemQTrainingOptions = {},
): ChemQTrainingReport {
  const options = optionsFor(level, rawOptions)
  const rng = new SeededRandom(options.seed)
  const q: QTable = new Map()
  const counts: CountTable = new Map()
  const checkpoints: ChemQLearningCheckpoint[] = []
  let firstSolveEpisode: number | null = null
  let episodesToThreshold: number | null = null
  let trainingSolves = 0

  for (let episode = 1; episode <= options.episodes; episode++) {
    let state = initialState(level)
    const progress = (episode - 1) / Math.max(1, options.episodes - 1)
    const epsilon =
      options.epsilonStart * (1 - progress) + options.epsilonEnd * progress
    const inputCap = Math.max(16, options.maxMovesPerEpisode * 4)

    for (let input = 0; input < inputCap && !state.won && state.moves < options.maxMovesPerEpisode; input++) {
      const key = chemGame.stateKey(state)
      const values = valuesFor(q, key)
      const candidates = candidateIndices(state, options.maskInvalidActions)
      const actionIndex =
        rng.next() < epsilon
          ? rng.pick(candidates)
          : greedyIndex(state, values, rng, options.maskInvalidActions)
      const next = step(state, ACTIONS[actionIndex])
      const countValues = countsFor(counts, key)
      countValues[actionIndex]++
      const nextValues = next.won
        ? new Float64Array(ACTIONS.length)
        : valuesFor(q, chemGame.stateKey(next))
      const target =
        reward(state, next, countValues[actionIndex], options.explorationBonus, options.gamma) +
        (next.won ? 0 : options.gamma * Math.max(...nextValues))
      values[actionIndex] += options.alpha * (target - values[actionIndex])
      state = next
    }

    if (state.won) {
      trainingSolves++
      if (firstSolveEpisode === null) firstSolveEpisode = episode
    }

    if (episode % options.evaluationEvery === 0 || episode === options.episodes) {
      const evaluation = evaluateGreedy(
        level,
        q,
        options,
        options.seed + 1_000_000_007 + episode,
      )
      const successRate = evaluation.successes / options.evaluationTrials
      checkpoints.push({
        episode,
        successRate,
        successInterval: wilsonInterval(evaluation.successes, options.evaluationTrials),
        meanMovesSolved: evaluation.meanMovesSolved,
      })
      if (episodesToThreshold === null && successRate >= options.successThreshold) {
        episodesToThreshold = episode
      }
    }
  }

  const final = checkpoints.at(-1)!
  let learningAuc = 0
  let previousEpisode = 0
  let previousRate = 0
  for (const checkpoint of checkpoints) {
    learningAuc +=
      ((checkpoint.successRate + previousRate) / 2) *
      (checkpoint.episode - previousEpisode)
    previousEpisode = checkpoint.episode
    previousRate = checkpoint.successRate
  }
  learningAuc /= options.episodes

  return {
    levelId: level.id,
    options,
    firstSolveEpisode,
    episodesToThreshold,
    trainingSolveRate: trainingSolves / options.episodes,
    finalSuccessRate: final.successRate,
    finalSuccessInterval: final.successInterval,
    finalMeanMovesSolved: final.meanMovesSolved,
    learningAuc,
    uniqueStates: q.size,
    stateActionEntries: q.size * ACTIONS.length,
    checkpoints,
  }
}

export const chemActionIndex = (action: Dir): number => ACTIONS.indexOf(action)
