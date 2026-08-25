import { describe, expect, it } from 'vitest'
import { chemGame, initialState, step } from './engine'
import {
  render,
  setChemDecor,
  notifyChemImpact,
  setChemPreview,
  setChemInspect,
  setChemMarks,
  chemHitTest,
} from './render'
import type { ChemMark } from './render'
import type { ChemLevel } from './level'
import level01 from './levels/level-01.json'
import level03 from './levels/level-03.json'
import level05 from './levels/level-05.json'
import level09 from './levels/level-09.json'
import level11 from './levels/level-11.json'
import level15 from './levels/level-15.json'
import level16 from './levels/level-16.json'
import level17 from './levels/level-17.json'
import level20 from './levels/level-20.json'
import level32 from './levels/level-32.json'
import level36 from './levels/level-36.json'

/**
 * 渲染冒烟测试：用 Proxy 桩画布验证 render 可无异常执行。
 * 渲染层只读状态、零状态变更；这里不校验像素，只防运行时错误（重写渲染时的回归护栏）。
 * v1 覆盖：游离色珠 / 手持色珠 / 翻转动画的状态转移 / 无效进攻反馈 / 已达标锁定圈。
 * v2 覆盖：相邻中心（缩短臂 + 共轭键 + 半程目标圈）/ 连锁翻转的阶梯动画转移。
 * 认知外置层（design §11）覆盖：按住预演（对应翻转动画 / 共振链阶梯 / 拾取 / 无效动作）/
 * Inspect 面板（tetra + trigonal）/ 标记徽章 / 命中检测。
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

function recordingCtx(texts: string[]): CanvasRenderingContext2D {
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'fillText') return (value: string) => texts.push(String(value))
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
    const level = chemGame.parseLevel(level05)
    let s = initialState(level)
    render(s, ctx, 480, 480)
    // 行走 + 拾取（动画转移）
    s = step(s, 'E')
    expect(s.holding).toBe('purple')
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    // 无效进攻反馈（抖动 + 红闪路径）
    notifyChemImpact('N')
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    // 第一次持珠进攻：紫珠进入 A，开口蓝珠换到手中。
    s = step(s, 'S')
    expect(s.holding).toBe('blue')
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    // 搬到 B 的背面；持珠站在合法进攻位时覆盖染色落点预览路径。
    s = step(s, 'E')
    s = step(s, 'E')
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    const attacked = step(s, 'S')
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
    // 连锁翻转转移：level-17 一击分叉到四个中心。
    const level = chemGame.parseLevel(level17)
    let s = initialState(level)
    render(s, ctx, 480, 480)
    const attacked = step(s, 'E')
    expect(attacked.won).toBe(true)
    expect(() => render(attacked, ctx, 480, 480)).not.toThrow()
    // 连锁进行中（动画未结束）再渲染一帧
    expect(() => render(attacked, ctx, 480, 480)).not.toThrow()
  })

  it('v3.2 机制群（光照格 / 阶段护罩 / 弹射中心 / 三臂整体翻转动画 / 分步目标）渲染不抛错', () => {
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
          shieldUntilStage: 1,
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

    // 三臂中心整体翻转动画帧：光照后开口 S→N（跳过缺口 W），站位改在南侧 (3,3)
    // 路线：S S（到 (0,4)）E E E（到 (3,4)，(1,4) 拾取 blue）N（(3,3)）再 N = 进攻
    for (const d of ['S', 'S', 'E', 'E', 'E', 'N'] as const) s = step(s, d)
    const attacked = step(s, 'N')
    expect(attacked.centers[1].leaving).toBe('S') // 整体翻转（N→S），缺口 W→E
    expect(() => render(attacked, ctx, 480, 480)).not.toThrow()
  })

  it('弹射中心：静态轮廓、就位弹道、按住预演、执行飞珠与喷口受阻反馈均可渲染', () => {
    const ctx = stubCtx()
    let s = initialState(chemGame.parseLevel(level32))
    expect(() => render(s, ctx, 480, 480)).not.toThrow() // 静态菱形喷嘴核 + 常驻双箭头
    s = step(s, 'S')
    s = step(s, 'S') // 拾取 blue
    s = step(s, 'E') // 到合法进攻位；常态渲染完整弹道
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    const next = step(s, 'E')
    setChemPreview(next)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    setChemPreview(null)
    expect(() => render(next, ctx, 480, 480)).not.toThrow() // 正式执行飞珠
    expect(() => render(next, ctx, 480, 480)).not.toThrow()

    const blocked = chemGame.parseLevel({
      ...level32,
      id: 'render-eject-blocked',
      player: [0, 1],
      groups: [{ pos: [1, 1], color: 'blue' }],
      walls: [[0, 2]],
    })
    let b = initialState(blocked)
    b = step(b, 'E')
    b = step(b, 'S')
    notifyChemImpact('E')
    expect(() => render(b, ctx, 480, 480)).not.toThrow() // 交叉火花，不走普通撞面弧
  })

  it('阶段护罩：与未来段目标共享“2”号编码，预演解除与正式碎裂均可渲染', () => {
    const texts: string[] = []
    const ctx = recordingCtx(texts)
    let s = initialState(chemGame.parseLevel(level36))
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    expect(texts).toContain('2')

    s = step(s, 'W') // 到第一段中心的合法进攻位
    const next = step(s, 'S') // 完成第一段，护罩将在结算后解除
    expect(next.stage).toBe(1)
    expect(next.centers[1].arms).toEqual(s.centers[1].arms) // 不伪造同回合追加变化
    setChemPreview(next)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    setChemPreview(null)
    expect(() => render(next, ctx, 480, 480)).not.toThrow() // 正式护罩碎裂
  })
})

describe('chem 认知外置层（design §11：预演 / Inspect / 标记）', () => {
  const reset = (): void => {
    setChemPreview(null)
    setChemInspect(null)
    setChemMarks(null)
  }

  it('按住预演：进攻 / 拾取 / 无效动作（含已胜局面）均不抛错', () => {
    const ctx = stubCtx()
    const s = initialState(chemGame.parseLevel(level01))
    // 进攻预演（player 在开口背面，按 E 撞入 ⇒ 中心构型变化）
    setChemPreview(step(s, 'E'))
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    // 无效动作预演（step 返回原状态 ⇒ 无变化中心，仅压暗 + 提示条）
    setChemPreview(step(s, 'S'))
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    reset()

    // 拾取预演（游离珠消失 + 手持出现）
    const l03 = chemGame.parseLevel(level03)
    const s03 = initialState(l03)
    setChemPreview(step(s03, 'E'))
    expect(() => render(s03, ctx, 480, 480)).not.toThrow()
    reset()

    // 已胜局面下注入预演（应被忽略，不抛错）
    const won = step(s, 'E')
    expect(won.won).toBe(true)
    setChemPreview(won)
    expect(() => render(won, ctx, 480, 480)).not.toThrow()
    reset()
  })

  it('共振链预演：多中心连锁（level-17 一击翻三个）渲染不抛错', () => {
    const ctx = stubCtx()
    let s = initialState(chemGame.parseLevel(level17))
    const next = step(s, 'E')
    // 该攻击引发连锁（≥2 个中心变化）⇒ 走对应翻转动画 + 阶梯延迟 + ①②③ 徽标路径
    const changed = s.centers.filter(
      (c, i) => c.arms !== next.centers[i].arms || c.leaving !== next.centers[i].leaving,
    ).length
    expect(changed).toBeGreaterThanOrEqual(2)
    setChemPreview(next)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    reset()
  })

  it('Inspect 面板：tetra / trigonal 均显示模 2 两态，越界下标不抛错', () => {
    const ctx = stubCtx()
    // tetra：单中心
    const tetra = chemGame.parseLevel(level01)
    const st = initialState(tetra)
    setChemInspect(0)
    expect(() => render(st, ctx, 480, 480)).not.toThrow()
    reset()

    // trigonal：三臂中心与普通中心同为周期 2，缺口翻到对侧
    const trig: ChemLevel = {
      id: 'inspect-trig',
      width: 3,
      height: 3,
      walls: [],
      player: [0, 2],
      centers: [
        { pos: [1, 1], arms: { N: 'red', E: 'blue', S: 'green' }, leaving: 'N', kind: 'trigonal' },
      ],
      groups: [],
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'blue' }] }],
      lights: [],
    }
    const sg = initialState(chemGame.parseLevel(trig))
    setChemInspect(0)
    expect(() => render(sg, ctx, 480, 480)).not.toThrow()
    reset()

    // 越界下标（壳层切关可能传入旧值）⇒ 守卫忽略，不抛错
    setChemInspect(9)
    expect(() => render(st, ctx, 480, 480)).not.toThrow()
    reset()
  })

  it('玩家标记（顺序 ①–⑤ / ★ ？ ×）渲染不抛错，含越界格', () => {
    const ctx = stubCtx()
    const st = initialState(chemGame.parseLevel(level01))
    const m = new Map<string, ChemMark>([
      ['2,2', '1'], // 中心格：顺序标
      ['0,0', 'star'],
      ['1,3', 'question'],
      ['4,1', 'cross'],
      ['9,9', '2'], // 越界：应被跳过
    ])
    setChemMarks(m)
    expect(() => render(st, ctx, 480, 480)).not.toThrow()
    reset()
  })

  it('chemHitTest：命中中心 / 普通格 / 棋盘外', () => {
    const st = initialState(chemGame.parseLevel(level01))
    // 中心在 (1,1)，棋盘 3×3，pad=28 ⇒ cell=floor((480-56)/3)=141，ox=oy=28
    const hit = chemHitTest(st, 28 + 141 + 70, 28 + 141 + 70, 480, 480)
    expect(hit).toEqual({ kind: 'center', index: 0 })
    const cell = chemHitTest(st, 28 + 70, 28 + 70, 480, 480) // (0,0)
    expect(cell).toEqual({ kind: 'cell', x: 0, y: 0 })
    expect(chemHitTest(st, 5, 5, 480, 480)).toBeNull() // 棋盘外
  })
})
