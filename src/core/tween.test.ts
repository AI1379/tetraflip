import { describe, expect, it } from 'vitest'
import { Tweens } from './tween'

describe('Tweens', () => {
  it('首次补间可显式从上一状态出发，而不是瞬移到目标', () => {
    const tweens = new Tweens()
    const linear = (t: number): number => t

    tweens.set('player-x', 1, 100, 140, linear, 0)

    expect(tweens.value('player-x', 100)).toBe(0)
    expect(tweens.value('player-x', 170)).toBe(0.5)
    expect(tweens.value('player-x', 240)).toBe(1)
    expect(tweens.has('player-x')).toBe(false)
  })

  it('没有显式起点时仍可用于无动画的初始赋值', () => {
    const tweens = new Tweens()

    tweens.set('value', 3, 0)

    expect(tweens.value('value', 0)).toBeNaN()
    expect(tweens.has('value')).toBe(false)
  })
})
