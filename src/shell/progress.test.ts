import { describe, expect, it } from 'vitest'
import {
  PROGRESS_STORAGE_KEY,
  addCompleted,
  emptyProgress,
  loadProgress,
  saveProgress,
  setCurrentLevel,
} from './progress'

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

describe('progress localStorage 读写', () => {
  it('空存储返回空进度', () => {
    const storage = new MemoryStorage()
    expect(loadProgress(storage)).toEqual(emptyProgress())
  })

  it('save 后能 load 回同样的数据', () => {
    const storage = new MemoryStorage()
    const data = addCompleted(setCurrentLevel(emptyProgress(), 'chem', 6), 'chem:109.5°-07')
    saveProgress(storage, data)
    expect(loadProgress(storage)).toEqual(data)
    expect(storage.getItem(PROGRESS_STORAGE_KEY)).toBe(JSON.stringify(data))
  })

  it('损坏 JSON / 非法字段时安全回退为空进度', () => {
    const storage = new MemoryStorage()
    storage.setItem(PROGRESS_STORAGE_KEY, '{broken json')
    expect(loadProgress(storage)).toEqual(emptyProgress())

    storage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify({
      completed: [42, 'chem:ok', null],
      current: { chem: -1, demo: 1.5, ok: 2 },
    }))
    expect(loadProgress(storage)).toEqual({ completed: ['chem:ok'], current: { ok: 2 } })
  })
})

describe('progress 数据操作', () => {
  it('addCompleted 去重且不修改原对象', () => {
    const base = emptyProgress()
    const once = addCompleted(base, 'chem:109.5°-01')
    const twice = addCompleted(once, 'chem:109.5°-01')
    expect(twice.completed).toEqual(['chem:109.5°-01'])
    expect(base.completed).toEqual([])
  })

  it('setCurrentLevel 按游戏独立保存并覆盖旧值', () => {
    const base = setCurrentLevel(emptyProgress(), 'chem', 2)
    const next = setCurrentLevel(base, 'demo', 4)
    expect(next.current).toEqual({ chem: 2, demo: 4 })
    const over = setCurrentLevel(next, 'chem', 8)
    expect(over.current).toEqual({ chem: 8, demo: 4 })
  })
})
