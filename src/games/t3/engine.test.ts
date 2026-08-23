import { describe, expect, it } from 'vitest'
import { solve } from '../../core/solver'
import type { Dir } from '../../core/protocol'
import { initialState, isWin, step, t3Game } from './engine'
import level01 from './levels/level-01.json'

const play = (json: unknown, moves: readonly Dir[]) => {
  let s = t3Game.initialState(t3Game.parseLevel(json))
  for (const m of moves) s = t3Game.step(s, m)
  return s
}

describe('t+3 引擎', () => {
  it('解析 level-01 通过', () => {
    expect(() => t3Game.parseLevel(level01)).not.toThrow()
  })

  it('手动解 → → → ← 达成双目标', () => {
    const s = play(level01, ['E', 'E', 'E', 'W'])
    expect(isWin(s)).toBe(true)
    expect(s.history).toHaveLength(4)
  })

  it('回声在 delay 回合之后才开始执行输入', () => {
    let s = initialState(t3Game.parseLevel(level01))
    s = step(s, 'E')
    s = step(s, 'E')
    expect(s.echoes[0].pos).toEqual([1, 3]) // 前两回合回声不动
    s = step(s, 'E')
    expect(s.echoes[0].pos).toEqual([2, 3]) // 第 3 回合回放第 1 回合的 →
  })

  it('被墙挡住的输入仍消耗一回合（回声队列照常推进）', () => {
    const level = t3Game.parseLevel({
      id: 't3-block',
      width: 3,
      height: 2,
      walls: [[2, 0]],
      player: { start: [1, 0], goal: [0, 0] },
      echoes: [],
    })
    let s = initialState(level)
    s = step(s, 'E') // 撞墙：原地不动，但回合 +1
    expect(s.player.pos).toEqual([1, 0])
    expect(s.history).toHaveLength(1)
  })

  it('胜利后不再响应输入', () => {
    const won = play(level01, ['E', 'E', 'E', 'W'])
    expect(step(won, 'E')).toBe(won)
  })

  it('solver 找到 level-01 最短解（4 步）', () => {
    const result = solve(t3Game, t3Game.parseLevel(level01), { maxDepth: 12 })
    expect(result.solved).toBe(true)
    expect(result.solution).toHaveLength(4)
  })
})
