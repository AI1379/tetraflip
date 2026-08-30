import { SeededRandom } from './random'

export interface BalancedAssignment<T> {
  assignmentId: string
  items: T[]
}

/**
 * 固定 seed 的平衡不完全区组：先平衡每题曝光，再最小化已选题对的共同出现次数。
 * anchors 会进入每个区组，适合冻结锚点；返回顺序另外随机化以削弱位置效应。
 */
export function balancedIncompleteBlocks<T>(
  items: readonly T[],
  options: {
    participants: number
    blockSize: number
    anchors?: readonly T[]
    seed?: number
    idPrefix?: string
  },
): BalancedAssignment<T>[] {
  if (new Set(items).size !== items.length || items.length === 0) throw new Error('items 必须非空且唯一')
  if (!Number.isInteger(options.participants) || options.participants <= 0) {
    throw new Error('participants 必须是正整数')
  }
  if (!Number.isInteger(options.blockSize) || options.blockSize <= 0 || options.blockSize > items.length) {
    throw new Error('blockSize 必须在 [1, items.length]')
  }
  const anchors = [...new Set(options.anchors ?? [])]
  if (anchors.some((anchor) => !items.includes(anchor))) throw new Error('anchor 必须属于 items')
  if (anchors.length > options.blockSize) throw new Error('anchor 数不能超过 blockSize')

  const rng = new SeededRandom(options.seed ?? 0)
  const exposure = new Map(items.map((item) => [item, 0]))
  const pairs = new Map<string, number>()
  const itemIndex = new Map(items.map((item, index) => [item, index]))
  const pairKey = (a: T, b: T): string => {
    const ai = itemIndex.get(a)!
    const bi = itemIndex.get(b)!
    return ai < bi ? `${ai}:${bi}` : `${bi}:${ai}`
  }
  const output: BalancedAssignment<T>[] = []

  for (let participant = 0; participant < options.participants; participant++) {
    const selected = [...anchors]
    while (selected.length < options.blockSize) {
      const candidates = items.filter((item) => !selected.includes(item))
      let best = Infinity
      let ties: T[] = []
      for (const candidate of candidates) {
        const pairCost = selected.reduce((sum, item) => sum + (pairs.get(pairKey(candidate, item)) ?? 0), 0)
        const score = exposure.get(candidate)! * 1_000_000 + pairCost
        if (score < best) {
          best = score
          ties = [candidate]
        } else if (score === best) {
          ties.push(candidate)
        }
      }
      selected.push(rng.pick(ties))
    }
    for (const item of selected) exposure.set(item, exposure.get(item)! + 1)
    for (let a = 0; a < selected.length; a++) {
      for (let b = a + 1; b < selected.length; b++) {
        const key = pairKey(selected[a], selected[b])
        pairs.set(key, (pairs.get(key) ?? 0) + 1)
      }
    }
    output.push({
      assignmentId: `${options.idPrefix ?? 'A'}${String(participant + 1).padStart(3, '0')}`,
      items: rng.shuffle(selected),
    })
  }
  return output
}
