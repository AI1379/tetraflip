import { describe, expect, it } from 'vitest'
import { COVERED_REDRAW_MS, IDLE_REDRAW_MS, redrawBudgetMs } from './frame-budget'

const idle = { animating: false, stateChanged: false, previewing: false, feedbackActive: false, covered: false }

describe('渲染循环帧率门控', () => {
  it('棋盘动画 / 局面变化 / 预演 / 反馈期间全速重绘', () => {
    expect(redrawBudgetMs({ ...idle, animating: true })).toBe(0)
    expect(redrawBudgetMs({ ...idle, stateChanged: true })).toBe(0)
    expect(redrawBudgetMs({ ...idle, previewing: true })).toBe(0)
    expect(redrawBudgetMs({ ...idle, feedbackActive: true })).toBe(0)
  })

  it('静止时限频到 30Hz，弹窗遮罩下进一步降到 8Hz', () => {
    expect(redrawBudgetMs(idle)).toBe(IDLE_REDRAW_MS)
    expect(IDLE_REDRAW_MS).toBeCloseTo(1000 / 30)
    expect(redrawBudgetMs({ ...idle, covered: true })).toBe(COVERED_REDRAW_MS)
    expect(COVERED_REDRAW_MS).toBe(125)
  })

  it('动画优先于遮罩限频：遮罩下仍在播的棋盘动画保持全速', () => {
    expect(redrawBudgetMs({ ...idle, covered: true, animating: true })).toBe(0)
    expect(redrawBudgetMs({ ...idle, covered: true, stateChanged: true })).toBe(0)
  })
})
