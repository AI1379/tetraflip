/** 极简补间工具：供移动 / 翻转等纯渲染动画使用。 */

export type Ease = (t: number) => number

export const easeOutCubic: Ease = (t) => 1 - (1 - t) ** 3
export const easeInOutQuad: Ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * 管理一组按名字索引的数值补间。
 * 状态变化时调用 set(name, target, now)；渲染每帧调用 value(name, now) 取当前插值。
 * 若名字不在活跃集合中，value 返回 NaN（调用方回退到逻辑位置）。
 */
export class Tweens {
  private active = new Map<
    string,
    { from: number; to: number; start: number; durationMs: number; ease: Ease }
  >()

  set(
    name: string,
    to: number,
    now: number,
    durationMs = 120,
    ease: Ease = easeOutCubic,
    from?: number,
  ): void {
    const current = this.active.get(name)
    // 第一次设置若没有显式起点，只能视为“初始化到目标”；状态差值驱动的动画
    // 必须传入上一状态的值，否则首次移动会把起点和终点都设成 to，视觉上退化为瞬移。
    const start = current ? this.valueAt(current, now) : (from ?? to)
    if (start === to) {
      this.active.delete(name)
      return
    }
    this.active.set(name, { from: start, to, start: now, durationMs, ease })
  }

  value(name: string, now: number): number {
    const tween = this.active.get(name)
    if (!tween) return Number.NaN
    const v = this.valueAt(tween, now)
    if (now - tween.start >= tween.durationMs) this.active.delete(name)
    return v
  }

  has(name: string): boolean {
    return this.active.has(name)
  }

  private valueAt(
    tween: { from: number; to: number; start: number; durationMs: number; ease: Ease },
    now: number,
  ): number {
    const p = Math.min(1, (now - tween.start) / tween.durationMs)
    return lerp(tween.from, tween.to, tween.ease(p))
  }
}
