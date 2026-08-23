import { describe, expect, it } from 'vitest'
import { solve } from '../../core/solver'
import { chemGame } from './engine'

/**
 * chem（《109.5°》）关卡批次基线测试。
 *
 * 入库关卡必须：
 * 1. 通过 zod + 语义校验（parseLevel）；
 * 2. 初始局面未胜利（不允许空关）；
 * 3. solver 可解，且最短解长度等于设计意图基线（防止改图后出现绕开设计意图的捷径，
 *    见 AGENTS.md 关卡规范与 docs/design.md §5 批次决策）。
 */

const levelFiles = import.meta.glob('./levels/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

/** 设计意图基线：文件名 → 最短解步数（2026-08-23 批次，逐关 `pnpm solve` 核对） */
const baseline: Record<string, number> = {
  './levels/level-01.json': 1, // 第一次撞入
  './levels/level-02.json': 5, // 站到背面去
  './levels/level-03.json': 4, // 读开口方向
  './levels/level-04.json': 7, // 墙与绕行
  './levels/level-05.json': 10, // 完整路线规划
  './levels/level-06.json': 13, // 两个中心
  './levels/level-07.json': 13, // 顺序有代价
  './levels/level-08.json': 7, // 克制：别碰已达标中心
  './levels/level-09.json': 19, // 房间与门
  './levels/level-10.json': 20, // 综合毕业
}

const entries = Object.entries(levelFiles).sort(([a], [b]) => a.localeCompare(b))

describe('chem（109.5°）关卡批次 01–10', () => {
  it('关卡数量与基线表一致', () => {
    expect(entries.map(([file]) => file)).toEqual(Object.keys(baseline))
  })

  it.each(entries)('%s 通过关卡校验', (_file, json) => {
    expect(() => chemGame.parseLevel(json)).not.toThrow()
  })

  it.each(entries)('%s 初始局面未胜利（无空关）', (_file, json) => {
    const level = chemGame.parseLevel(json)
    expect(chemGame.isWin(chemGame.initialState(level))).toBe(false)
  })

  it.each(entries)('%s 可解且最短解长度符合设计基线', (file, json) => {
    const level = chemGame.parseLevel(json)
    const result = solve(chemGame, level, { maxDepth: 30 })
    expect(result.solved).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.solution.length, `最短解长度应与 ${file} 的设计意图一致`).toBe(
      baseline[file],
    )
  })
})
