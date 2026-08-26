import type { Dir } from '../core/protocol'

/** 棋盘轻点与方向滑动的分界。 */
export const SWIPE_DISTANCE = 24

/** 锁定滑动方向后继续停留多久，才把动作升级为一步预演。 */
export const PREVIEW_HOLD_MS = 280

/** 斜向意图不够明确时返回 null，避免手指轻微漂移导致误变向。 */
export function swipeDir(dx: number, dy: number): Dir | null {
  if (Math.min(Math.abs(dx), Math.abs(dy)) > Math.max(Math.abs(dx), Math.abs(dy)) * 0.75) {
    return null
  }
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : dy > 0 ? 'S' : 'N'
}

/** 快速滑动只执行；方向锁定后继续停留才显示预演。 */
export function shouldStartPreview(directionLockedAt: number, now: number): boolean {
  return now - directionLockedAt >= PREVIEW_HOLD_MS
}
