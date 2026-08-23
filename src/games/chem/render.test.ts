import { describe, expect, it } from 'vitest'
import { chemGame, initialState } from './engine'
import { render, setChemDecor } from './render'
import level01 from './levels/level-01.json'
import level09 from './levels/level-09.json'

/**
 * 渲染冒烟测试：用 Proxy 桩画布验证 render 可无异常执行。
 * 渲染层只读状态、零状态变更；这里不校验像素，只防运行时错误（重写渲染时的回归护栏）。
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
  it('单中心 / 多中心关卡均可直接渲染，装饰开关两种状态均可用', () => {
    const ctx = stubCtx()
    for (const json of [level01, level09]) {
      const s = initialState(chemGame.parseLevel(json))
      expect(() => render(s, ctx, 480, 480)).not.toThrow()
      setChemDecor(false)
      expect(() => render(s, ctx, 480, 480)).not.toThrow()
      setChemDecor(true)
      expect(() => render(s, ctx, 480, 480)).not.toThrow()
    }
  })
})
