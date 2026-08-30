import { describe, expect, it } from 'vitest'
import { balancedIncompleteBlocks } from './balanced-assignment'

describe('balanced incomplete blocks', () => {
  it('固定 seed 可复现并平衡非锚点曝光', () => {
    const options = { participants: 16, blockSize: 4, seed: 17 }
    const first = balancedIncompleteBlocks([1, 2, 3, 4, 5, 6, 7, 8], options)
    const second = balancedIncompleteBlocks([1, 2, 3, 4, 5, 6, 7, 8], options)
    expect(first).toEqual(second)
    const exposure = new Map<number, number>()
    for (const block of first) {
      expect(new Set(block.items).size).toBe(4)
      for (const item of block.items) exposure.set(item, (exposure.get(item) ?? 0) + 1)
    }
    expect(Math.max(...exposure.values()) - Math.min(...exposure.values())).toBeLessThanOrEqual(1)
  })

  it('每个区组都包含冻结锚点', () => {
    const blocks = balancedIncompleteBlocks(['a', 'b', 'c', 'd'], {
      participants: 6, blockSize: 3, anchors: ['a'], seed: 2,
    })
    expect(blocks.every((block) => block.items.includes('a'))).toBe(true)
  })
})
