/**
 * 渲染循环的帧率门控（性能）：棋盘动画 / 预演 / 反馈期间全速重绘；
 * 静止时画面只剩极慢的 idle 脉冲（周期 ≥690ms）与背景自转（0.12 rad/s），
 * 30Hz 重绘视觉无差，却能把高刷屏 + 高 DPR 下每帧全画布 GPU 栅格化占用砍掉一半以上；
 * 弹窗遮罩（含 backdrop-filter）盖住棋盘时进一步降到 8Hz——模糊后面的脉冲本就不可感知。
 */
export const IDLE_REDRAW_MS = 1000 / 30
export const COVERED_REDRAW_MS = 125
/** 无效进攻抖动（240ms）等短暂反馈的全速重绘窗口，取整到 300ms 留余量。 */
export const BLOCKED_FEEDBACK_MS = 300

export interface RedrawSignal {
  /** 棋盘动画（走位 / 翻转 / 弹射 / 护罩）进行中 */
  animating: boolean
  /** 局面引用变化（步进 / 撤销 / 换关） */
  stateChanged: boolean
  /** 按住预演 ghost 显示中 */
  previewing: boolean
  /** 无效进攻抖动等短暂反馈窗口内 */
  feedbackActive: boolean
  /** 弹窗遮罩盖住棋盘 */
  covered: boolean
}

/** 重绘预算：0 = 每帧都画；否则为两次重绘的最小间隔毫秒数。 */
export function redrawBudgetMs(signal: RedrawSignal): number {
  if (signal.animating || signal.stateChanged || signal.previewing || signal.feedbackActive) return 0
  return signal.covered ? COVERED_REDRAW_MS : IDLE_REDRAW_MS
}
