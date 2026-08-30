import { describe, expect, it } from 'vitest'
import {
  createAttempt,
  finishAttempt,
  observeAttemptStage,
  recordAttemptEvent,
  setAttemptActive,
} from './telemetry'

const info = {
  attemptId: 'a', participantId: 'p', sessionId: 's', game: 'chem',
  level: 7, levelId: 'level-07', par: 6, stageCount: 2,
  sessionAttemptIndex: 1,
  condition: { tutorialEnabled: true, animationMode: 'clear' as const, inputMode: 'keyboard' as const, visualBlindMode: false },
}

describe('attempt telemetry', () => {
  it('区分墙钟时间与页面可见的有效时间', () => {
    const draft = createAttempt(info, 1_000)
    setAttemptActive(draft, false, 1_500)
    setAttemptActive(draft, true, 4_000)
    const row = finishAttempt(draft, 'level_exit', { moves: 2, stage: 1 }, 4_250)!
    expect(row.durationMs).toBe(3_250)
    expect(row.activeMs).toBe(750)
    expect(row.completed).toBe(false)
  })

  it('保留辅助、失误、工具使用与最高阶段，且只可结束一次', () => {
    const draft = createAttempt(info, 0)
    recordAttemptEvent(draft, 'valid_move')
    recordAttemptEvent(draft, 'invalid_input')
    recordAttemptEvent(draft, 'undo')
    recordAttemptEvent(draft, 'solver_hint')
    recordAttemptEvent(draft, 'preview')
    recordAttemptEvent(draft, 'inspect')
    recordAttemptEvent(draft, 'mark')
    recordAttemptEvent(draft, 'rules_open')
    recordAttemptEvent(draft, 'budget_exhausted')
    observeAttemptStage(draft, 2)
    const row = finishAttempt(draft, 'completed', { moves: 5, stage: 3 }, 500)!
    expect(row.assisted).toBe(true)
    expect(row.maxStage).toBe(3)
    expect(row.counters).toEqual({
      validMoves: 1, invalidInputs: 1, undos: 1, solverHints: 1,
      previews: 1, inspects: 1, marks: 1, rulesOpened: 1, budgetExhausted: true,
    })
    expect(finishAttempt(draft, 'restart', { moves: 0 }, 600)).toBeNull()
  })
})
