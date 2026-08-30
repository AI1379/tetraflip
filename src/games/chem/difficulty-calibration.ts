import { SeededRandom } from '../../core/random'
import { pairedSignPermutationTest, quantile, wilsonInterval } from '../../core/statistics'

export interface HumanAttemptObservation {
  participantId: string
  levelId: string
  startedAt: string
  completed: boolean
  assisted: boolean
  activeMs: number
  finalMoves: number
  par?: number
  condition?: {
    tutorialEnabled: boolean
    animationMode: 'clear' | 'fast'
    inputMode: 'keyboard' | 'touch'
    visualBlindMode: boolean
    cohort?: string
    assignment?: string
  }
  counters: {
    invalidInputs: number
    undos: number
    solverHints: number
    previews: number
  }
}

export interface HumanLevelSummary {
  levelId: string
  attempts: number
  participants: number
  completions: number
  completionRate: number
  completionInterval: { low: number; high: number }
  unassistedCompletions: number
  unassistedRate: number
  medianActiveSeconds: number
  medianMovesOverPar: number | null
  hintRate: number
  meanInvalidInputRate: number
  meanUndos: number
  meanPreviews: number
}

export interface RaschLevelEstimate {
  levelId: string
  difficulty: number
  observations: number
  participants: number
  interval?: { low: number; high: number }
}

export interface RaschReport {
  status: 'calibrated' | 'insufficient'
  reasons: string[]
  observations: number
  participants: number
  levels: number
  iterations: number
  converged: boolean
  logLoss: number | null
  levelEstimates: RaschLevelEstimate[]
  playerAbilities: Record<string, number>
}

export interface RaschOptions {
  outcome?: 'completion' | 'unassisted_completion'
  regularization?: number
  learningRate?: number
  maxIterations?: number
  tolerance?: number
}

/** 主分析只使用每个玩家在每关的首次尝试，避免无限重试把熟练效应混进关卡难度。 */
export function firstAttemptPerPlayerLevel<T extends HumanAttemptObservation>(attempts: readonly T[]): T[] {
  const first = new Map<string, T>()
  for (const attempt of attempts) {
    const key = `${attempt.participantId}\u0000${attempt.levelId}`
    const previous = first.get(key)
    if (!previous || attempt.startedAt < previous.startedAt) first.set(key, attempt)
  }
  return [...first.values()]
}

export function summarizeHumanLevels(attempts: readonly HumanAttemptObservation[]): HumanLevelSummary[] {
  const groups = new Map<string, HumanAttemptObservation[]>()
  for (const attempt of attempts) {
    const group = groups.get(attempt.levelId) ?? []
    group.push(attempt)
    groups.set(attempt.levelId, group)
  }
  return [...groups.entries()].map(([levelId, rows]) => {
    const completions = rows.filter((row) => row.completed).length
    const unassisted = rows.filter((row) => row.completed && !row.assisted).length
    const moveDeltas = rows.flatMap((row) =>
      row.completed && row.par !== undefined ? [row.finalMoves - row.par] : [],
    )
    return {
      levelId,
      attempts: rows.length,
      participants: new Set(rows.map((row) => row.participantId)).size,
      completions,
      completionRate: completions / rows.length,
      completionInterval: wilsonInterval(completions, rows.length),
      unassistedCompletions: unassisted,
      unassistedRate: unassisted / rows.length,
      medianActiveSeconds: quantile(rows.map((row) => row.activeMs / 1_000), 0.5)!,
      medianMovesOverPar: quantile(moveDeltas, 0.5),
      hintRate: rows.filter((row) => row.counters.solverHints > 0).length / rows.length,
      meanInvalidInputRate:
        rows.reduce((sum, row) => {
          const inputs = row.finalMoves + row.counters.invalidInputs
          return sum + (inputs === 0 ? 0 : row.counters.invalidInputs / inputs)
        }, 0) / rows.length,
      meanUndos: rows.reduce((sum, row) => sum + row.counters.undos, 0) / rows.length,
      meanPreviews: rows.reduce((sum, row) => sum + row.counters.previews, 0) / rows.length,
    }
  }).sort((a, b) => a.levelId.localeCompare(b.levelId))
}

