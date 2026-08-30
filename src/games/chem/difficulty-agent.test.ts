import { describe, expect, it } from 'vitest'
import { SeededRandom } from '../../core/random'
import level01 from './levels/level-01.json'
import level03 from './levels/level-03.json'
import { boundedChemPlan, simulateRandomizedChemPlayer } from './difficulty-agent'
import { chemGame, initialState } from './engine'

describe('randomized bounded chem player', () => {
  it('同一 seed 的有限预算规划完全复现', () => {
    const state = initialState(chemGame.parseLevel(level03))
    expect(boundedChemPlan(state, 32, new SeededRandom(7))).toEqual(
      boundedChemPlan(state, 32, new SeededRandom(7)),
    )
  })

  it('高预算无噪声稳定解出 level-01，并输出区间与逐 trial 记录', () => {
    const level = chemGame.parseLevel(level01)
    const report = simulateRandomizedChemPlayer(level, {
      planningBudget: 64,
      trials: 20,
      seed: 11,
      actionNoise: 0,
      maxRestarts: 0,
    })
    expect(report.summary.successRate).toBe(1)
    expect(report.summary.successInterval.low).toBeGreaterThan(0.8)
    expect(report.summary.meanMovesSolved).toBe(2)
    expect(report.trials).toHaveLength(20)
  })
})
