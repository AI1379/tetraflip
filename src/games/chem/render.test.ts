import { describe, expect, it } from 'vitest'
import { chemGame, initialState, step } from './engine'
import { render, setChemDecor, notifyChemImpact } from './render'
import type { ChemLevel } from './level'
import level01 from './levels/level-01.json'
import level09 from './levels/level-09.json'
import level11 from './levels/level-11.json'
import level15 from './levels/level-15.json'
import level16 from './levels/level-16.json'
import level17 from './levels/level-17.json'
import level20 from './levels/level-20.json'

/**
 * 渲染冒烟测试：用 Proxy 桩画布验证 render 可无异常执行。
 * 渲染层只读状态、零状态变更；这里不校验像素，只防运行时错误（重写渲染时的回归护栏）。
 * v1 覆盖：游离色珠 / 手持色珠 / 翻转动画的状态转移 / 无效进攻反馈 / 已达标锁定圈。
 * v2 覆盖：相邻中心（缩短臂 + 共轭键 + 半程目标圈）/ 连锁翻转的阶梯动画转移。
 */

function stubCtx(): CanvasRenderingContext2D {
  return new Proxy({} as CanvasRenderingContext2D, {
    get() {
      return (..._args: unknown[]) => undefined
    },
    set() {
      return true
    },
  })
}

describe('chem（109.5°）渲染冒烟', () => {
  it('单中心 / 多中心 / v1 搬运关均可直接渲染，装饰开关两种状态均可用', () => {
    const ctx = stubCtx()
    for (const json of [level01, level09, level11, level15]) {
      const s = initialState(chemGame.parseLevel(json))
      expect(() => render(s, ctx, 480, 480)).not.toThrow()
      setChemDecor(false)
      expect(() => render(s, ctx, 480, 480)).not.toThrow()
      setChemDecor(true)
      expect(() => render(s, ctx, 480, 480)).not.toThrow()
    }
  })

  it('状态转移（移动 / 拾取 / 进攻 / 无效进攻反馈）驱动的动画帧不抛错', () => {
    const ctx = stubCtx()
    const level = chemGame.parseLevel(level11)
    let s = initialState(level)
    render(s, ctx, 480, 480)
    // 行走 + 拾取（动画转移）
    s = step(s, 'S')
    s = step(s, 'S')
    expect(s.holding).toBe('red')
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    // 无效进攻反馈（抖动 + 红闪路径）
    notifyChemImpact('N')
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    // 背面进攻：翻转动画转移（(0,4) → (1,4) → (2,4) → (2,3) → 向北撞入）
    s = step(s, 'E')
    s = step(s, 'E')
    s = step(s, 'N')
    const attacked = step(s, 'N')
    expect(attacked.won).toBe(true)
    expect(() => render(attacked, ctx, 480, 480)).not.toThrow()
    // 已胜利状态重复渲染（锁定圈路径）
    expect(() => render(attacked, ctx, 480, 480)).not.toThrow()
  })

  it('v2 共振关（相邻中心 / 共轭键 / 连锁翻转转移）渲染不抛错', () => {
    const ctx = stubCtx()
    for (const json of [level16, level20]) {
      const s = initialState(chemGame.parseLevel(json))
      expect(() => render(s, ctx, 480, 480)).not.toThrow()
      setChemDecor(false)
      expect(() => render(s, ctx, 480, 480)).not.toThrow()
      setChemDecor(true)
    }
    // 连锁翻转转移：level-17 一击翻三个中心（阶梯动画路径，路线 = ↑ ← ← ← ← ↑ →）
    const level = chemGame.parseLevel(level17)
    let s = initialState(level)
    render(s, ctx, 480, 480)
    for (const d of ['N', 'W', 'W', 'W', 'W', 'N'] as const) s = step(s, d)
    const attacked = step(s, 'E')
    expect(attacked.won).toBe(true)
    expect(() => render(attacked, ctx, 480, 480)).not.toThrow()
    // 连锁进行中（动画未结束）再渲染一帧
    expect(() => render(attacked, ctx, 480, 480)).not.toThrow()
  })

  it('v3 机制群（特殊格 / 保护罩 / 三元轮换动画 / 分步目标）渲染不抛错', () => {
    const ctx = stubCtx()
    const level: ChemLevel = {
      id: 'render-v3',
      width: 6,
      height: 5,
      walls: [[5, 0]],
      player: [0, 0],
      centers: [
        {
          pos: [2, 2],
          arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
          leaving: 'E',
          shielded: true,
        },
        { pos: [3, 2], arms: { N: 'red', E: 'green', S: 'yellow' }, leaving: 'S', kind: 'trigonal' },
        {
          pos: [4, 4],
          arms: { N: 'purple', E: 'red', S: 'blue', W: 'green' },
          leaving: 'W',
          ejects: true,
        },
      ],
      groups: [{ pos: [1, 4], color: 'blue' }],
      stages: [
        { goals: [{ center: 0, arm: 'N', color: 'green' }] },
        { goals: [{ center: 1, arm: 'E', color: 'yellow' }] },
      ],
      lights: [[0, 2]],
      disposals: [[5, 4]],
      deprotections: [[0, 4]],
      launchers: [{ pos: [1, 1], dir: 'E' }],
      par: 20,
    }
    let s = initialState(level)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    setChemDecor(false)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    setChemDecor(true)

    // 光照格转移（只转开口、不播翻转动画）
    s = step(s, 'S')
    s = step(s, 'S') // (0,2) 光照格
    expect(s.centers[0].leaving).toBe('S')
    expect(() => render(s, ctx, 480, 480)).not.toThrow()

    // 三元中心轮换动画帧：光照后三元开口 S→N，站位改在南侧 (3,3)
    // 路线：S S（(0,4)，顺路经过回收格旁）E E E（(3,4)，(1,4) 拾取 blue）N（(3,3)）再 N = 进攻
    for (const d of ['S', 'S', 'E', 'E', 'E', 'N'] as const) s = step(s, d)
    const attacked = step(s, 'N')
    expect(attacked.centers[1].leaving).toBe('E') // 轮换了一步（N→E）
    expect(() => render(attacked, ctx, 480, 480)).not.toThrow()
  })
})