const sigmoid = (value: number): number => {
  if (value >= 0) return 1 / (1 + Math.exp(-value))
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

function calibrationReasons(attempts: readonly HumanAttemptObservation[]): string[] {
  const participants = new Map<string, Set<string>>()
  const levelCounts = new Map<string, number>()
  for (const row of attempts) {
    const levels = participants.get(row.participantId) ?? new Set<string>()
    levels.add(row.levelId)
    participants.set(row.participantId, levels)
    levelCounts.set(row.levelId, (levelCounts.get(row.levelId) ?? 0) + 1)
  }
  const reasons: string[] = []
  if (attempts.length < 100) reasons.push('完整首次尝试少于 100 条')
  if (participants.size < 20) reasons.push('独立玩家少于 20 人')
  if (levelCounts.size < 10) reasons.push('有数据的关卡少于 10 关')
  if ([...participants.values()].filter((levels) => levels.size >= 5).length < 10) {
    reasons.push('至少玩过 5 关的玩家少于 10 人，玩家能力与关卡难度难以分离')
  }
  if ([...levelCounts.values()].some((count) => count < 8)) reasons.push('至少一关少于 8 个首次尝试')
  return reasons
}

export function fitRasch(
  rawAttempts: readonly HumanAttemptObservation[],
  options: RaschOptions = {},
): RaschReport {
  const attempts = firstAttemptPerPlayerLevel(rawAttempts)
  const outcome = options.outcome ?? 'unassisted_completion'
  const regularization = options.regularization ?? 0.75
  const learningRate = options.learningRate ?? 0.5
  const maxIterations = options.maxIterations ?? 2_000
  const tolerance = options.tolerance ?? 1e-7
  const playerIds = [...new Set(attempts.map((row) => row.participantId))].sort()
  const levelIds = [...new Set(attempts.map((row) => row.levelId))].sort()
  const playerIndex = new Map(playerIds.map((id, index) => [id, index]))
  const levelIndex = new Map(levelIds.map((id, index) => [id, index]))
  const theta = new Float64Array(playerIds.length)
  const difficulty = new Float64Array(levelIds.length)
  const playerN = new Uint32Array(playerIds.length)
  const levelN = new Uint32Array(levelIds.length)
  for (const row of attempts) {
    playerN[playerIndex.get(row.participantId)!]++
    levelN[levelIndex.get(row.levelId)!]++
  }

  let converged = false
  let iterations = 0
  for (iterations = 1; iterations <= maxIterations; iterations++) {
    const playerGradient = new Float64Array(playerIds.length)
    const levelGradient = new Float64Array(levelIds.length)
    for (const row of attempts) {
      const pIndex = playerIndex.get(row.participantId)!
      const lIndex = levelIndex.get(row.levelId)!
      const y = outcome === 'completion'
        ? Number(row.completed)
        : Number(row.completed && !row.assisted)
      const residual = y - sigmoid(theta[pIndex] - difficulty[lIndex])
      playerGradient[pIndex] += residual
      levelGradient[lIndex] -= residual
    }
    let maxDelta = 0
    for (let index = 0; index < theta.length; index++) {
      const delta = learningRate *
        (playerGradient[index] - regularization * theta[index]) /
        (playerN[index] * 0.25 + regularization)
      theta[index] += delta
      maxDelta = Math.max(maxDelta, Math.abs(delta))
    }
    for (let index = 0; index < difficulty.length; index++) {
      const delta = learningRate *
        (levelGradient[index] - regularization * difficulty[index]) /
        (levelN[index] * 0.25 + regularization)
      difficulty[index] += delta
      maxDelta = Math.max(maxDelta, Math.abs(delta))
    }
    if (maxDelta < tolerance) {
      converged = true
      break
    }
  }

  // 正则项已解决可识别性；拟合后再共同平移到“平均关卡难度 = 0”，不改变任何预测概率。
  const center = difficulty.reduce((sum, value) => sum + value, 0) / Math.max(1, difficulty.length)
  for (let index = 0; index < difficulty.length; index++) difficulty[index] -= center
  for (let index = 0; index < theta.length; index++) theta[index] -= center

  let loss = 0
  for (const row of attempts) {
    const y = outcome === 'completion'
      ? Number(row.completed)
      : Number(row.completed && !row.assisted)
    const probability = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(
      theta[playerIndex.get(row.participantId)!] - difficulty[levelIndex.get(row.levelId)!],
    )))
    loss -= y * Math.log(probability) + (1 - y) * Math.log(1 - probability)
  }
  const reasons = calibrationReasons(attempts)
  return {
    status: reasons.length === 0 && converged ? 'calibrated' : 'insufficient',
    reasons: [...reasons, ...(converged ? [] : ['Rasch 优化未收敛'])],
    observations: attempts.length,
    participants: playerIds.length,
    levels: levelIds.length,
    iterations: Math.min(iterations, maxIterations),
    converged,
    logLoss: attempts.length === 0 ? null : loss / attempts.length,
    levelEstimates: levelIds.map((levelId, index) => ({
      levelId,
      difficulty: difficulty[index],
      observations: levelN[index],
      participants: new Set(attempts.filter((row) => row.levelId === levelId).map((row) => row.participantId)).size,
    })),
    playerAbilities: Object.fromEntries(playerIds.map((id, index) => [id, theta[index]])),
  }
}

