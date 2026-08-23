import { DIR_ARROW } from '../../core/protocol'
import type { T3State } from './engine'

const COLORS: Record<string, string> = {
  red: '#e5484d',
  blue: '#4f8ef7',
  green: '#46a758',
  yellow: '#e0b64f',
}
const colorOf = (name: string): string => COLORS[name] ?? '#a06cd5'
const PLAYER = '#f2f4f8'

export function render(s: T3State, ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const pad = 16
  const stripH = 56
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
    fillRoundCell(ctx, ox + x * cell, oy + y * cell, cell)
  }

  // 目标（虚线框）
  dashedCell(ctx, ox + s.player.goal[0] * cell, oy + s.player.goal[1] * cell, cell, PLAYER)
  for (const e of s.echoes) {
    dashedCell(ctx, ox + e.goal[0] * cell, oy + e.goal[1] * cell, cell, colorOf(e.color))
  }

  // 回声棋子 → 玩家（玩家最后画，保证重叠时可见）
  for (const e of s.echoes) piece(ctx, ox + e.pos[0] * cell, oy + e.pos[1] * cell, cell, colorOf(e.color))
  piece(ctx, ox + s.player.pos[0] * cell, oy + s.player.pos[1] * cell, cell, PLAYER)

  // 回声队列提示：每枚回声即将回放的输入（旧 → 新）
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.max(12, Math.floor(cell * 0.32))}px ui-monospace, Menlo, monospace`
  const by = oy + s.height * cell + Math.floor(stripH / 2)
  let tx = ox
  for (const e of s.echoes) {
    const queued = s.history.slice(Math.max(0, s.history.length - e.delay))
    const text = `${e.color}(d${e.delay}): ${queued.length > 0 ? queued.map((d) => DIR_ARROW[d]).join(' ') : '尚无回声'}`
    ctx.fillStyle = colorOf(e.color)
    ctx.fillText(text, tx, by)
    tx += ctx.measureText(text).width + 24
  }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function fillRoundCell(ctx: CanvasRenderingContext2D, x: number, y: number, cell: number): void {
  const inset = cell * 0.08
  ctx.beginPath()
  ctx.roundRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2, cell * 0.12)
  ctx.fill()
}

function dashedCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cell: number,
  color: string,
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.8
  ctx.setLineDash([4, 3])
  ctx.lineWidth = 2
  const inset = cell * 0.16
  ctx.strokeRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2)
  ctx.restore()
}

function piece(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cell: number,
  color: string,
): void {
  const inset = cell * 0.18
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.roundRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2, cell * 0.16)
  ctx.fill()
}
