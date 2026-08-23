import { DIR_VEC } from '../../core/protocol'
import type { ChemState } from './engine'

const COLORS: Record<string, string> = {
  red: '#e5484d',
  blue: '#4f8ef7',
  green: '#46a758',
  yellow: '#e0b64f',
}
const colorOf = (name: string): string => COLORS[name] ?? '#a06cd5'
const INK = '#f2f4f8'

export function render(s: ChemState, ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const pad = 16
  const stripH = 40
  const cell = Math.floor(Math.min((W - pad * 2) / s.width, (H - pad * 2 - stripH) / s.height))
  const ox = Math.floor((W - cell * s.width) / 2)
  const oy = Math.floor((H - stripH - cell * s.height) / 2)

  ctx.fillStyle = '#0e1116'
  ctx.fillRect(0, 0, W, H)

  // 网格
  ctx.strokeStyle = '#1c222b'
  ctx.lineWidth = 1
  for (let x = 0; x <= s.width; x++) {
    line(ctx, ox + x * cell + 0.5, oy, ox + x * cell + 0.5, oy + s.height * cell)
  }
  for (let y = 0; y <= s.height; y++) {
    line(ctx, ox, oy + y * cell + 0.5, ox + s.width * cell, oy + y * cell + 0.5)
  }

  // 墙
  ctx.fillStyle = '#39424f'
  for (const key of s.walls) {
    const [x, y] = key.split(',').map(Number)
    const inset = cell * 0.08
    ctx.beginPath()
    ctx.roundRect(ox + x * cell + inset, oy + y * cell + inset, cell - inset * 2, cell - inset * 2, cell * 0.12)
    ctx.fill()
  }

  // 目标（虚线圈）
  for (const g of s.goals) {
    const c = s.centers[g.center]
    const [gx, gy] = armCell(c.pos, g.arm)
    dashedCircle(
      ctx,
      ox + gx * cell + cell / 2,
      oy + gy * cell + cell / 2,
      cell * 0.34,
      colorOf(g.color),
    )
  }

  // 中心与四臂
  for (const c of s.centers) {
    const cx = ox + c.pos[0] * cell + cell / 2
    const cy = oy + c.pos[1] * cell + cell / 2
    // 中心块
    ctx.fillStyle = '#2a303a'
    ctx.beginPath()
    ctx.roundRect(ox + c.pos[0] * cell + cell * 0.18, oy + c.pos[1] * cell + cell * 0.18, cell * 0.64, cell * 0.64, cell * 0.14)
    ctx.fill()

    for (const arm of ['N', 'E', 'S', 'W'] as const) {
      const [ax, ay] = armCell(c.pos, arm)
      const acx = ox + ax * cell + cell / 2
      const acy = oy + ay * cell + cell / 2
      // 臂连线
      ctx.strokeStyle = '#2a303a'
      ctx.lineWidth = Math.max(2, cell * 0.08)
      line(ctx, cx, cy, acx, acy)
      // 基团
      ctx.fillStyle = colorOf(c.arms[arm])
      ctx.beginPath()
      ctx.arc(acx, acy, cell * 0.24, 0, Math.PI * 2)
      ctx.fill()
      // 开口臂：白圈 + 箭头
      if (arm === c.leaving) {
        ctx.strokeStyle = INK
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(acx, acy, cell * 0.32, 0, Math.PI * 2)
        ctx.stroke()
        arrow(ctx, cx, cy, acx, acy, cell)
      }
    }
  }

  // 玩家（最后画）
  ctx.fillStyle = INK
  ctx.beginPath()
  ctx.arc(ox + s.player[0] * cell + cell / 2, oy + s.player[1] * cell + cell / 2, cell * 0.28, 0, Math.PI * 2)
  ctx.fill()

  // 底部提示
  ctx.fillStyle = '#8b95a5'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.max(12, Math.floor(cell * 0.3))}px ui-monospace, Menlo, monospace`
  const leavingText = s.centers.map((c) => c.leaving).join(' / ')
  ctx.fillText(
    `第 ${s.moves} 步 · 开口方向: ${leavingText}（从开口的对面撞入）`,
    ox,
    oy + s.height * cell + stripH / 2,
  )
}

function armCell(center: readonly [number, number], arm: 'N' | 'E' | 'S' | 'W'): [number, number] {
  const [dx, dy] = DIR_VEC[arm]
  return [center[0] + dx, center[1] + dy]
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function dashedCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.85
  ctx.setLineDash([4, 3])
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

function arrow(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  cell: number,
): void {
  ctx.save()
  ctx.strokeStyle = INK
  ctx.fillStyle = INK
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 2
  const angle = Math.atan2(toY - fromY, toX - fromX)
  const headLen = cell * 0.16
  const tipX = toX - Math.cos(angle) * cell * 0.05
  const tipY = toY - Math.sin(angle) * cell * 0.05
  line(ctx, fromX, fromY, tipX, tipY)
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - headLen * Math.cos(angle - 0.5), tipY - headLen * Math.sin(angle - 0.5))
  ctx.lineTo(tipX - headLen * Math.cos(angle + 0.5), tipY - headLen * Math.sin(angle + 0.5))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}
