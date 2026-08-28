import { describe, expect, it, vi } from 'vitest'
import { chemGame, initialState, isShielded, step } from './engine'
import {
  render,
  notifyChemImpact,
  resetChemAnim,
  getChemAnimationRemainingMs,
  getChemCenterFlipPhase,
  getChemSuccessfulImpactPhase,
  getChemShieldTransitionPhase,
  getChemAnimationMode,
  getChemRenderTheme,
  setChemAnimationMode,
  setChemRenderTheme,
  setChemPreview,
  setChemInspect,
  setChemMarks,
  chemHitTest,
  CHEM_PALETTES,
  shadeColor,
} from './render'
import type { ChemMark } from './render'
import type { ChemLevel } from './level'
import level01 from './levels/level-01.json'
import level03 from './levels/level-03.json'
import level05 from './levels/level-05.json'
import level07 from './levels/level-07.json'
import level08 from './levels/level-08.json'
import level09 from './levels/level-09.json'
import level12 from './levels/level-12.json'
import level15 from './levels/level-15.json'
import level26 from './levels/level-26.json'
import level30 from './levels/level-30.json'
import level39 from './levels/level-39.json'
import level48 from './levels/level-48.json'
import level56 from './levels/level-56.json'

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

function styleRecordingCtx(styles: string[]): CanvasRenderingContext2D {
  return new Proxy({} as CanvasRenderingContext2D, {
    get() {
      return (..._args: unknown[]) => undefined
    },
    set(_target, key, value) {
      if ((key === 'fillStyle' || key === 'strokeStyle') && typeof value === 'string') {
        styles.push(value)
      }
      return true
    },
  })
}

