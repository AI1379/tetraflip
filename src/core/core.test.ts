import { describe, expect, it } from 'vitest'
import type { GameDefinition } from './protocol'
import { solve } from './solver'
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
