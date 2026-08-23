/**
 * 核心协议：每个游戏实现 GameDefinition。
 * 引擎层必须是纯函数——零 DOM、零副作用，可在 Node 中被 solver / 测试 import。
 */

export type Dir = 'N' | 'E' | 'S' | 'W'

export const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W']

/** [dx, dy]，屏幕坐标系，y 轴向下 */
export const DIR_VEC: Record<Dir, readonly [number, number]> = {
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
}

export const DIR_ARROW: Record<Dir, string> = { N: '↑', E: '→', S: '↓', W: '←' }

export function opposite(d: Dir): Dir {
  switch (d) {
    case 'N':
      return 'S'
    case 'S':
      return 'N'
    case 'E':
      return 'W'
    case 'W':
      return 'E'
  }
}

/** 网格坐标，y 轴向下 */
export type Vec = readonly [number, number]

export const cellKey = (x: number, y: number): string => `${x},${y}`

/**
 * 统一游戏协议。L = 关卡，S = 不可变游戏状态，A = 动作。
 */
export interface GameDefinition<L, S, A> {
  readonly id: string
  /** 解析并校验关卡 JSON；不合法直接抛错（AI 生成的关卡由此入库把关） */
  parseLevel(json: unknown): L
  initialState(level: L): S
  /** 供 solver 枚举的动作；可以包含实际无效果的動作（会被 stateKey 去重） */
  actions(state: S): readonly A[]
  /** 纯函数状态转移；有效转移必须返回新对象，无效果时返回原对象 */
  step(state: S, action: A): S
  isWin(state: S): boolean
  /**
   * 状态唯一键，用于搜索去重与撤销判空。
   * 约定：不得包含步数等「纯计数器」，否则搜索无法剪枝。
   */
  stateKey(state: S): string
}

/** 异构游戏的类型擦除，仅供 shell / scripts 胶合层使用 */
// biome-ignore lint: 胶合层刻意使用 any
export type AnyGame = GameDefinition<any, any, any>