describe('chem（109.5°）渲染冒烟', () => {
  it('深浅语义调色板均覆盖代表机制关，并实际切换画布与玩法色', () => {
    const representatives = [level01, level07, level15, level26, level30, level39, level48, level56]
    const darkStyles: string[] = []
    const lightStyles: string[] = []
    try {
      setChemRenderTheme('dark')
      for (const json of representatives) {
        resetChemAnim()
        render(initialState(chemGame.parseLevel(json)), styleRecordingCtx(darkStyles), 480, 480)
      }
      expect(getChemRenderTheme()).toBe('dark')
      expect(darkStyles).toContain('#0b1018')
      expect(darkStyles).toContain('#ff6369')

      setChemRenderTheme('light')
      for (const json of representatives) {
        resetChemAnim()
        render(initialState(chemGame.parseLevel(json)), styleRecordingCtx(lightStyles), 480, 480)
      }
      expect(getChemRenderTheme()).toBe('light')
      expect(lightStyles).toContain('#f3f8fb')
      expect(lightStyles).toContain('#ec4f5f')
      expect(lightStyles).not.toContain('#0b1018')
    } finally {
      setChemRenderTheme('dark')
      resetChemAnim()
    }
  })

  it('浅色保持清亮填色（防 pastel 下限），可读性由深轮廓 / 纹样承担', () => {
    const luminance = (hex: string): number => {
      const channel = (c: number): number => {
        const v = c / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      const r = channel(parseInt(hex.slice(1, 3), 16))
      const g = channel(parseInt(hex.slice(3, 5), 16))
      const b = channel(parseInt(hex.slice(5, 7), 16))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contrast = (a: string, b: string): number => {
      const la = luminance(a)
      const lb = luminance(b)
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
    }
    const light = CHEM_PALETTES.light
    // design §10 红线：填充色保持清亮，不要求单独满足正文对比度；只设防「看不见 pastel」下限
    for (const [name, hex] of Object.entries(light.colors)) {
      expect(contrast(hex, light.canvas), `浅色玩法色 ${name}（${hex}）不应退成看不见的淡色`).toBeGreaterThanOrEqual(2.2)
    }
    for (const [i, tone] of light.stageTones.entries()) {
      expect(contrast(tone, light.canvas), `浅色阶段色 ${i + 1}（${tone}）不应退成看不见的淡色`).toBeGreaterThanOrEqual(2.3)
    }
    expect(contrast(light.lightCell, light.canvas)).toBeGreaterThanOrEqual(1.95)
    expect(contrast(light.bond, light.canvas)).toBeGreaterThanOrEqual(2.4)
    // 浅色可读性的实际承担者：描边为填充色派生的同相深色（藏青圈在暖色珠上显脏），
    // 纹样保持深中性色但柔和（0.5–0.68），既保色弱双编码又不让珠面挂霜
    const rgbaParts = (v: string): number[] =>
      (v.match(/\d+(\.\d+)?/g) ?? []).map(Number)
    for (const [name, hex] of Object.entries(light.colors)) {
      const edge = shadeColor(hex, 0.62)
      const edgeLum = luminance(edge)
      const fillLum = luminance(hex)
      const bgLum = luminance(light.canvas)
      const edgeContrast = (Math.max(edgeLum, bgLum) + 0.05) / (Math.min(edgeLum, bgLum) + 0.05)
      const fillContrast = (Math.max(fillLum, bgLum) + 0.05) / (Math.min(fillLum, bgLum) + 0.05)
      expect(fillLum, `${name} 派生描边必须比填充更深`).toBeGreaterThan(edgeLum)
      expect(edgeContrast, `${name} 派生描边对棋盘底应保持边缘可读`).toBeGreaterThanOrEqual(
        fillContrast,
      )
      expect(edgeContrast).toBeGreaterThanOrEqual(2.8)
    }
    const pattern = rgbaParts(light.atomPattern)
    expect(pattern[0] + pattern[1] + pattern[2]).toBeLessThan(200)
    expect(pattern[3]).toBeGreaterThanOrEqual(0.5)
    expect(pattern[3]).toBeLessThanOrEqual(0.68)
    // 深色调色板零改动：玩法色仍为既定值
    expect(CHEM_PALETTES.dark.colors).toEqual({
      red: '#ff6369',
      blue: '#5da9ff',
      green: '#58d68d',
      yellow: '#f6c85f',
      purple: '#c084fc',
    })
  })

  it('单中心 / 多中心 / v1 搬运关均可直接渲染', () => {
    const ctx = stubCtx()
    for (const json of [level01, level09, level08, level12]) {
      const s = initialState(chemGame.parseLevel(json))
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

  it('有效进攻先播放前冲与蓝色接触反馈，再开始中心翻转', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    try {
      setChemAnimationMode('clear')
      resetChemAnim()
      const start = initialState(chemGame.parseLevel(level01))
      const positioned = step(start, 'S')
      const attacked = step(positioned, 'E')
      const ctx = stubCtx()
      render(positioned, ctx, 480, 480)
      render(attacked, ctx, 480, 480)

      expect(getChemSuccessfulImpactPhase(0)).toBe('approach')
      expect(getChemSuccessfulImpactPhase(119)).toBe('approach')
      expect(getChemSuccessfulImpactPhase(120)).toBe('burst')
      expect(getChemCenterFlipPhase(0, 119)).toBe('waiting')
      expect(getChemCenterFlipPhase(0, 120)).toBe('rotating')
      expect(getChemSuccessfulImpactPhase(340)).toBeNull()
    } finally {
      now.mockRestore()
      resetChemAnim()
    }
  })

  it('清晰 / 快速节奏独立切换，清晰取代为交换后翻转并占用更长时间线', () => {
    const ctx = stubCtx()
    const start = initialState(chemGame.parseLevel(level03))
    const carrying = step(start, 'E')
    const attacked = step(carrying, 'S')

    setChemAnimationMode('clear')
    resetChemAnim()
    render(carrying, ctx, 480, 480)
    expect(() => render(attacked, ctx, 480, 480)).not.toThrow()
    const clearRemaining = getChemAnimationRemainingMs()
    expect(getChemAnimationMode()).toBe('clear')

    setChemAnimationMode('fast')
    render(carrying, ctx, 480, 480)
    expect(() => render(attacked, ctx, 480, 480)).not.toThrow()
    const fastRemaining = getChemAnimationRemainingMs()
    expect(getChemAnimationMode()).toBe('fast')
    expect(clearRemaining).toBeGreaterThan(fastRemaining + 500)

    setChemAnimationMode('clear')
  })

  it('v2 共振关（相邻中心 / 共轭键 / 连锁翻转转移）渲染不抛错', () => {
    const ctx = stubCtx()
    for (const json of [level07, level15]) {
      const s = initialState(chemGame.parseLevel(json))
      expect(() => render(s, ctx, 480, 480)).not.toThrow()
    }
    // 连锁翻转转移：level-08 一击连翻三个。
    const level = chemGame.parseLevel(level08)
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
    let s = initialState(chemGame.parseLevel(level26))
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
      ...level26,
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

  it('阶段护罩：与未来段目标共享“02”两位编码，预演解除与正式碎裂均可渲染', () => {
    const texts: string[] = []
    const ctx = recordingCtx(texts)
    let s = initialState(chemGame.parseLevel(level30))
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    expect(texts).toContain('02')

    s = step(s, 'W') // 到第一段中心的合法进攻位
    const next = step(s, 'S') // 完成第一段，护罩将在结算后解除
    expect(next.stage).toBe(1)
    expect(next.centers[1].arms).toEqual(s.centers[1].arms) // 不伪造同回合追加变化
    setChemPreview(next)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    setChemPreview(null)
    expect(() => render(next, ctx, 480, 480)).not.toThrow() // 正式护罩碎裂
  })

  it('终局动画时钟覆盖实际翻转，并可在换关时立即清空', () => {
    const ctx = stubCtx()
    resetChemAnim()
    const s = initialState(chemGame.parseLevel(level08))
    render(s, ctx, 480, 480)
    const won = step(s, 'E')
    expect(won.won).toBe(true)
    render(won, ctx, 480, 480)
    expect(getChemAnimationRemainingMs()).toBeGreaterThan(200)
    resetChemAnim()
    expect(getChemAnimationRemainingMs()).toBe(0)
  })

  it('再生护罩：打开时常显休眠 R 与控制线，预演生成 / 消失均可渲染', () => {
    const texts: string[] = []
    const ctx = recordingCtx(texts)
    let s = initialState(chemGame.parseLevel(level39))
    expect(isShielded(s, s.centers[1])).toBe(false)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    expect(texts).toContain('R') // 旧实现只在关盾时显示，开局看不出机关存在

    const closed = step(s, 'S')
    expect(isShielded(closed, closed.centers[1])).toBe(true)
    setChemPreview(closed)
    expect(() => render(s, ctx, 480, 480)).not.toThrow() // 开→关预演必须出现完整护罩
    setChemPreview(null)
    s = closed

    // 沿最短解走到最后一次修复控制臂之前，覆盖再生罩的关→开预演。
    for (const action of ['E', 'S', 'S', 'E', 'W'] as const) s = step(s, action)
    const reopened = step(s, 'N')
    expect(isShielded(reopened, reopened.centers[1])).toBe(false)
    setChemPreview(reopened)
    expect(() => render(s, ctx, 480, 480)).not.toThrow()
    setChemPreview(null)
    expect(() => render(reopened, ctx, 480, 480)).not.toThrow()
  })

  it('level-48：R 盾在控制臂落定后、后续共振翻转结束前释放', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    try {
      setChemAnimationMode('clear')
      resetChemAnim()
      let before = initialState(chemGame.parseLevel(level48))
      for (const action of ['W', 'S', 'S', 'E', 'E', 'W', 'N', 'E', 'S', 'E'] as const) {
        before = step(before, action)
      }
      expect(isShielded(before, before.centers[2])).toBe(true)
      const after = step(before, 'E')
      expect(isShielded(after, after.centers[2])).toBe(false)
      expect(after.centers[2].arms).not.toEqual(before.centers[2].arms)

      const ctx = stubCtx()
      render(before, ctx, 480, 480)
      render(after, ctx, 480, 480)
      // 直接命中的控制中心在 120ms 停顿 + 420ms 翻转后落定；R 盾此时释放，
      // 受保护中心再等独立 180ms 因果拍，之后才带着后续共振链开始旋转。
      expect(getChemShieldTransitionPhase(2, 539)).toBe('waiting-release')
      expect(getChemShieldTransitionPhase(2, 540)).toBe('releasing')
      expect(getChemCenterFlipPhase(2, 719)).toBe('waiting')
      expect(getChemCenterFlipPhase(2, 720)).toBe('rotating')
      expect(getChemAnimationRemainingMs(540)).toBeGreaterThan(400)
    } finally {
      now.mockRestore()
      resetChemAnim()
    }
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
    const positioned = step(s, 'S')
    // 进攻预演（player 在开口背面，按 E 撞入 ⇒ 中心构型变化）
    setChemPreview(step(positioned, 'E'))
    expect(() => render(positioned, ctx, 480, 480)).not.toThrow()
    const previewTexts: string[] = []
    render(positioned, recordingCtx(previewTexts), 480, 480)
    expect(previewTexts).toContain('预演中 · 松开执行 · 回到原位 / Esc 取消')
    // 无效动作预演（step 返回原状态 ⇒ 无变化中心，仅压暗 + 提示条）
    setChemPreview(step(positioned, 'W'))
    expect(() => render(positioned, ctx, 480, 480)).not.toThrow()
    reset()

    // 拾取预演（游离珠消失 + 手持出现）
    const l03 = chemGame.parseLevel(level03)
    const s03 = initialState(l03)
    setChemPreview(step(s03, 'E'))
    expect(() => render(s03, ctx, 480, 480)).not.toThrow()
    reset()

    // 已胜局面下注入预演（应被忽略，不抛错）
    const won = step(positioned, 'E')
    expect(won.won).toBe(true)
    setChemPreview(won)
    expect(() => render(won, ctx, 480, 480)).not.toThrow()
    reset()
  })

  it('共振链预演：多中心连锁（level-08 一击连翻三个）渲染不抛错', () => {
    const ctx = stubCtx()
    let s = initialState(chemGame.parseLevel(level08))
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

  it('矩形外围仍按等比例格子渲染，并以同一矩形布局命中中心', () => {
    const st = initialState(chemGame.parseLevel(level01))
    const ctx = stubCtx()
    expect(() => render(st, ctx, 480, 280)).not.toThrow()

    // 3×3：cell=floor((280-56)/3)=74，ox=(480-222)/2=129，oy=29；中心在 (1,1)。
    expect(chemHitTest(st, 129 + 74 + 37, 29 + 74 + 37, 480, 280)).toEqual({
      kind: 'center',
      index: 0,
    })
    expect(chemHitTest(st, 20, 20, 480, 280)).toBeNull()
  })
})
