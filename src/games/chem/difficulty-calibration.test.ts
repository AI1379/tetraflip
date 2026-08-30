import { describe, expect, it } from 'vitest'
import {
  calibrateSyntheticFeatures,
  firstAttemptPerPlayerLevel,
  fitRasch,
} from './difficulty-calibration'
import type { HumanAttemptObservation } from './difficulty-calibration'

function row(player: number, level: number, completed: boolean, repeat = 0): HumanAttemptObservation {
  return {
    participantId: `p${player}`,
    levelId: `level-${level}`,
    startedAt: `2026-01-${String(repeat + 1).padStart(2, '0')}T00:00:00Z`,
    completed,
    assisted: false,
    activeMs: 10_000,
    finalMoves: 5,
    par: 5,
    counters: { invalidInputs: 0, undos: 0, solverHints: 0, previews: 0 },
  }
}

describe('human difficulty calibration', () => {
  it('首次尝试去重且 Rasch 能恢复易关 < 难关', () => {
    const attempts: HumanAttemptObservation[] = []
    for (let player = 0; player < 24; player++) {
      for (let level = 0; level < 10; level++) attempts.push(row(player, level, player >= level * 2))
    }
    attempts.push(row(0, 9, true, 1))
    expect(firstAttemptPerPlayerLevel(attempts)).toHaveLength(240)
    const fit = fitRasch(attempts)
    expect(fit.converged).toBe(true)
    expect(fit.status).toBe('calibrated')
    expect(fit.levelEstimates[0].difficulty).toBeLessThan(fit.levelEstimates[9].difficulty)
  })

  it('Ridge 留一关与置换门槛能识别强机器信号', () => {
    const human = Array.from({ length: 16 }, (_, index) => ({
      levelId: `l${index}`,
      difficulty: index / 4 + (index % 2) * 0.01,
      observations: 10,
      participants: 10,
    }))
    const rows = human.map((estimate, index) => ({
      levelId: estimate.levelId,
      features: { signal: index, nuisance: (index * 7) % 5 },
    }))
    const report = calibrateSyntheticFeatures(rows, human, { permutations: 199, seed: 9 })
    expect(report.cvR2).toBeGreaterThan(0.95)
    expect(report.status).toBe('calibrated')
  })
})
