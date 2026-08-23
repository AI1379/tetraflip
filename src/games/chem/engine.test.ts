import { describe, expect, it } from 'vitest'
import { solve } from '../../core/solver'
import { initialState, step, chemGame } from './engine'
import level01 from './levels/level-01.json'

describe('chem（Inversion）引擎', () => {
  it('解析 level-01 通过', () => {
    expect(() => chemGame.parseLevel(level01)).not.toThrow()
  })

  it('非背面进攻无效果（不消耗回合）', () => {
    // 绕到中心东侧再向西撞：移动方向 W ≠ 开口臂 E → 无效
    let s = initialState(chemGame.parseLevel(level01))
    for (const d of ['N', 'E', 'E', 'S'] as const) s = step(s, d) // (1,2)→(3,2)
    const bumped = step(s, 'W')
    expect(bumped).toBe(s) // 原样返回，未消耗回合
  })

  it('背面进攻触发 180° 翻转且开口臂翻到对侧', () => {
    const s0 = initialState(chemGame.parseLevel(level01))
    const s = step(s0, 'E') // 玩家在 (1,2)，向 E 撞入 = 从开口臂 E 的背面进攻
    const c = s.centers[0]
    expect(c.arms).toEqual({ N: 'green', E: 'yellow', S: 'blue', W: 'red' })
    expect(c.leaving).toBe('W')
    expect(s.player).toEqual([1, 2]) // 攻击者留在原地
    expect(s.moves).toBe(1)
    expect(s.won).toBe(true) // level-01 目标：N 臂为 green
  })

  it('撞墙 / 撞边界无效果（不消耗回合）', () => {
    const s0 = initialState(chemGame.parseLevel(level01))
    const s1 = step(s0, 'N') // (1,1)
    const s2 = step(s1, 'N') // (1,0)
    expect(step(s2, 'N')).toBe(s2) // 撞边界
    expect(step(s2, 'E')).toBe(s2) // (2,0) 是墙
  })

  it('solver 1 步解出 level-01', () => {
    const result = solve(chemGame, chemGame.parseLevel(level01), { maxDepth: 10 })
    expect(result.solved).toBe(true)
    expect(result.solution).toEqual(['E'])
  })
})
