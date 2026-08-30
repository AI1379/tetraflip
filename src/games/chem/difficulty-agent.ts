import type { Dir } from '../../core/protocol'
import { SeededRandom } from '../../core/random'
import { bootstrapMeanInterval, mean, wilsonInterval } from '../../core/statistics'
import { chemGame, initialState, step } from './engine'
import type { ChemState } from './engine'
import type { ChemLevel } from './level'

interface SearchNode {
  state: ChemState
  firstAction: Dir | null
  depth: number
}

interface ProgressScore {
  won: number
  stage: number
  activeMatches: number
  totalMatches: number
  /** 只在可见进度完全相同时偏好更短的候选路径。 */
  negativeDepth: number
}

export interface BoundedPlan {
  action: Dir | null
  foundSolution: boolean
  visitedStates: number
  reachedDepth: number
}

function progressScore(state: ChemState, depth: number): ProgressScore {
  const active = state.stages[state.stage]
  const activeMatches = active
    ? active.goals.filter((goal) => state.centers[goal.center].arms[goal.arm] === goal.color).length
    : 0
  const totalMatches = state.stages.reduce(
    (sum, stage) =>
      sum +
      stage.goals.filter((goal) => state.centers[goal.center].arms[goal.arm] === goal.color)
        .length,
    0,
  )
  return {
    won: state.won ? 1 : 0,
    stage: state.stage,
    activeMatches,
    totalMatches,
    negativeDepth: -depth,
  }
}

function compareScore(a: ProgressScore, b: ProgressScore): number {
  for (const key of [
    'won',
    'stage',
    'activeMatches',
    'totalMatches',
    'negativeDepth',
  ] as const) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  return 0
}

const effectiveActions = (state: ChemState): Dir[] =>
  chemGame.actions(state).filter((action) => chemGame.stateKey(step(state, action)) !== chemGame.stateKey(state))

/**
 * 冻结的低容量玩家代理：随机化 BFS 找到完整解时跟随解；预算内找不到解时，跟随可见
 * 阶段/目标进度最好的前沿。评价器刻意保持低容量，不编码关卡名、机制专属规则或手打路线。
 */
export function boundedChemPlan(
  initial: ChemState,
  budget: number,
  rng: SeededRandom,
): BoundedPlan {
  if (!Number.isInteger(budget) || budget < 1) throw new Error('planning budget 必须是正整数')
  if (initial.won) return { action: null, foundSolution: true, visitedStates: 1, reachedDepth: 0 }
  const rootActions = effectiveActions(initial)
  if (rootActions.length === 0) {
    return { action: null, foundSolution: false, visitedStates: 1, reachedDepth: 0 }
  }

  const visited = new Set<string>([chemGame.stateKey(initial)])
  const queue: SearchNode[] = [{ state: initial, firstAction: null, depth: 0 }]
  let bestAction: Dir = rng.pick(rootActions)
  let bestScore: ProgressScore | null = null
  let tieCount = 0
  let reachedDepth = 0

  for (let cursor = 0; cursor < queue.length && visited.size < budget; cursor++) {
    const node = queue[cursor]
    for (const action of rng.shuffle(chemGame.actions(node.state))) {
      const next = step(node.state, action)
      const key = chemGame.stateKey(next)
      if (key === chemGame.stateKey(node.state) || visited.has(key)) continue
      visited.add(key)
      const depth = node.depth + 1
      const firstAction = node.firstAction ?? action
      reachedDepth = Math.max(reachedDepth, depth)
      const score = progressScore(next, depth)
      const comparison = bestScore === null ? 1 : compareScore(score, bestScore)
      if (comparison > 0) {
        bestScore = score
        bestAction = firstAction
        tieCount = 1
      } else if (comparison === 0) {
        tieCount++
        if (rng.int(tieCount) === 0) bestAction = firstAction
      }
      if (next.won) {
        return {
          action: firstAction,
          foundSolution: true,
          visitedStates: visited.size,
          reachedDepth,
        }
      }
      queue.push({ state: next, firstAction, depth })
      if (visited.size >= budget) break
    }
  }

  return {
    action: bestAction,
    foundSolution: false,
    visitedStates: visited.size,
    reachedDepth,
  }
}

export interface RandomizedPlayerOptions {
  planningBudget: number
  trials?: number
  seed?: number
  /** 每次输入改为随机方向的概率；同时覆盖策略误判与操作误触。默认 0.03。 */
  actionNoise?: number
  /** 单次尝试最多有效步数；默认预算关用 moveLimit，其余用 max(20, 3*par)。 */
  maxMovesPerAttempt?: number
  /** 一关最多重开次数。默认 2。 */
  maxRestarts?: number
}

export interface RandomizedPlayerTrial {
  trial: number
  seed: number
  solved: boolean
  totalMoves: number
  totalInputs: number
  restarts: number
  invalidInputs: number
  planningCalls: number
  planningFoundSolution: number
  expandedStates: number
}

