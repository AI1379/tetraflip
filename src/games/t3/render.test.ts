import { describe, expect, it } from 'vitest'
import { t3Game, initialState, step } from './engine'
import { render, setT3Preview } from './render'
import level01 from './levels/level-01.json'
import level07 from './levels/level-07.json'
import level10 from './levels/level-10.json'

/**
 * 渲染冒烟测试（design §11 认知外置层）：Proxy 桩画布验证 render 可无异常执行。
 * 覆盖时间线核心 UI 的各阶段：开局（全部「·」）/ 中盘（回声队列已填充）/ 多回声多延迟 /
 * 按住预演（ghost 棋子 + 时间线落点列）/ 撞边输入（不移动但进队列）/ 无回声关卡。
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

describe('t+3 渲染冒烟（时间线 / chip / 预演）', () => {
  it('开局 / 中盘 / 胜利状态均可渲染', () => {
    const ctx = stubCtx()
    let s = initialState(t3Game.parseLevel(level01))
    expect(() => render(s, ctx, 480, 480)).not.toThrow() // 开局：时间线全「·」
    s = step(s, 'E')
    s = step(s, 'E')
    expect(() => render(s, ctx, 480, 480)).not.toThrow() // 中盘：d2 队列部分已知
    s = step(s, 'E')
    s = step(s, 'W')
    expect(s.won).toBe(true)
    expect(() => render(s, ctx, 480, 480)).not.toThrow() // 胜利态
    setT3Preview(null)
  })

  it('多回声多延迟（d2/d4/d6）关卡可渲染', () => {
    const ctx = stubCtx()
    const s = initialState(t3Game.parseLevel(level10))
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    setT3Preview(null)
  })

  it('按住预演：ghost 棋子 + 时间线落点列（含撞边输入）不抛错', () => {
    const ctx = stubCtx()
    const level = t3Game.parseLevel(level07)
    let s = initialState(level)
    s = step(s, 'E')
    s = step(s, 'E') // d2 红回声已有一拍已知
    // 预演一次普通移动
    setT3Preview(step(s, 'S'))
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    // 预演一次撞边输入（玩家不动，但输入仍进队列——ghost 时间线照画）
    const before = s.player.pos
    const blocked = step(s, 'N') // 向上撞界
    expect(blocked.player.pos).toEqual(before)
    setT3Preview(blocked)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    setT3Preview(null)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
  })

  it('无回声关卡（时间线隐藏）不抛错', () => {
    const ctx = stubCtx()
    const level = t3Game.parseLevel({
      id: 't3-render-noecho',
      width: 3,
      height: 2,
      walls: [],
      player: { start: [0, 0], goal: [2, 0] },
      echoes: [],
    })
    const s = initialState(level)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
  })
})
