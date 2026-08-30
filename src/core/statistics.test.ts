import { describe, expect, it } from 'vitest'
import { SeededRandom } from './random'
import {
  bootstrapMeanInterval,
  pairedSignPermutationTest,
  quantile,
  wilsonInterval,
} from './statistics'

describe('difficulty statistics', () => {
  it('随机数与 shuffle 可由 seed 复现', () => {
    const a = new SeededRandom(42)
    const b = new SeededRandom(42)
    expect(Array.from({ length: 8 }, () => a.next())).toEqual(
      Array.from({ length: 8 }, () => b.next()),
    )
    expect(new SeededRandom(7).shuffle([1, 2, 3, 4])).toEqual(
      new SeededRandom(7).shuffle([1, 2, 3, 4]),
    )
  })

  it('Wilson 与 bootstrap 区间覆盖点估计', () => {
    const wilson = wilsonInterval(7, 10)
    expect(wilson.low).toBeLessThan(0.7)
    expect(wilson.high).toBeGreaterThan(0.7)
    const bootstrap = bootstrapMeanInterval([1, 2, 3, 4], { samples: 500, seed: 1 })!
    expect(bootstrap.low).toBeLessThanOrEqual(2.5)
    expect(bootstrap.high).toBeGreaterThanOrEqual(2.5)
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
  })

  it('配对置换检验能识别稳定同向差值', () => {
    const result = pairedSignPermutationTest([1, 1, 1, 1, 1, 1, 1, 1])!
    expect(result.observedMean).toBe(1)
    expect(result.pValue).toBeLessThan(0.02)
  })
})
