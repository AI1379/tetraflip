import { SeededRandom } from './random'

export interface Interval {
  low: number
  high: number
}

/** Bernoulli 比例的 Wilson 95% 区间；小样本时比正态近似稳健。 */
export function wilsonInterval(successes: number, trials: number, z = 1.959963984540054): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials <= 0) {
    throw new Error('Wilson 区间要求正整数 trials 与非负整数 successes')
  }
  if (successes < 0 || successes > trials) throw new Error('successes 必须位于 [0, trials]')
  const p = successes / trials
  const z2 = z * z
  const denominator = 1 + z2 / trials
  const center = (p + z2 / (2 * trials)) / denominator
  const radius =
    (z / denominator) *
    Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)
  return { low: Math.max(0, center - radius), high: Math.min(1, center + radius) }
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function quantile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null
  if (probability < 0 || probability > 1) throw new Error('quantile probability 必须在 [0, 1]')
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  const fraction = position - lower
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction
}

export function bootstrapMeanInterval(
  values: readonly number[],
  options: { samples?: number; seed?: number } = {},
): Interval | null {
  if (values.length === 0) return null
  const samples = options.samples ?? 2_000
  if (!Number.isInteger(samples) || samples <= 0) throw new Error('bootstrap samples 必须为正整数')
  const rng = new SeededRandom(options.seed ?? 0)
  const draws: number[] = []
  for (let sample = 0; sample < samples; sample++) {
    let total = 0
    for (let index = 0; index < values.length; index++) total += values[rng.int(values.length)]
    draws.push(total / values.length)
  }
  return { low: quantile(draws, 0.025)!, high: quantile(draws, 0.975)! }
}

/**
 * 配对差值的双侧随机符号置换检验。小样本穷举全部符号，大样本用固定 seed Monte Carlo。
 */
export function pairedSignPermutationTest(
  differences: readonly number[],
  options: { samples?: number; seed?: number } = {},
): { observedMean: number; pValue: number; permutations: number } | null {
  if (differences.length === 0) return null
  const observedMean = mean(differences)!
  const observedAbs = Math.abs(observedMean)
  let extreme = 0
  let permutations = 0

  if (differences.length <= 20) {
    permutations = 2 ** differences.length
    for (let mask = 0; mask < permutations; mask++) {
      let total = 0
      for (let index = 0; index < differences.length; index++) {
        total += differences[index] * ((mask & (1 << index)) === 0 ? -1 : 1)
      }
      if (Math.abs(total / differences.length) >= observedAbs - 1e-12) extreme++
    }
    return { observedMean, pValue: extreme / permutations, permutations }
  }

  permutations = options.samples ?? 20_000
  const rng = new SeededRandom(options.seed ?? 0)
  for (let sample = 0; sample < permutations; sample++) {
    let total = 0
    for (const difference of differences) total += difference * (rng.next() < 0.5 ? -1 : 1)
    if (Math.abs(total / differences.length) >= observedAbs - 1e-12) extreme++
  }
  return { observedMean, pValue: (extreme + 1) / (permutations + 1), permutations }
}

