import { describe, expect, it } from 'vitest'
import {
  SWIPE_DISTANCE,
  PREVIEW_HOLD_MS,
  shouldStartPreview,
  swipeDir,
} from './swipe'

describe('移动端棋盘滑动意图', () => {
  it('普通快速滑动只锁定方向，不触发预演压暗', () => {
    expect(swipeDir(SWIPE_DISTANCE + 8, 3)).toBe('E')
    expect(shouldStartPreview(1_000, 1_000 + PREVIEW_HOLD_MS - 1)).toBe(false)
  })

  it('锁定方向后继续停留到阈值才触发预演', () => {
    expect(shouldStartPreview(1_000, 1_000 + PREVIEW_HOLD_MS)).toBe(true)
    expect(shouldStartPreview(1_000, 1_000 + PREVIEW_HOLD_MS + 200)).toBe(true)
  })

  it('只接受主方向明确的滑动', () => {
    expect(swipeDir(30, 25)).toBeNull()
    expect(swipeDir(-30, 4)).toBe('W')
    expect(swipeDir(4, -30)).toBe('N')
  })
})
