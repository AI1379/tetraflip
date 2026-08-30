import { describe, expect, it } from 'vitest'
import level01 from './levels/level-01.json'
import level07 from './levels/level-07.json'
import level24 from './levels/level-24.json'
import { analyzeChemDifficulty, chemMechanismProfile } from './difficulty'
import { chemGame } from './engine'

describe('chem exact difficulty', () => {
  it('level-01 产生完整的精确图与执行画像', () => {
    const level = chemGame.parseLevel(level01)
    const report = analyzeChemDifficulty(level, { maxDepth: 8, maxStates: 20_000 })
    expect(report.graph.solved).toBe(true)
    expect(report.graph.shortestDistance).toBe(2)
    expect(report.execution.shortestSteps).toBe(2)
    expect(report.execution.interactionSteps).toBe(1)
    expect(report.execution.walkingSteps).toBe(1)
    expect(report.causal.maxFlipsPerAction).toBe(1)
  })

  it('机制画像区分共振与弹射段', () => {
    const resonance = chemMechanismProfile(chemGame.parseLevel(level07))
    const ejection = chemMechanismProfile(chemGame.parseLevel(level24))
    expect(resonance.resonance).toBe(true)
    expect(resonance.eject).toBe(false)
    expect(ejection.eject).toBe(true)
    expect(ejection.carry).toBe(true)
  })
})
