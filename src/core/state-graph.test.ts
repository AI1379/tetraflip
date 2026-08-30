import { describe, expect, it } from 'vitest'
import type { GameDefinition } from './protocol'
import { analyzeStateGraph, distancesToGoal, enumerateStateGraph } from './state-graph'

type TinyState = 0 | 1 | 2 | 3 | 4
type TinyAction = 'a' | 'b' | 'x'

const tiny: GameDefinition<null, TinyState, TinyAction> = {
  id: 'tiny',
  parseLevel: () => null,
  initialState: () => 0,
  actions: () => ['a', 'b', 'x'],
  step: (state, action) => {
    if (action === 'x' || state === 4) return state
    if (state === 0) return action === 'a' ? 1 : 2
    if (state === 1 || state === 2) return action === 'a' ? 3 : 0
    if (state === 3) return action === 'a' ? 4 : 0
    return state
  },
  isWin: (state) => state === 4,
  stateKey: String,
}

describe('state graph difficulty', () => {
  it('枚举有效/无效边并反向计算目标距离', () => {
    const graph = enumerateStateGraph(tiny, 0, { maxDepth: 8 })
    expect(graph.nodes).toHaveLength(5)
    expect(graph.goals).toHaveLength(1)
    expect(graph.nodes[0].edges.filter((edge) => !edge.effective)).toHaveLength(1)
    expect(distancesToGoal(graph)).toEqual([3, 2, 2, 1, 0])
  })

  it('统计两条最短解、强制决策与错误恢复代价', () => {
    const report = analyzeStateGraph(enumerateStateGraph(tiny, 0, { maxDepth: 8 }))
    expect(report.solved).toBe(true)
    expect(report.shortestDistance).toBe(3)
    expect(Math.exp(report.logShortestSolutionCount!)).toBeCloseTo(2)
    expect(report.meanOptimalActions).toBeGreaterThan(1)
    expect(report.forcedDecisionRate).toBeLessThan(1)
    expect(report.validMistakeEdges).toBeGreaterThan(0)
    expect(report.recoverableMistakeEdges).toBe(report.validMistakeEdges)
    expect(report.graphComplete).toBe(true)
  })

  it('深度截断时明确标记图不完整', () => {
    const report = analyzeStateGraph(enumerateStateGraph(tiny, 0, { maxDepth: 2 }))
    expect(report.solved).toBe(false)
    expect(report.graphComplete).toBe(false)
  })
})
