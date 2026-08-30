import type { GameDefinition } from './protocol'

/** 一条动作边。无效动作保留为 effective=false，供执行失误统计使用。 */
export interface StateGraphEdge<A> {
  action: A
  to: number
  effective: boolean
}

export interface StateGraphNode<S, A> {
  key: string
  state: S
  /** 从初始状态到该状态的最短动作数。 */
  depth: number
  edges: StateGraphEdge<A>[]
}

export interface StateGraph<S, A> {
  nodes: StateGraphNode<S, A>[]
  start: number
  goals: number[]
  /** 达到状态数上限，存在尚未展开的节点。 */
  stateTruncated: boolean
  /** 达到深度上限，存在尚未展开的边界节点。 */
  depthTruncated: boolean
  maxDepth: number
}

export interface EnumerateStateGraphOptions {
  /** 只枚举最短深度不超过该值的状态。默认 32。 */
  maxDepth?: number
  /** 防止异常关卡耗尽内存。默认 500 000。 */
  maxStates?: number
}

/**
 * 枚举一个确定性 GameDefinition 的可达状态图。
 *
 * 与只保存路径的 solver 不同，这里保留全部动作边，供最短解数量、分岔、错误恢复与
 * 随机化代理复用。引擎仍是唯一规则来源；分析器不修改状态，也不把展示字段写回关卡。
 */
export function enumerateStateGraph<L, S, A>(
  game: GameDefinition<L, S, A>,
  initial: S,
  options: EnumerateStateGraphOptions = {},
): StateGraph<S, A> {
  const maxDepth = options.maxDepth ?? 32
  const maxStates = options.maxStates ?? 500_000
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error('maxDepth 必须是非负整数')
  if (!Number.isInteger(maxStates) || maxStates < 1) throw new Error('maxStates 必须是正整数')

  const startKey = game.stateKey(initial)
  const nodes: StateGraphNode<S, A>[] = [{ key: startKey, state: initial, depth: 0, edges: [] }]
  const byKey = new Map<string, number>([[startKey, 0]])
  const goals: number[] = game.isWin(initial) ? [0] : []
  let cursor = 0
  let stateTruncated = false
  let depthTruncated = false

  while (cursor < nodes.length) {
    const index = cursor++
    const node = nodes[index]
    for (const action of game.actions(node.state)) {
      const next = game.step(node.state, action)
      const key = game.stateKey(next)
      const effective = key !== node.key
      let to = effective ? byKey.get(key) : index
      if (to === undefined) {
        if (node.depth >= maxDepth) {
          depthTruncated = true
          continue
        }
        if (nodes.length >= maxStates) {
          stateTruncated = true
          continue
        }
        to = nodes.length
        const nextNode: StateGraphNode<S, A> = {
          key,
          state: next,
          depth: node.depth + 1,
          edges: [],
        }
        nodes.push(nextNode)
        byKey.set(key, to)
        if (game.isWin(next)) goals.push(to)
      }
      node.edges.push({ action, to, effective })
    }
  }

  return {
    nodes,
    start: 0,
    goals,
    stateTruncated,
    depthTruncated,
    maxDepth,
  }
}

export interface StateGraphDifficulty {
  solved: boolean
  shortestDistance: number | null
  reachableStates: number
  statesBeforeGoalDepth: number
  statesAtGoalDepth: number
  /** 最短动作序列数的自然对数；避免组合数溢出。 */
  logShortestSolutionCount: number | null
  shortestDagStates: number
  shortestDagDecisionStates: number
  meanOptimalActions: number | null
  minOptimalActions: number | null
  forcedDecisionRate: number | null
  validMistakeEdges: number
  recoverableMistakeEdges: number
  unknownOrDeadMistakeEdges: number
  meanRecoveryCost: number | null
  p90RecoveryCost: number | null
  invalidActionRateOnShortestDag: number | null
  graphComplete: boolean
}

/** 从所有已发现目标反向计算图内最短距离。 */
export function distancesToGoal<S, A>(graph: StateGraph<S, A>): Array<number | undefined> {
  const reverse: number[][] = Array.from({ length: graph.nodes.length }, () => [])
  for (let from = 0; from < graph.nodes.length; from++) {
    for (const edge of graph.nodes[from].edges) {
      if (edge.effective) reverse[edge.to].push(from)
    }
  }
  const distances: Array<number | undefined> = Array(graph.nodes.length).fill(undefined)
  const queue: number[] = []
  for (const goal of graph.goals) {
    if (distances[goal] !== undefined) continue
    distances[goal] = 0
    queue.push(goal)
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const to = queue[cursor]
    const nextDistance = distances[to]! + 1
    for (const from of reverse[to]) {
      if (distances[from] !== undefined) continue
      distances[from] = nextDistance
      queue.push(from)
    }
  }
  return distances
}

