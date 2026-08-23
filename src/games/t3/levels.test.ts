import { describe, expect, it } from 'vitest'
import { solve } from '../../core/solver'
import { t3Game } from './engine'

/**
 * 关卡批次守护测试（见 AGENTS.md 关卡规范）：
 * 入库关卡必须通过 zod 校验 + solver 可解，且最短解长度符合设计意图。
 * 改动关卡数据时，若最短解长度变化，必须同步更新此处的期望值并在文档中说明。
 */

const levelFiles = import.meta.glob('./levels/*.json', { eager: true, import: 'default' }) as Record<
  string,
  unknown
>

/** 每关设计意图的最短解长度（由 craft 工具 + solver 双重验证得出） */
const expectedMin: Record<string, number> = {
  't3-01': 4, // 发现回声：垫两拍等它
  't3-02': 4, // 撞边也算数：原地撞边当等待
  't3-03': 4, // 时差：最后两拍未被回声接收
  't3-04': 8, // 绕行：绕路被原样重放
  't3-05': 5, // 同键不同路：精确安排被墙吃掉的拍子
  't3-06': 5, // 一拖二：两枚同延迟回声
  't3-07': 6, // 三层时间：d2 + d4
  't3-08': 8, // 缝隙：墙 + d2 + d4
  't3-09': 6, // 喂招：撞边喂给回声真实移动
  't3-10': 10, // 四层合奏：三回声 d2/d4/d6
}

const entries = Object.entries(levelFiles).sort(([a], [b]) => a.localeCompare(b))

describe('t+3 关卡批次', () => {
  it('教程批次 01–10 齐全', () => {
    expect(entries).toHaveLength(10)
  })

  it.each(entries)('%s 通过 zod + 语义校验', (_file, json) => {
    expect(() => t3Game.parseLevel(json)).not.toThrow()
  })

  it.each(entries)('%s 可解且最短解符合设计意图', (file, json) => {
    const level = t3Game.parseLevel(json)
    const result = solve(t3Game, level, { maxDepth: 40, maxVisits: 500_000 })
    expect(result.solved, `${file} 应可解`).toBe(true)
    expect(result.truncated, `${file} 搜索不应被截断`).toBe(false)
    expect(result.solution, `${file} 最短解长度`).toHaveLength(expectedMin[level.id] ?? Number.NaN)
  })

  it('教程批次每关都带 hint（只点拨不给答案）', () => {
    for (const [, json] of entries) {
      const level = t3Game.parseLevel(json)
      expect(level.hint, `${level.id} 缺 hint`).toBeTruthy()
      expect(level.hint).not.toMatch(/[↑↓←→NESW]{3,}/) // 不允许出现解法序列式的提示
    }
  })
})