export function bootstrapRaschByPlayer(
  rawAttempts: readonly HumanAttemptObservation[],
  options: RaschOptions & { samples?: number; seed?: number } = {},
): RaschReport {
  const baseAttempts = firstAttemptPerPlayerLevel(rawAttempts)
  const base = fitRasch(baseAttempts, options)
  if (base.levelEstimates.length === 0) return base
  const samples = options.samples ?? 500
  const rng = new SeededRandom(options.seed ?? 0)
  const players = [...new Set(baseAttempts.map((row) => row.participantId))]
  const byPlayer = new Map(players.map((player) => [
    player,
    baseAttempts.filter((row) => row.participantId === player),
  ]))
  const draws = new Map(base.levelEstimates.map((estimate) => [estimate.levelId, [] as number[]]))
  for (let sample = 0; sample < samples && players.length > 0; sample++) {
    const sampled: HumanAttemptObservation[] = []
    for (let draw = 0; draw < players.length; draw++) {
      const source = rng.pick(players)
      for (const row of byPlayer.get(source)!) {
        sampled.push({ ...row, participantId: `${source}#${draw}` })
      }
    }
    for (const estimate of fitRasch(sampled, options).levelEstimates) {
      draws.get(estimate.levelId)?.push(estimate.difficulty)
    }
  }
  return {
    ...base,
    levelEstimates: base.levelEstimates.map((estimate) => {
      const values = draws.get(estimate.levelId) ?? []
      return values.length < Math.max(20, samples / 2)
        ? estimate
        : { ...estimate, interval: { low: quantile(values, 0.025)!, high: quantile(values, 0.975)! } }
    }),
  }
}

export interface PairedLevelComparison {
  fromLevelId: string
  toLevelId: string
  pairs: number
  completionDifference: number | null
  pValue: number | null
  /** 对本批全部相邻比较做 Benjamini–Hochberg 校正。 */
  qValue: number | null
}

export function pairedAdjacentComparisons(
  attempts: readonly HumanAttemptObservation[],
  orderedLevelIds: readonly string[],
): PairedLevelComparison[] {
  const first = firstAttemptPerPlayerLevel(attempts)
  const byPlayer = new Map<string, Map<string, HumanAttemptObservation>>()
  for (const row of first) {
    const levels = byPlayer.get(row.participantId) ?? new Map()
    levels.set(row.levelId, row)
    byPlayer.set(row.participantId, levels)
  }
  const output: PairedLevelComparison[] = []
  for (let index = 1; index < orderedLevelIds.length; index++) {
    const from = orderedLevelIds[index - 1]
    const to = orderedLevelIds[index]
    const differences: number[] = []
    for (const levels of byPlayer.values()) {
      const before = levels.get(from)
      const after = levels.get(to)
      if (before && after) differences.push(Number(after.completed) - Number(before.completed))
    }
    const test = pairedSignPermutationTest(differences, { seed: index })
    output.push({
      fromLevelId: from,
      toLevelId: to,
      pairs: differences.length,
      completionDifference: test?.observedMean ?? null,
      pValue: test?.pValue ?? null,
      qValue: null,
    })
  }
  const ranked = output
    .map((row, index) => ({ index, p: row.pValue }))
    .filter((row): row is { index: number; p: number } => row.p !== null)
    .sort((a, b) => a.p - b.p)
  let next = 1
  for (let rank = ranked.length - 1; rank >= 0; rank--) {
    const adjusted = Math.min(next, ranked[rank].p * ranked.length / (rank + 1))
    output[ranked[rank].index].qValue = adjusted
    next = adjusted
  }
  return output
}