const logAddExp = (a: number, b: number): number => {
  if (a === Number.NEGATIVE_INFINITY) return b
  if (b === Number.NEGATIVE_INFINITY) return a
  const high = Math.max(a, b)
  return high + Math.log(Math.exp(a - high) + Math.exp(b - high))
}

const quantile = (values: readonly number[], q: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil(q * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]
}

/**
 * 提取与具体游戏无关的结构难度指标。
 *
 * `unknownOrDeadMistakeEdges` 在完整图上才可解释为真正死局；深度/状态截断时它同时包含
 * “恢复路径超出本次枚举范围”，因此报告必须连同 graphComplete 展示。
 */
export function analyzeStateGraph<S, A>(graph: StateGraph<S, A>): StateGraphDifficulty {
  const distances = distancesToGoal(graph)
  const shortestDistance = distances[graph.start]
  if (shortestDistance === undefined) {
    return {
      solved: false,
      shortestDistance: null,
      reachableStates: graph.nodes.length,
      statesBeforeGoalDepth: graph.nodes.length,
      statesAtGoalDepth: 0,
      logShortestSolutionCount: null,
      shortestDagStates: 0,
      shortestDagDecisionStates: 0,
      meanOptimalActions: null,
      minOptimalActions: null,
      forcedDecisionRate: null,
      validMistakeEdges: 0,
      recoverableMistakeEdges: 0,
      unknownOrDeadMistakeEdges: 0,
      meanRecoveryCost: null,
      p90RecoveryCost: null,
      invalidActionRateOnShortestDag: null,
      graphComplete: !graph.stateTruncated && !graph.depthTruncated,
    }
  }

  const shortestDag = graph.nodes
    .map((node, index) => ({ node, index, remaining: distances[index] }))
    .filter(
      ({ node, remaining }) =>
        remaining !== undefined && node.depth + remaining === shortestDistance,
    )
  const decisions = shortestDag.filter(({ remaining }) => remaining! > 0)

  const logCounts: number[] = Array(graph.nodes.length).fill(Number.NEGATIVE_INFINITY)
  for (const goal of graph.goals) logCounts[goal] = 0
  for (let remaining = 1; remaining <= shortestDistance; remaining++) {
    for (let index = 0; index < graph.nodes.length; index++) {
      if (distances[index] !== remaining) continue
      let count = Number.NEGATIVE_INFINITY
      for (const edge of graph.nodes[index].edges) {
        if (!edge.effective || distances[edge.to] !== remaining - 1) continue
        count = logAddExp(count, logCounts[edge.to])
      }
      logCounts[index] = count
    }
  }

  const optimalCounts: number[] = []
  const recoveryCosts: number[] = []
  let validMistakes = 0
  let recoverableMistakes = 0
  let unknownOrDeadMistakes = 0
  let invalidActions = 0
  let allActions = 0

  for (const { node, index, remaining } of decisions) {
    const optimal = node.edges.filter(
      (edge) => edge.effective && distances[edge.to] === remaining! - 1,
    ).length
    optimalCounts.push(optimal)
    for (const edge of node.edges) {
      allActions++
      if (!edge.effective) {
        invalidActions++
        continue
      }
      if (distances[edge.to] === remaining! - 1) continue
      validMistakes++
      const nextDistance = distances[edge.to]
      if (nextDistance === undefined) {
        unknownOrDeadMistakes++
      } else {
        recoverableMistakes++
        recoveryCosts.push(1 + nextDistance - remaining!)
      }
    }
    void index
  }

  const forced = optimalCounts.filter((count) => count === 1).length
  return {
    solved: true,
    shortestDistance,
    reachableStates: graph.nodes.length,
    statesBeforeGoalDepth: graph.nodes.filter((node) => node.depth < shortestDistance).length,
    statesAtGoalDepth: graph.nodes.filter((node) => node.depth === shortestDistance).length,
    logShortestSolutionCount: logCounts[graph.start],
    shortestDagStates: shortestDag.length,
    shortestDagDecisionStates: decisions.length,
    meanOptimalActions:
      optimalCounts.length === 0
        ? null
        : optimalCounts.reduce((sum, value) => sum + value, 0) / optimalCounts.length,
    minOptimalActions: optimalCounts.length === 0 ? null : Math.min(...optimalCounts),
    forcedDecisionRate: optimalCounts.length === 0 ? null : forced / optimalCounts.length,
    validMistakeEdges: validMistakes,
    recoverableMistakeEdges: recoverableMistakes,
    unknownOrDeadMistakeEdges: unknownOrDeadMistakes,
    meanRecoveryCost:
      recoveryCosts.length === 0
        ? null
        : recoveryCosts.reduce((sum, value) => sum + value, 0) / recoveryCosts.length,
    p90RecoveryCost: quantile(recoveryCosts, 0.9),
    invalidActionRateOnShortestDag: allActions === 0 ? null : invalidActions / allActions,
    graphComplete: !graph.stateTruncated && !graph.depthTruncated,
  }
}
