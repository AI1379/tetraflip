import type { GameDefinition } from './protocol'

export interface SolveOptions {
  /** 最大搜索深度（回合数），默认 32 */
  maxDepth?: number
  /** 最大访问状态数，默认 200 000 */
  maxVisits?: number
}

export interface SolveResult<A> {
  solved: boolean
  /** BFS 保证：若 solved，这是动作数最短的解 */
  solution: readonly A[]
  visited: number
  depth: number
  /** true = 因限额提前终止，搜索空间未穷尽，不能断言无解 */
  truncated: boolean
}

/**
 * 通用 BFS solver：对任何实现 GameDefinition 的游戏求最短解。
 * 依赖 game.stateKey 去重（其中不得包含步数等纯计数器）。
 * 无效动作（step 返回原状态）会因 stateKey 相同被自动剪掉。
 */
export function solve<L, S, A>(
  game: GameDefinition<L, S, A>,
  level: L,
  opts: SolveOptions = {},
): SolveResult<A> {
  const maxDepth = opts.maxDepth ?? 32
  const maxVisits = opts.maxVisits ?? 200_000

  const initial = game.initialState(level)
  if (game.isWin(initial)) {
    return { solved: true, solution: [], visited: 1, depth: 0, truncated: false }
  }

  interface Node {
    state: S
    path: A[]
  }
  const visited = new Set<string>([game.stateKey(initial)])
  let frontier: Node[] = [{ state: initial, path: [] }]
  let depth = 0

  while (frontier.length > 0 && depth < maxDepth && visited.size < maxVisits) {
    const next: Node[] = []
    for (const node of frontier) {
      for (const action of game.actions(node.state)) {
        const state = game.step(node.state, action)
        const key = game.stateKey(state)
        if (visited.has(key)) continue
        visited.add(key)
        const path = [...node.path, action]
        if (game.isWin(state)) {
          return { solved: true, solution: path, visited: visited.size, depth: depth + 1, truncated: false }
        }
        next.push({ state, path })
      }
    }
    frontier = next
    depth += 1
  }

  return { solved: false, solution: [], visited: visited.size, depth, truncated: frontier.length > 0 }
}
