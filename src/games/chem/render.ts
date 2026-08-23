import { DIR_VEC } from '../../core/protocol'
import type { ChemState } from './engine'

/**
 * 《109.5°》渲染（design §10 轻包装：化学味、零美术素材、全程序化 Canvas）。
 *
 * - 中心画成分子骨架风格：细键线 + 原子点（中心原子 + 四臂原子）。
 * - 背景：极低透明度的四面体线框（标题《109.5°》的几何本体，纯装饰）。
 * - 底部 HUD：实验仪器感的刻度尺 + 读数式文案。
 * - 纪律：装饰不压缩棋盘（布局常量与无装饰时完全一致）；
 *   `setChemDecor(false)` 可整体关掉装饰（玩法信息——开口圈/箭头/目标虚线——永远保留）。
 * - 全程不出现化学术语/化学式文字。
 */

const COLORS: Record<string, string> = {
  red: '#e5484d',
  blue: '#4f8ef7',
  green: '#46a758',
  yellow: '#e0b64f',
}
const colorOf = (name: string): string => COLORS[name] ?? '#a06cd5'
const INK = '#f2f4f8'
const BOND = '#55617a' // 键线
const FAINT = '#39424f' // 墙 / 刻度 / 角框
const TETRA = '#4f8ef7' // 背景四面体线框

let decor = true

/** 装饰开关（design §10：包装可用一个开关整体关掉）。只关装饰，不关玩法信息。 */
export function setChemDecor(v: boolean): void {
  decor = v
}

