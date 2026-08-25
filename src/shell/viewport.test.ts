import { describe, expect, it } from 'vitest'
import { logicalCanvasSize } from './viewport'

describe('矩形 Canvas 逻辑尺寸', () => {
  it('固定逻辑宽度并按 CSS 宽高比压缩逻辑高度', () => {
    expect(logicalCanvasSize(700, 400)).toEqual({ width: 480, height: 274 })
    expect(logicalCanvasSize(390, 370)).toEqual({ width: 480, height: 455 })
  })

  it('矩形画布的横纵缩放率保持近似一致，不会把圆拉成椭圆', () => {
    const logical = logicalCanvasSize(700, 400)
    expect(700 / logical.width).toBeCloseTo(400 / logical.height, 2)
  })

  it('布局尚未建立时安全回退为正方形', () => {
    expect(logicalCanvasSize(0, 0)).toEqual({ width: 480, height: 480 })
  })
})
