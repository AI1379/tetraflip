export interface LogicalCanvasSize {
  width: number
  height: number
}

/**
 * Canvas 以固定逻辑宽度绘制，逻辑高度跟随 CSS 矩形比例。
 * 浏览器随后对 X/Y 使用同一缩放率，因此圆、格子和文字不会被压扁。
 */
export function logicalCanvasSize(
  cssWidth: number,
  cssHeight: number,
  logicalWidth = 480,
): LogicalCanvasSize {
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    cssWidth <= 0 ||
    cssHeight <= 0
  ) {
    return { width: logicalWidth, height: logicalWidth }
  }
  return {
    width: logicalWidth,
    height: Math.max(1, Math.round((logicalWidth * cssHeight) / cssWidth)),
  }
}
