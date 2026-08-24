import { DIR_ARROW } from '../../core/protocol'
import type { Dir } from '../../core/protocol'
import { maxDelay } from './engine'
import type { T3State } from './engine'

/**
 * 《t+3》渲染（design §11 认知外置层：时间线是核心玩法 UI，不是视觉包装）。
 *
 * - 棋盘下方常驻「指令缓冲区」时间线：
 *   列 = 未来回合 t+1 … t+D+1（D = 最长延迟；末列 = 你下一次按键将流入的位置），
 *   行 = 你 + 每枚回声（延迟标签 +d）。回声行已确定的拍画彩色方向箭头，还没输入的拍画「·」；
 *   t+1 列（下一拍）高亮。一句话规则：「输入不会消失，它会沿时间线向后流动。」
 * - 棋盘上每枚回声旁挂「下一步动作」chip（下一拍已确定才显示）——红棋下一拍走什么，一眼可读。
 * - 按住预演（壳层注入 step(当前态, 按住方向) 的 ghost 态，见 setT3Preview）：
 *   棋盘画 ghost 棋子 + 移动箭头；时间线上该输入将流入每枚回声的落点列（ghost 箭头）。
 *   被墙挡住的输入同样进队列（level-02 的核心教学），所以 ghost 与落点列照画。
 * - 渲染层只读状态；时间线完全由 history / echo.delay 派生，不进引擎、不进 stateKey。
 */

const COLORS: Record<string, string> = {
  red: '#e5484d',
  blue: '#4f8ef7',
  green: '#46a758',
  yellow: '#e0b64f',
}
const colorOf = (name: string): string => COLORS[name] ?? '#a06cd5'
const PLAYER = '#f2f4f8'
const INK = '#f2f4f8'
const FAINT = '#39424f'
const MUTED_INK = '#8d9aab'
const BG = '#0e1116'
const GRID = '#1c222b'
const ACCENT = 'rgba(240, 198, 90, 0.08)'

let preview: T3State | null = null

/** 壳层按住方向时注入的一步预演态（= step(当前态, 按住方向)）；null = 无预演。 */
export function setT3Preview(next: T3State | null): void {
  preview = next
}

/**
 * 回声 e 在未来第 k 拍（k ≥ 1，当前已输入 history.length 个）要回放的输入。
 * 已确定 ⇔ 那一拍的输入已经按下；否则返回 null（等你去按）。
 */
function scheduledInput(s: T3State, delay: number, k: number): Dir | null {
  const idx = s.history.length + k - 1 - delay
  return idx >= 0 && idx < s.history.length ? s.history[idx] : null
}