export interface SyntheticFeatureRow {
  levelId: string
  features: Record<string, number>
}

export interface RidgeCalibrationReport {
  status: 'calibrated' | 'insufficient' | 'no_signal'
  reasons: string[]
  levels: number
  featureNames: string[]
  alpha: number | null
  cvR2: number | null
  cvRmse: number | null
  discoveryLevels: string[]
  confirmationLevels: string[]
  confirmationR2: number | null
  confirmationRmse: number | null
  permutationPValue: number | null
  predictions: Record<string, number>
}

function solveLinear(matrix: number[][], vector: number[]): number[] {
  const n = vector.length
  const augmented = matrix.map((row, index) => [...row, vector[index]])
  for (let column = 0; column < n; column++) {
    let pivot = column
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row
    }
    ;[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]]
    const divisor = augmented[column][column]
    if (Math.abs(divisor) < 1e-12) continue
    for (let cell = column; cell <= n; cell++) augmented[column][cell] /= divisor
    for (let row = 0; row < n; row++) {
      if (row === column) continue
      const factor = augmented[row][column]
      for (let cell = column; cell <= n; cell++) augmented[row][cell] -= factor * augmented[column][cell]
    }
  }
  return augmented.map((row, index) => Number.isFinite(row[n]) ? row[n] : 0 * index)
}

function ridgePredict(trainX: number[][], trainY: number[], testX: number[], alpha: number): number {
  const p = testX.length
  const means = Array.from({ length: p }, (_, column) =>
    trainX.reduce((sum, row) => sum + row[column], 0) / trainX.length,
  )
  const scales = means.map((mean, column) => {
    const variance = trainX.reduce((sum, row) => sum + (row[column] - mean) ** 2, 0) / trainX.length
    return Math.sqrt(variance) || 1
  })
  const x = trainX.map((row) => row.map((value, column) => (value - means[column]) / scales[column]))
  const test = testX.map((value, column) => (value - means[column]) / scales[column])
  const yMean = trainY.reduce((sum, value) => sum + value, 0) / trainY.length
  const centeredY = trainY.map((value) => value - yMean)
  const gram = Array.from({ length: p }, (_, a) =>
    Array.from({ length: p }, (_, b) =>
      x.reduce((sum, row) => sum + row[a] * row[b], 0) + (a === b ? alpha : 0),
    ),
  )
  const rhs = Array.from({ length: p }, (_, column) =>
    x.reduce((sum, row, index) => sum + row[column] * centeredY[index], 0),
  )
  const coefficients = solveLinear(gram, rhs)
  return yMean + coefficients.reduce((sum, value, column) => sum + value * test[column], 0)
}

function loeoScore(x: number[][], y: number[], alphas: readonly number[]): {
  alpha: number
  r2: number
  rmse: number
  predictions: number[]
} {
  const yMean = y.reduce((sum, value) => sum + value, 0) / y.length
  const total = y.reduce((sum, value) => sum + (value - yMean) ** 2, 0)
  let best = { alpha: alphas[0], r2: -Infinity, rmse: Infinity, predictions: [] as number[] }
  for (const alpha of alphas) {
    const predictions = x.map((row, heldOut) => ridgePredict(
      x.filter((_, index) => index !== heldOut),
      y.filter((_, index) => index !== heldOut),
      row,
      alpha,
    ))
    const error = y.reduce((sum, value, index) => sum + (value - predictions[index]) ** 2, 0)
    const r2 = total <= 1e-12 ? -Infinity : 1 - error / total
    const rmse = Math.sqrt(error / y.length)
    if (r2 > best.r2) best = { alpha, r2, rmse, predictions }
  }
  return best
}

