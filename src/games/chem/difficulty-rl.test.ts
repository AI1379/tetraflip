import { describe, expect, it } from 'vitest'
import level01 from './levels/level-01.json'
import { chemProgressPotential, trainTabularChemQ } from './difficulty-rl'
import { chemGame, initialState } from './engine'

describe('tabular Q difficulty baseline', () => {
  it('固定 seed 完全复现，并能学会最短教程关', () => {
    const level = chemGame.parseLevel(level01)
    const options = {
      episodes: 400,
      evaluationEvery: 50,
      evaluationTrials: 30,
      seed: 23,
      maxMovesPerEpisode: 8,
    }
    const first = trainTabularChemQ(level, options)
    const second = trainTabularChemQ(level, options)
    expect(first).toEqual(second)
    expect(first.firstSolveEpisode).not.toBeNull()
    expect(first.finalSuccessRate).toBeGreaterThanOrEqual(0.8)
    expect(first.checkpoints).toHaveLength(8)
  })

  it('进度势函数按总目标进度归一化，不因同一批目标拆成多阶段而白拿奖励', () => {
    const base = chemGame.parseLevel(level01)
    const single = initialState({
      ...base,
      stages: [{ goals: [
        { center: 0, arm: 'N', color: 'blue' },
        { center: 0, arm: 'E', color: 'green' },
      ] }],
    })
    const staged = initialState({
      ...base,
      stages: [
        { goals: [{ center: 0, arm: 'N', color: 'blue' }] },
        { goals: [{ center: 0, arm: 'E', color: 'green' }] },
      ],
    })
    expect(chemProgressPotential(single)).toBeCloseTo(0.5)
    expect(chemProgressPotential(staged)).toBeCloseTo(0.5)
  })
})