export function render(s: T3State, ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const pad = 16
  const D = s.echoes.length > 0 ? maxDelay(s) : 0
  const headH = 15
  const rowH = 20
  const stripTopGap = 10
  const rows = 1 + s.echoes.length // 玩家行 + 每枚回声一行
  const stripH = s.echoes.length > 0 ? stripTopGap + headH + rows * rowH : 0
  const cell = Math.max(
    12,
    Math.floor(Math.min((W - pad * 2) / s.width, (H - pad * 2 - stripH) / s.height)),
  )
  const ox = Math.floor((W - cell * s.width) / 2)
  const oy = Math.floor((H - stripH - cell * s.height) / 2)
  const boardW = cell * s.width

  ctx.fillStyle = BG
  ctx.fillRect(0, 0, W, H)

  // ---------- 棋盘 ----------
  ctx.strokeStyle = GRID
  ctx.lineWidth = 1
  for (let x = 0; x <= s.width; x++) {
    line(ctx, ox + x * cell + 0.5, oy, ox + x * cell + 0.5, oy + s.height * cell)
  }
  for (let y = 0; y <= s.height; y++) {
    line(ctx, ox, oy + y * cell + 0.5, ox + s.width * cell, oy + y * cell + 0.5)
  }

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

  // 按住预演：ghost 棋子（玩家 + 各回声的下一拍位置）
  if (preview && !s.won) {
    ghostPiece(ctx, ox + preview.player.pos[0] * cell, oy + preview.player.pos[1] * cell, cell, PLAYER)
    moveArrow(
      ctx,
      ox + s.player.pos[0] * cell,
      oy + s.player.pos[1] * cell,
      ox + preview.player.pos[0] * cell,
      oy + preview.player.pos[1] * cell,
      cell,
      PLAYER,
    )
    preview.echoes.forEach((e, i) => {
      const cur = s.echoes[i]
      if (!cur || (e.pos[0] === cur.pos[0] && e.pos[1] === cur.pos[1])) return
      ghostPiece(ctx, ox + e.pos[0] * cell, oy + e.pos[1] * cell, cell, colorOf(e.color))
      moveArrow(
        ctx,
        ox + cur.pos[0] * cell,
        oy + cur.pos[1] * cell,
        ox + e.pos[0] * cell,
        oy + e.pos[1] * cell,
        cell,
        colorOf(e.color),
      )
    })
  }

  // 回声棋子 → 玩家（玩家最后画，保证重叠时可见）
  for (const e of s.echoes) piece(ctx, ox + e.pos[0] * cell, oy + e.pos[1] * cell, cell, colorOf(e.color))
  piece(ctx, ox + s.player.pos[0] * cell, oy + s.player.pos[1] * cell, cell, PLAYER)

  // 回声「下一步动作」chip：下一拍已确定才显示（「红棋下一拍走 ↑」不用记）
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const e of s.echoes) {
    const next = scheduledInput(s, e.delay, 1)
    if (next === null) continue
    nextChip(ctx, ox + e.pos[0] * cell, oy + e.pos[1] * cell, cell, next, colorOf(e.color))
  }

  // ---------- 时间线（核心玩法 UI） ----------
  if (s.echoes.length === 0) return

  const cols = D + 1
  const labelW = Math.min(72, Math.max(48, boardW * 0.2))
  const gridX = ox + labelW
  const colW = (boardW - labelW) / cols
  const top = oy + s.height * cell + stripTopGap
  const rowsTop = top + headH

  // t+1 列高亮（下一拍）
  ctx.fillStyle = ACCENT
  ctx.fillRect(gridX, top, colW, headH + rows * rowH)

  // 表头：t+1 … t+D+1（末列 = 下一次按键的落点）
  ctx.font = '10px ui-monospace, Menlo, monospace'
  ctx.fillStyle = MUTED_INK
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('拍 →', ox, top + headH / 2)
  ctx.textAlign = 'center'
  for (let k = 1; k <= cols; k++) {
    const x = gridX + (k - 0.5) * colW
    ctx.fillStyle = k === 1 ? '#f0c65a' : MUTED_INK
    ctx.fillText(`t+${k}`, x, top + headH / 2)
  }

  // 行：玩家（你）+ 每枚回声
  const held = preview && !s.won ? preview.history[preview.history.length - 1] : null
  const drawRow = (y: number, label: string, labelColor: string, delay: number | null): void => {
    ctx.textAlign = 'left'
    ctx.font = '11px ui-monospace, Menlo, monospace'
    if (delay === null) {
      ctx.fillStyle = INK
      ctx.fillText(label, ox + 4, y + rowH / 2)
    } else {
      ctx.fillStyle = labelColor
      ctx.fillRect(ox + 4, y + rowH / 2 - 4, 8, 8)
      ctx.fillText(`+${delay}`, ox + 16, y + rowH / 2)
    }
    ctx.textAlign = 'center'
    ctx.font = '15px ui-monospace, Menlo, monospace'
    for (let k = 1; k <= cols; k++) {
      const x = gridX + (k - 0.5) * colW
      if (delay === null) {
        // 玩家行：全部拍都还没按；预演时 t+1 显示按住的方向
        if (k === 1 && held !== null) {
          ctx.fillStyle = INK
          ctx.fillText(DIR_ARROW[held], x, y + rowH / 2)
        } else {
          ctx.fillStyle = FAINT
          ctx.font = '12px ui-monospace, Menlo, monospace'
          ctx.fillText('·', x, y + rowH / 2)
          ctx.font = '15px ui-monospace, Menlo, monospace'
        }
        continue
      }
      const input = scheduledInput(s, delay, k)
      if (input !== null) {
        ctx.fillStyle = labelColor
        ctx.fillText(DIR_ARROW[input], x, y + rowH / 2)
      } else if (held !== null && k === delay + 1) {
        // 预演：按住的输入将流入这枚回声的落点列
        ctx.save()
        ctx.globalAlpha = 0.45
        ctx.fillStyle = labelColor
        ctx.fillText(DIR_ARROW[held], x, y + rowH / 2)
        ctx.restore()
      } else {
        ctx.fillStyle = FAINT
        ctx.font = '12px ui-monospace, Menlo, monospace'
        ctx.fillText('·', x, y + rowH / 2)
        ctx.font = '15px ui-monospace, Menlo, monospace'
      }
    }
  }

  drawRow(rowsTop, '你', INK, null)
  s.echoes.forEach((e, i) => {
    drawRow(rowsTop + (i + 1) * rowH, e.color, colorOf(e.color), e.delay)
  })
}