export interface RandomizedPlayerSummary {
  planningBudget: number
  trials: number
  successRate: number
  successInterval: { low: number; high: number }
  meanMovesSolved: number | null
  meanMovesSolvedInterval: { low: number; high: number } | null
  meanRestarts: number
  invalidInputRate: number
  planningSolutionRate: number
  meanExpandedStatesPerInput: number
}

export interface RandomizedPlayerReport {
  levelId: string
  options: Required<RandomizedPlayerOptions>
  summary: RandomizedPlayerSummary
  trials: RandomizedPlayerTrial[]
}

function normalizedOptions(level: ChemLevel, options: RandomizedPlayerOptions): Required<RandomizedPlayerOptions> {
  const actionNoise = options.actionNoise ?? 0.03
  if (actionNoise < 0 || actionNoise > 1) throw new Error('actionNoise 必须在 [0, 1]')
  return {
    planningBudget: options.planningBudget,
    trials: options.trials ?? 100,
    seed: options.seed ?? 0,
    actionNoise,
    maxMovesPerAttempt:
      options.maxMovesPerAttempt ?? level.moveLimit ?? Math.max(20, (level.par ?? 10) * 3),
    maxRestarts: options.maxRestarts ?? 2,
  }
}

export function simulateRandomizedChemPlayer(
  level: ChemLevel,
  options: RandomizedPlayerOptions,
): RandomizedPlayerReport {
  const normalized = normalizedOptions(level, options)
  if (!Number.isInteger(normalized.trials) || normalized.trials <= 0) {
    throw new Error('trials 必须是正整数')
  }
  if (!Number.isInteger(normalized.maxRestarts) || normalized.maxRestarts < 0) {
    throw new Error('maxRestarts 必须是非负整数')
  }

  const trials: RandomizedPlayerTrial[] = []
  for (let trial = 0; trial < normalized.trials; trial++) {
    const trialSeed = normalized.seed + trial * 1_000_003
    const rng = new SeededRandom(trialSeed)
    let totalMoves = 0
    let totalInputs = 0
    let invalidInputs = 0
    let planningCalls = 0
    let planningFoundSolution = 0
    let expandedStates = 0
    let solved = false
    let restarts = 0

    for (let attempt = 0; attempt <= normalized.maxRestarts && !solved; attempt++) {
      let state = initialState(level)
      const inputCap = Math.max(16, normalized.maxMovesPerAttempt * 4)
      let attemptInputs = 0
      while (
        !state.won &&
        state.moves < normalized.maxMovesPerAttempt &&
        attemptInputs < inputCap
      ) {
        const plan = boundedChemPlan(state, normalized.planningBudget, rng)
        planningCalls++
        expandedStates += plan.visitedStates
        if (plan.foundSolution) planningFoundSolution++
        let action = plan.action
        if (action === null || rng.next() < normalized.actionNoise) {
          action = rng.pick(chemGame.actions(state))
        }
        const beforeKey = chemGame.stateKey(state)
        const next = step(state, action)
        totalInputs++
        attemptInputs++
        if (chemGame.stateKey(next) === beforeKey) {
          invalidInputs++
          if (effectiveActions(state).length === 0) break
          continue
        }
        state = next
        totalMoves++
      }
      solved = state.won
      if (!solved && attempt < normalized.maxRestarts) restarts++
    }

    trials.push({
      trial,
      seed: trialSeed,
      solved,
      totalMoves,
      totalInputs,
      restarts,
      invalidInputs,
      planningCalls,
      planningFoundSolution,
      expandedStates,
    })
  }

  const solved = trials.filter((trial) => trial.solved)
  const successes = solved.length
  const totalInputs = trials.reduce((sum, trial) => sum + trial.totalInputs, 0)
  const planningCalls = trials.reduce((sum, trial) => sum + trial.planningCalls, 0)
  const solvedMoves = solved.map((trial) => trial.totalMoves)
  return {
    levelId: level.id,
    options: normalized,
    summary: {
      planningBudget: normalized.planningBudget,
      trials: normalized.trials,
      successRate: successes / normalized.trials,
      successInterval: wilsonInterval(successes, normalized.trials),
      meanMovesSolved: mean(solvedMoves),
      meanMovesSolvedInterval: bootstrapMeanInterval(solvedMoves, {
        samples: 1_000,
        seed: normalized.seed + 17,
      }),
      meanRestarts: mean(trials.map((trial) => trial.restarts))!,
      invalidInputRate:
        totalInputs === 0
          ? 0
          : trials.reduce((sum, trial) => sum + trial.invalidInputs, 0) / totalInputs,
      planningSolutionRate:
        planningCalls === 0
          ? 0
          : trials.reduce((sum, trial) => sum + trial.planningFoundSolution, 0) /
            planningCalls,
      meanExpandedStatesPerInput:
        totalInputs === 0
          ? 0
          : trials.reduce((sum, trial) => sum + trial.expandedStates, 0) / totalInputs,
    },
    trials,
  }
}

