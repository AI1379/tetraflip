import { describe, expect, it } from 'vitest'
import { SingleSlotInputBuffer } from './input-buffer'

describe('1× 单步输入缓冲', () => {
  it('保留一次快速重复输入，并在取出后清空', () => {
    const buffer = new SingleSlotInputBuffer<'E' | 'W'>()
    buffer.queue('E')
    buffer.queue('E')
    expect(buffer.take()).toBe('E')
    expect(buffer.take()).toBeUndefined()
  })

  it('多方向连按只保留最新意图，撤销类操作可以显式清空', () => {
    const buffer = new SingleSlotInputBuffer<'E' | 'W'>()
    buffer.queue('E')
    buffer.queue('W')
    expect(buffer.pending).toBe('W')
    buffer.clear()
    expect(buffer.pending).toBeUndefined()
  })
})