// ---------- 局部绘制辅助 ----------

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

/** 预演 ghost 棋子：虚线描边 + 低透明度填充，标记「尚未发生」 */
function ghostPiece(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cell: number,
  color: string,
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.setLineDash([5, 4])
  ctx.globalAlpha = 0.85
  const inset = cell * 0.18
  ctx.beginPath()
  ctx.roundRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2, cell * 0.16)
  ctx.stroke()
  ctx.globalAlpha = 0.14
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

/** 当前位置 → ghost 位置的移动箭头（起止都缩短一截，避免压住棋子） */
function moveArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cell: number,
  color: string,
): void {
  const cx1 = x1 + cell / 2
  const cy1 = y1 + cell / 2
  const cx2 = x2 + cell / 2
  const cy2 = y2 + cell / 2
  const dx = cx2 - cx1
  const dy = cy2 - cy1
  const len = Math.hypot(dx, dy)
  if (len < cell * 0.4) return // 原地（被挡）不画
  const ux = dx / len
  const uy = dy / len
  const sx = cx1 + ux * cell * 0.34
  const sy = cy1 + uy * cell * 0.34
  const ex = cx2 - ux * cell * 0.36
  const ey = cy2 - uy * cell * 0.36
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.globalAlpha = 0.6
  ctx.lineWidth = 2
  line(ctx, sx, sy, ex, ey)
  const head = Math.max(5, cell * 0.12)
  const angle = Math.atan2(ey - sy, ex - sx)
  ctx.beginPath()
  ctx.moveTo(ex, ey)
  ctx.lineTo(ex - head * Math.cos(angle - 0.5), ey - head * Math.sin(angle - 0.5))
  ctx.lineTo(ex - head * Math.cos(angle + 0.5), ey - head * Math.sin(angle + 0.5))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** 回声下一步动作 chip：棋子右上角的小箭头牌 */
function nextChip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cell: number,
  dir: Dir,
  color: string,
): void {
  const w = Math.max(18, cell * 0.34)
  const h = Math.max(14, cell * 0.28)
  const cx = x + cell - w / 2 - 1
  const cy = y + h / 2 + 1
  ctx.save()
  ctx.fillStyle = BG
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 4)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = color
  ctx.font = `${Math.max(11, Math.floor(cell * 0.22))}px ui-monospace, Menlo, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(DIR_ARROW[dir], cx, cy)
  ctx.restore()
}