export function render(s: ChemState, ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const pad = 16
  const stripH = 40
  const cell = Math.floor(Math.min((W - pad * 2) / s.width, (H - pad * 2 - stripH) / s.height))
  const ox = Math.floor((W - cell * s.width) / 2)
  const oy = Math.floor((H - stripH - cell * s.height) / 2)

  ctx.fillStyle = '#0e1116'
  ctx.fillRect(0, 0, W, H)

  if (decor) {
    drawBackdrop(ctx, W, H)
    drawFrame(ctx, ox, oy, cell * s.width, cell * s.height, cell)
  }

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
  ctx.fillStyle = FAINT
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

  // 中心与四臂（分子骨架风格：键线 + 原子点）
  for (const c of s.centers) {
    const cx = ox + c.pos[0] * cell + cell / 2
    const cy = oy + c.pos[1] * cell + cell / 2

    // 键线（先画线，原子点压在线端上）
    ctx.strokeStyle = BOND
    ctx.lineWidth = Math.max(1.5, cell * 0.05)
    for (const arm of ['N', 'E', 'S', 'W'] as const) {
      const [ax, ay] = armCell(c.pos, arm)
      line(ctx, cx, cy, ox + ax * cell + cell / 2, oy + ay * cell + cell / 2)
    }

    // 臂原子
    for (const arm of ['N', 'E', 'S', 'W'] as const) {
      const [ax, ay] = armCell(c.pos, arm)
      const acx = ox + ax * cell + cell / 2
      const acy = oy + ay * cell + cell / 2
      ctx.fillStyle = colorOf(c.arms[arm])
      ctx.beginPath()
      ctx.arc(acx, acy, cell * 0.22, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
      ctx.lineWidth = Math.max(1, cell * 0.03)
      ctx.stroke()

      // 开口臂：白圈 + 箭头（玩法信息，永远保留）
      if (arm === c.leaving) {
        ctx.strokeStyle = INK
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(acx, acy, cell * 0.32, 0, Math.PI * 2)
        ctx.stroke()
        arrow(ctx, cx, cy, acx, acy, cell)
      }
    }

    // 中心原子
    ctx.fillStyle = FAINT
    ctx.beginPath()
    ctx.arc(cx, cy, cell * 0.13, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#8b95a5'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  // 玩家（最后画）
  const px = ox + s.player[0] * cell + cell / 2
  const py = oy + s.player[1] * cell + cell / 2
  if (decor) {
    ctx.save()
    ctx.strokeStyle = INK
    ctx.globalAlpha = 0.22
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(px, py, cell * 0.36, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
  ctx.fillStyle = INK
  ctx.beginPath()
  ctx.arc(px, py, cell * 0.28, 0, Math.PI * 2)
  ctx.fill()

  drawStrip(ctx, s, ox, s.width * cell, oy + s.height * cell, cell)
}

/** 底部 HUD：刻度尺 + 读数（步数 / 开口方向） */
function drawStrip(
  ctx: CanvasRenderingContext2D,
  s: ChemState,
  x0: number,
  width: number,
  yTop: number,
  cell: number,
): void {
  if (decor) {
    // 仪器刻度：每 1/3 格一小格，每格一大格
    const stepPx = Math.max(6, cell / 3)
    const y = yTop + 6
    ctx.strokeStyle = FAINT
    ctx.lineWidth = 1
    let i = 0
    for (let x = x0; x <= x0 + width + 0.5; x += stepPx, i++) {
      const h = i % 3 === 0 ? 5 : 3
      line(ctx, Math.round(x) + 0.5, y, Math.round(x) + 0.5, y + h)
    }
  }
  ctx.fillStyle = '#8b95a5'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.max(12, Math.floor(cell * 0.3))}px ui-monospace, Menlo, monospace`
  const leavingText = s.centers.map((c) => c.leaving).join(' / ')
  ctx.fillText(
    `步数 ${String(s.moves).padStart(3, '0')} │ 开口 ${leavingText} · 从开口的对面撞入`,
    x0,
    yTop + 26,
  )
}

/** 背景：极低透明度的四面体线框（《109.5°》的几何本体） */
function drawBackdrop(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  tetra(ctx, W * 0.16, H * 0.2, W * 0.15, 0.55, 0.4, 0.06)
  tetra(ctx, W * 0.86, H * 0.28, W * 0.11, -0.3, 0.7, 0.05)
  tetra(ctx, W * 0.22, H * 0.86, W * 0.13, 0.9, -0.35, 0.05)
  tetra(ctx, W * 0.84, H * 0.82, W * 0.16, 0.2, 0.95, 0.045)
}

/** 棋盘四角的仪器边框角标（不占棋盘内部空间） */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cell: number,
): void {
  const L = Math.min(14, cell * 0.4)
  const o = 5
  ctx.strokeStyle = FAINT
  ctx.lineWidth = 1
  const corner = (cx: number, cy: number, sx: number, sy: number): void => {
    line(ctx, cx + 0.5, cy + 0.5, cx + sx * L + 0.5, cy + 0.5)
    line(ctx, cx + 0.5, cy + 0.5, cx + 0.5, cy + sy * L + 0.5)
  }
  corner(x - o, y - o, 1, 1)
  corner(x + w + o, y - o, -1, 1)
  corner(x - o, y + h + o, 1, -1)
  corner(x + w + o, y + h + o, -1, -1)
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

/** 正四面体线框（正交投影；顶点即「原子点」）。109.5° 的几何本体。 */
const TETRA_V: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
]
const TETRA_E: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
]

function tetra(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  rotZ: number,
  rotX: number,
  alpha: number,
): void {
  const k = r * 0.58 // |v| = √3，归一到半径约 1
  const pts = TETRA_V.map(([x, y, z]) => {
    const x1 = x * Math.cos(rotZ) - y * Math.sin(rotZ)
    const y1 = x * Math.sin(rotZ) + y * Math.cos(rotZ)
    const y2 = y1 * Math.cos(rotX) - z * Math.sin(rotX)
    return [cx + x1 * k, cy + y2 * k] as const
  })
  ctx.save()
  ctx.strokeStyle = TETRA
  ctx.fillStyle = TETRA
  ctx.globalAlpha = alpha
  ctx.lineWidth = 1
  for (const [a, b] of TETRA_E) {
    line(ctx, pts[a][0], pts[a][1], pts[b][0], pts[b][1])
  }
  for (const [px, py] of pts) {
    ctx.beginPath()
    ctx.arc(px, py, 1.5, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