export function calibrateSyntheticFeatures(
  rows: readonly SyntheticFeatureRow[],
  human: readonly RaschLevelEstimate[],
  options: {
    permutations?: number
    seed?: number
    alphas?: readonly number[]
    confirmationFraction?: number
  } = {},
): RidgeCalibrationReport {
  const humanMap = new Map(human.map((row) => [row.levelId, row.difficulty]))
  const joined = rows.filter((row) => humanMap.has(row.levelId))
  const featureNames = [...new Set(joined.flatMap((row) => Object.keys(row.features)))].sort()
  const reasons: string[] = []
  if (joined.length < Math.max(12, featureNames.length + 4)) reasons.push('同时具有人类与机器指标的关卡不足')
  if (featureNames.length === 0) reasons.push('没有机器特征')
  if (reasons.length > 0) {
    return { status: 'insufficient', reasons, levels: joined.length, featureNames, alpha: null,
      cvR2: null, cvRmse: null, discoveryLevels: [], confirmationLevels: [],
      confirmationR2: null, confirmationRmse: null, permutationPValue: null, predictions: {} }
  }
  const x = joined.map((row) => featureNames.map((name) => row.features[name] ?? 0))
  const y = joined.map((row) => humanMap.get(row.levelId)!)
  const alphas = options.alphas ?? [0.1, 1, 10, 100]
  const rng = new SeededRandom(options.seed ?? 0)
  const fraction = options.confirmationFraction ?? 0.2
  if (fraction <= 0 || fraction >= 0.5) throw new Error('confirmationFraction 必须在 (0, 0.5)')
  const shuffled = rng.shuffle(x.map((_, index) => index))
  const confirmationCount = Math.max(3, Math.round(joined.length * fraction))
  const confirmationSet = new Set(shuffled.slice(0, confirmationCount))
  const discoveryIndices = shuffled.filter((index) => !confirmationSet.has(index))
  const confirmationIndices = shuffled.filter((index) => confirmationSet.has(index))
  if (discoveryIndices.length < Math.max(8, featureNames.length + 4)) {
    return {
      status: 'insufficient',
      reasons: ['留出 20% 确认关后，发现集不足以拟合机器特征'],
      levels: joined.length,
      featureNames,
      alpha: null,
      cvR2: null,
      cvRmse: null,
      discoveryLevels: discoveryIndices.map((index) => joined[index].levelId),
      confirmationLevels: confirmationIndices.map((index) => joined[index].levelId),
      confirmationR2: null,
      confirmationRmse: null,
      permutationPValue: null,
      predictions: {},
    }
  }
  const discoveryX = discoveryIndices.map((index) => x[index])
  const discoveryY = discoveryIndices.map((index) => y[index])
  const observed = loeoScore(discoveryX, discoveryY, alphas)
  const permutations = options.permutations ?? 1_000
  let extreme = 0
  for (let sample = 0; sample < permutations; sample++) {
    const permuted = rng.shuffle(discoveryY)
    if (loeoScore(discoveryX, permuted, alphas).r2 >= observed.r2 - 1e-12) extreme++
  }
  const pValue = (extreme + 1) / (permutations + 1)
  const confirmationPredictions = confirmationIndices.map((index) => ridgePredict(
    discoveryX,
    discoveryY,
    x[index],
    observed.alpha,
  ))
  const confirmationY = confirmationIndices.map((index) => y[index])
  const confirmationMean = confirmationY.reduce((sum, value) => sum + value, 0) / confirmationY.length
  const confirmationTotal = confirmationY.reduce((sum, value) => sum + (value - confirmationMean) ** 2, 0)
  const confirmationError = confirmationY.reduce(
    (sum, value, index) => sum + (value - confirmationPredictions[index]) ** 2,
    0,
  )
  const confirmationR2 = confirmationTotal <= 1e-12
    ? -Infinity
    : 1 - confirmationError / confirmationTotal
  const confirmationRmse = Math.sqrt(confirmationError / confirmationY.length)
  const signal = observed.r2 > 0 && pValue <= 0.05 && confirmationR2 > 0
  const predictions: Record<string, number> = {}
  discoveryIndices.forEach((index, position) => {
    predictions[joined[index].levelId] = observed.predictions[position]
  })
  confirmationIndices.forEach((index, position) => {
    predictions[joined[index].levelId] = confirmationPredictions[position]
  })
  return {
    status: signal ? 'calibrated' : 'no_signal',
    reasons: signal ? [] : ['发现集 LOEO R² > 0、置换 p ≤ 0.05 与确认集 R² > 0 未同时通过'],
    levels: joined.length,
    featureNames,
    alpha: observed.alpha,
    cvR2: observed.r2,
    cvRmse: observed.rmse,
    discoveryLevels: discoveryIndices.map((index) => joined[index].levelId),
    confirmationLevels: confirmationIndices.map((index) => joined[index].levelId),
    confirmationR2,
    confirmationRmse,
    permutationPValue: pValue,
    predictions,
  }
}
