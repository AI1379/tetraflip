import { describe, expect, it } from 'vitest'
import type { GameDefinition } from './protocol'
import { solve, solveFrom } from './solver'
import { History } from './undo'

type Action = '+' | '-'

/** 计数器假游戏：状态是整数，动作 ±1，目标 = level */
const counter: GameDefinition<number, number, Action> = {
  id: 'counter',
  parseLevel: (json) => json as number,
  initialState: () => 0,
  actions: () => ['+', '-'],
  step: (s, a) => (a === '+' ? s + 1 : s - 1),
  isWin: (s) => s === 3,
  stateKey: (s) => String(s),
}

describe('通用 solver', () => {
  it('BFS 找到最短解', () => {
    const r = solve(counter, 3, { maxDepth: 10 })
    expect(r.solved).toBe(true)
    expect(r.solution).toEqual(['+', '+', '+'])
    expect(r.depth).toBe(3)
    expect(r.truncated).toBe(false)
  })

  it('深度不足时报告截断而非「无解」', () => {
    const r = solve(counter, 3, { maxDepth: 2 })
    expect(r.solved).toBe(false)
    expect(r.truncated).toBe(true)
  })
})

describe('solveFrom（从任意局面求解，提示系统的地基）', () => {
  it('中途局面：返回剩余最短解', () => {
    const r = solveFrom(counter, 1, { maxDepth: 10 })
    expect(r.solved).toBe(true)
    expect(r.solution).toEqual(['+', '+'])
    expect(r.depth).toBe(2)
  })

  it('已胜局面：空解', () => {
    const r = solveFrom(counter, 3, { maxDepth: 10 })
    expect(r.solved).toBe(true)
    expect(r.solution).toEqual([])
  })

  it('死局（搜索空间穷尽）：无解且非截断——提示系统据此建议撤销/重开', () => {
    // 状态 1 的动作只会停在原地：目标状态不可达，空间有限可穷尽
    const deadEnd: GameDefinition<number, number, Action> = {
      id: 'dead-end',
      parseLevel: (json) => json as number,
      initialState: () => 1,
      actions: () => ['+'],
      step: (s) => s,
      isWin: (s) => s === 3,
      stateKey: (s) => String(s),
    }
    const r = solveFrom(deadEnd, 1, { maxDepth: 10 })
    expect(r.solved).toBe(false)
    expect(r.truncated).toBe(false)
  })
})

describe('History（撤销栈）', () => {
  it('push / undo / reset', () => {
    const h = new History<number>(0)
    expect(h.depth).toBe(0)
    h.push(1)
    h.push(2)
    expect(h.current).toBe(2)
    expect(h.undo()).toBe(1)
    expect(h.undo()).toBe(0)
    expect(h.undo()).toBeNull()
    h.push(5)
    h.reset(9)
    expect(h.current).toBe(9)
    expect(h.canUndo).toBe(false)
  })
})
