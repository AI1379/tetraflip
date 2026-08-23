import { DIR_VEC, opposite } from '../../core/protocol'
import type { Dir } from '../../core/protocol'
import { Tweens, easeInOutQuad, easeOutCubic } from '../../core/tween'
import { stateKey } from './engine'
import type { ChemState } from './engine'
import type { CenterKind } from './level'

/**
 * 《109.5°》渲染（design §10 轻包装：化学味、零美术素材、全程序化 Canvas）。
 *
 * - 中心画成分子骨架风格：细键线 + 原子点（中心原子 + 臂原子）；三元中心为三角骨架。
 * - 开口以「朝外的白色箭头」标记（指向进攻方向；iteration #6 起，取代旧白圈——白圈被试玩反馈误认为 UI bug）。
 * - 相邻中心画「共轭键」：面对臂同色时点亮（共振可传导），否则暗色（v2 玩法信息）。
 * - v3 特殊格：光照格（金色放射纹）/ 回收格（下箭头井口）/ 脱保护格（打开的锁）/ 弹射台（双箭头）；
 *   保护罩中心画六边形罩；分步目标当前段正常虚线圈、未来段淡圈预告；HUD 显示标准杆与段数。
 * - 背景：极低透明度的四面体线框（标题《109.5°》的几何本体，纯装饰，缓慢自转）。
 * - 手感：行走补间、翻转旋转动画（连锁时按传播距离阶梯延迟；三元中心为沿弧轮换动画）、
 *   无效进攻抖动 + 撞面红闪；已达标中心画锁定圈 + ✓ 徽标。
 * - 动画状态是渲染层私有时钟（只读游戏状态、绝不改状态）；状态转移由 stateKey 变化驱动。
 * - 纪律：装饰不压缩棋盘（布局常量与无装饰时完全一致）；
 *   `setChemDecor(false)` 可整体关掉装饰（玩法信息——开口箭头/目标虚线/共轭键/锁定徽标/特殊格——永远保留）。
 * - 全程不出现化学术语/化学式文字。
 */

const COLORS: Record<string, string> = {
  red: '#e5484d',
  blue: '#4f8ef7',
  green: '#46a758',
  yellow: '#e0b64f',
  purple: '#a06cd5',
}
const colorOf = (name: string): string => COLORS[name] ?? '#a06cd5'
const INK = '#f2f4f8'
const BOND = '#55617a' // 键线
const FAINT = '#39424f' // 墙 / 刻度 / 角框
const TETRA = '#4f8ef7' // 背景四面体线框
const FLASH = '#e5484d' // 无效进攻红闪

const FLIP_MS = 260 // 翻转旋转动画时长
const WALK_MS = 110 // 行走补间时长
const SHAKE_MS = 240 // 无效进攻抖动时长
const HOP_MS = 90 // 共振连锁：每传播一级的动画延迟
const ARM_LEN = 1 // 普通臂长（格）
const ARM_LEN_SHORT = 0.42 // 相邻中心侧的缩短臂长（避免压到邻居中心）
const TETRA_SPIN = 0.00012 // 背景四面体自转（rad/ms）

let decor = true

/** 装饰开关（design §10：包装可用一个开关整体关掉）。只关装饰，不关玩法信息。 */
export function setChemDecor(v: boolean): void {
  decor = v
}

// ---------- 渲染层私有动画状态（不进游戏状态，撤销/重开由 stateKey 大跳检测兜底） ----------

interface FlipAnim {
  start: number
  /** tetra：起始臂面 = swap(新臂)，旋转 π 后恰好落到新臂面；trigonal：旋转前的旧臂面（沿弧滑向新位） */
  arms: Partial<Record<Dir, string>>
  leaving: Dir
  kind: CenterKind
}

let lastKey = ''
let lastState: ChemState | null = null
let lastDims = ''
let walk = new Tweens()
const flips = new Map<number, FlipAnim>()
let shake: { start: number; dir: Dir } | null = null
let handPulse: { start: number; color: string | null } | null = null

/** 无效进攻 / 撞墙反馈入口：shell 在 step 无效果（stateKey 不变）时调用 */
export function notifyChemImpact(dir: Dir): void {
  shake = { start: performance.now(), dir }
}

const swapArms = (arms: Record<Dir, string>): Record<Dir, string> => ({
  N: arms.S,
  S: arms.N,
  E: arms.W,
  W: arms.E,
})

/** 臂方向的基准角（屏幕坐标系，N 朝上） */
const ARM_ANGLE: Record<Dir, number> = { N: -Math.PI / 2, E: 0, S: Math.PI / 2, W: Math.PI }

/** 由 stateKey 变化驱动动画：行走补间、翻转时钟、手持脉冲；大跳（重开/换关）则全部重置 */
function sync(s: ChemState, now: number): void {
  const dims = `${s.width}x${s.height}`
  if (dims !== lastDims) {
    lastDims = dims
    lastState = null
    lastKey = ''
    walk = new Tweens()
    flips.clear()
    shake = null
    handPulse = null
  }
  const key = stateKey(s)
  if (lastState && key !== lastKey) {
    const prev = lastState
    const dist =
      Math.abs(s.player[0] - prev.player[0]) + Math.abs(s.player[1] - prev.player[1])
    if (Math.abs(s.moves - prev.moves) === 1 && dist <= 1) {
      if (s.player[0] !== prev.player[0] || s.player[1] !== prev.player[1]) {
        walk.set('px', s.player[0], now, WALK_MS)
        walk.set('py', s.player[1], now, WALK_MS)
      }
      const changed = s.centers
        .map((c, i) => i)
        .filter((i) => {
          const p = prev.centers[i]
          const c = s.centers[i]
          // 只给「臂面变化」的中心播翻转动画；仅开口变化（光照格转轴）不播（不是翻转）
          return p !== undefined && p.arms !== c.arms
        })
      if (changed.length > 0) {
        // 共振连锁阶梯动画：从被进攻的中心（玩家相邻、臂有变化者）出发，
        // 按相邻关系 BFS 出传播距离，每级延迟 HOP_MS。顺序只影响观感。
        const hop = new Map<number, number>()
        const root = changed.find((i) => {
          const c = s.centers[i]
          return (
            Math.abs(c.pos[0] - s.player[0]) + Math.abs(c.pos[1] - s.player[1]) === 1
          )
        })
        if (root !== undefined) {
          hop.set(root, 0)
          const q = [root]
          while (q.length > 0) {
            const x = q.shift()!
            for (const y of changed) {
              if (hop.has(y)) continue
              const a = s.centers[x]
              const b = s.centers[y]
              if (Math.abs(a.pos[0] - b.pos[0]) + Math.abs(a.pos[1] - b.pos[1]) === 1) {
                hop.set(y, hop.get(x)! + 1)
                q.push(y)
              }
            }
          }
        }
        for (const i of changed) {
          const kind = s.centers[i].kind
          flips.set(i, {
            start: now + (hop.get(i) ?? 0) * HOP_MS,
            // tetra：swap 是旋转 π 的中间态起点；trigonal：直接用旧臂面沿弧滑过去
            arms:
              kind === 'trigonal'
                ? { ...prev.centers[i].arms }
                : swapArms(s.centers[i].arms as Record<Dir, string>),
            leaving: prev.centers[i].leaving,
            kind,
          })
        }
      }
      if (s.holding !== prev.holding) handPulse = { start: now, color: s.holding }
    } else {
      walk = new Tweens()
      flips.clear()
      handPulse = null
    }
  }
  lastState = s
  lastKey = key
}

export function render(s: ChemState, ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const now = performance.now()
  sync(s, now)
  const pad = 16
  const stripH = 40
  const cell = Math.floor(Math.min((W - pad * 2) / s.width, (H - pad * 2 - stripH) / s.height))
  const ox = Math.floor((W - cell * s.width) / 2)
  const oy = Math.floor((H - stripH - cell * s.height) / 2)
  const cx = (x: number): number => ox + x * cell + cell / 2
  const cy = (y: number): number => oy + y * cell + cell / 2

  ctx.fillStyle = '#0e1116'
  ctx.fillRect(0, 0, W, H)

  if (decor) {
    drawBackdrop(ctx, W, H, now)
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

  drawSpecialCells(ctx, s, cx, cy, cell, now)

  // 相邻中心关系（共轭）：每个中心各方向是否有相邻中心
  const neighborIdx = (i: number, d: Dir): number => {
    const c = s.centers[i]
    const [dx, dy] = DIR_VEC[d]
    return s.centers.findIndex((o) => o.pos[0] === c.pos[0] + dx && o.pos[1] === c.pos[1] + dy)
  }
  const neighborsOf = (i: number): Record<Dir, boolean> => ({
    N: neighborIdx(i, 'N') >= 0,
    E: neighborIdx(i, 'E') >= 0,
    S: neighborIdx(i, 'S') >= 0,
    W: neighborIdx(i, 'W') >= 0,
  })

  // 目标（虚线圈）：当前段正常显示，未来段淡圈预告（分步目标，v3）。
  // 臂若朝向相邻中心，圈画在两中心之间的半程位置（避让邻居）。
  const drawGoal = (g: { center: number; arm: Dir; color: string }, alpha: number): void => {
    const c = s.centers[g.center]
    if (neighborIdx(g.center, g.arm) >= 0) {
      const [dx, dy] = DIR_VEC[g.arm]
      dashedCircle(
        ctx,
        cx(c.pos[0]) + dx * cell * 0.5,
        cy(c.pos[1]) + dy * cell * 0.5,
        cell * 0.2,
        colorOf(g.color),
        alpha,
      )
    } else {
      const [gx, gy] = armCell(c.pos, g.arm)
      dashedCircle(ctx, cx(gx), cy(gy), cell * 0.34, colorOf(g.color), alpha)
    }
  }
  s.stages.forEach((st, si) => {
    if (si < s.stage) return // 已完成的段不再显示
    const alpha = si === s.stage ? 0.85 : 0.22
    for (const g of st.goals) drawGoal(g, alpha)
  })

  // 共轭键（v2）：相邻中心之间的连接。面对臂同色 = 点亮（共振可传导）；否则暗色。
  for (let i = 0; i < s.centers.length; i++) {
    for (const d of ['N', 'E', 'S', 'W'] as const) {
      const j = neighborIdx(i, d)
      if (j < 0 || j <= i) continue // 每对只画一次
      const ci = s.centers[i]
      const cj = s.centers[j]
      const fi = ci.arms[d]
      const fj = cj.arms[opposite(d)]
      if (fi === undefined || fj === undefined) continue // 三元中心没有该臂：不连
      const [dx, dy] = DIR_VEC[d]
      const x1 = cx(ci.pos[0]) + dx * cell * ARM_LEN_SHORT
      const y1 = cy(ci.pos[1]) + dy * cell * ARM_LEN_SHORT
      const x2 = cx(cj.pos[0]) - dx * cell * ARM_LEN_SHORT
      const y2 = cy(cj.pos[1]) - dy * cell * ARM_LEN_SHORT
      const live = fi === fj
      ctx.save()
      if (live) {
        ctx.strokeStyle = INK
        ctx.globalAlpha = 0.55 + 0.25 * Math.sin(now / 260)
        ctx.lineWidth = Math.max(2, cell * 0.09)
      } else {
        ctx.strokeStyle = BOND
        ctx.globalAlpha = 0.5
        ctx.lineWidth = Math.max(1.5, cell * 0.05)
      }
      line(ctx, x1, y1, x2, y2)
      ctx.restore()
    }
  }

  // 游离色珠（v1 基团搬运）：小原子点 + 虚线外圈（拾取物标记）
  for (const g of s.groups) {
    const gx = cx(g.pos[0])
    const gy = cy(g.pos[1])
    dashedCircle(ctx, gx, gy, cell * 0.26, colorOf(g.color))
    ctx.fillStyle = colorOf(g.color)
    ctx.beginPath()
    ctx.arc(gx, gy, cell * 0.15, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
    ctx.lineWidth = Math.max(1, cell * 0.03)
    ctx.stroke()
  }

  // 中心与臂（翻转中：tetra 整个骨架旋转 0→π；trigonal 各臂沿弧滑向下一臂位）
  for (let i = 0; i < s.centers.length; i++) {
    const c = s.centers[i]
    const px = cx(c.pos[0])
    const py = cy(c.pos[1])
    const flip = flips.get(i)
    let rot = 0
    let arms = c.arms
    let leaving = c.leaving
    let armRot: Partial<Record<Dir, number>> | undefined
    if (flip) {
      const t = (now - flip.start) / FLIP_MS
      if (t >= 1) {
        flips.delete(i)
      } else if (flip.kind === 'trigonal') {
        // 三臂轮换：内容 N→E→S→N，各臂沿弧滑过去（N/E 滑 90°，S 绕远路滑 180°）
        const e = easeInOutQuad(Math.max(0, t))
        arms = flip.arms
        leaving = flip.leaving
        armRot = { N: (Math.PI / 2) * e, E: (Math.PI / 2) * e, S: Math.PI * e }
      } else {
        rot = Math.PI * easeInOutQuad(Math.max(0, t))
        arms = flip.arms
        leaving = flip.leaving
      }
    }
    drawCenter(ctx, px, py, cell, arms, leaving, rot, neighborsOf(i), c.kind, armRot)

    // 保护罩（v3）：六边形罩 + 微填充；脱保护后消失
    if (c.shielded && !s.deprotected) {
      ctx.save()
      ctx.strokeStyle = INK
      ctx.globalAlpha = 0.55
      ctx.lineWidth = 2
      ctx.beginPath()
      for (let k = 0; k < 6; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 3
        const hx = px + Math.cos(a) * cell * 0.54
        const hy = py + Math.sin(a) * cell * 0.54
        if (k === 0) ctx.moveTo(hx, hy)
        else ctx.lineTo(hx, hy)
      }
      ctx.closePath()
      ctx.stroke()
      ctx.globalAlpha = 0.06
      ctx.fillStyle = INK
      ctx.fill()
      ctx.restore()
    }

    // 已达标锁定圈 + ✓ 徽标（当前段中该中心的所有目标均已满足且至少有一个）
    const activeGoals =
      s.stage < s.stages.length
        ? s.stages[s.stage].goals.filter((g) => g.center === i)
        : []
    if (activeGoals.length > 0 && activeGoals.every((g) => c.arms[g.arm] === g.color)) {
      ctx.save()
      ctx.strokeStyle = INK
      ctx.globalAlpha = 0.4
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(px, py, cell * 0.46, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
      const r = cell * 0.13
      const bx = px + cell * 0.42
      const by = py - cell * 0.42
      ctx.fillStyle = INK
      ctx.beginPath()
      ctx.arc(bx, by, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#0e1116'
      ctx.lineWidth = Math.max(1.5, r * 0.28)
      ctx.beginPath()
      ctx.moveTo(bx - r * 0.45, by + r * 0.05)
      ctx.lineTo(bx - r * 0.12, by + r * 0.4)
      ctx.lineTo(bx + r * 0.5, by - r * 0.35)
      ctx.stroke()
    }

    // 无效进攻红闪：撞面短弧（仅当撞的是中心）
    if (shake && lastState) {
      const age = now - shake.start
      if (age < SHAKE_MS) {
        const [dx, dy] = DIR_VEC[shake.dir]
        const target = lastState.centers.find(
          (cc) => cc.pos[0] === lastState!.player[0] + dx && cc.pos[1] === lastState!.player[1] + dy,
        )
        if (target && target.pos[0] === c.pos[0] && target.pos[1] === c.pos[1]) {
          const a = ARM_ANGLE[opposite(shake.dir)]
          ctx.save()
          ctx.strokeStyle = FLASH
          ctx.globalAlpha = 1 - age / SHAKE_MS
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.arc(px, py, cell * 0.44, a - 0.55, a + 0.55)
          ctx.stroke()
          ctx.restore()
        }
      }
    }
  }

  // 玩家（最后画）：行走补间 + 无效进攻抖动 + 手持色珠
  let px = walk.value('px', now)
  let py = walk.value('py', now)
  if (Number.isNaN(px)) px = s.player[0]
  if (Number.isNaN(py)) py = s.player[1]
  let sx = cx(px)
  let sy = cy(py)
  if (shake) {
    const age = now - shake.start
    if (age < SHAKE_MS) {
      const t = age / SHAKE_MS
      const amp = (1 - easeOutCubic(t)) * cell * 0.12
      const [dx, dy] = DIR_VEC[shake.dir]
      const off = amp * Math.sin(t * Math.PI * 4)
      sx += dx * off
      sy += dy * off
    } else {
      shake = null
    }
  }
  if (decor) {
    ctx.save()
    ctx.strokeStyle = INK
    ctx.globalAlpha = 0.22
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(sx, sy, cell * 0.36, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
  ctx.fillStyle = INK
  ctx.beginPath()
  ctx.arc(sx, sy, cell * 0.28, 0, Math.PI * 2)
  ctx.fill()

  // 手持色珠：玩家右上角小原子 + 键线；拾取/换手时脉冲扩散
  if (s.holding !== null) {
    const hx = sx + cell * 0.3
    const hy = sy - cell * 0.3
    ctx.strokeStyle = BOND
    ctx.lineWidth = Math.max(1, cell * 0.04)
    line(ctx, sx + cell * 0.14, sy - cell * 0.14, hx, hy)
    ctx.fillStyle = colorOf(s.holding)
    ctx.beginPath()
    ctx.arc(hx, hy, cell * 0.12, 0, Math.PI * 2)
    ctx.fill()
  }
  if (handPulse) {
    const age = now - handPulse.start
    if (age < 220 && handPulse.color !== null) {
      const t = age / 220
      ctx.save()
      ctx.strokeStyle = colorOf(handPulse.color)
      ctx.globalAlpha = 1 - t
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(sx + cell * 0.3, sy - cell * 0.3, cell * (0.14 + t * 0.22), 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    } else if (age >= 220) {
      handPulse = null
    }
  }

  drawStrip(ctx, s, ox, s.width * cell, oy + s.height * cell, cell)
}

/**
 * 中心分子骨架：键线 + 臂原子 + 开口箭头。rot=0 且无 armRot 时与静态布局完全一致。
 * 朝向相邻中心的臂缩短（避免压到邻居），开口以朝外的白色箭头标记进攻方向。
 * trigonal：只有 N/E/S 三臂，中心原子画成小三角（三元中心一眼可辨）。
 */
function drawCenter(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cell: number,
  arms: Partial<Record<Dir, string>>,
  leaving: Dir,
  rot: number,
  neighbors: Record<Dir, boolean>,
  kind: CenterKind,
  armRot?: Partial<Record<Dir, number>>,
): void {
  const dirs = kind === 'trigonal' ? (['N', 'E', 'S'] as const) : (['N', 'E', 'S', 'W'] as const)
  const armLen = (arm: Dir): number => (neighbors[arm] ? ARM_LEN_SHORT : ARM_LEN)
  const armPos = (arm: Dir): [number, number] => {
    const a = ARM_ANGLE[arm] + rot + (armRot?.[arm] ?? 0)
    const len = armLen(arm) * cell
    return [px + Math.cos(a) * len, py + Math.sin(a) * len]
  }

  // 键线（先画线，原子点压在线端上）
  ctx.strokeStyle = BOND
  ctx.lineWidth = Math.max(1.5, cell * 0.05)
  for (const arm of dirs) {
    const [ax, ay] = armPos(arm)
    line(ctx, px, py, ax, ay)
  }

  // 臂原子
  for (const arm of dirs) {
    const color = arms[arm]
    if (!color) continue
    const [ax, ay] = armPos(arm)
    const r = neighbors[arm] ? cell * 0.15 : cell * 0.22
    ctx.fillStyle = colorOf(color)
    ctx.beginPath()
    ctx.arc(ax, ay, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
    ctx.lineWidth = Math.max(1, cell * 0.03)
    ctx.stroke()

    // 开口臂：朝外的白色箭头 = 进攻方向（玩法信息，永远保留；随骨架一起旋转/滑动）
    if (arm === leaving) {
      const a = ARM_ANGLE[arm] + rot + (armRot?.[arm] ?? 0)
      const tipLen = (neighbors[arm] ? ARM_LEN_SHORT + 0.3 : 1.42) * cell
      const tipX = px + Math.cos(a) * tipLen
      const tipY = py + Math.sin(a) * tipLen
      arrow(ctx, px, py, tipX, tipY, cell)
    }
  }

  // 中心原子（三元中心画三角）
  ctx.fillStyle = FAINT
  ctx.strokeStyle = '#8b95a5'
  ctx.lineWidth = 1
  if (kind === 'trigonal') {
    ctx.beginPath()
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + rot + (k * 2 * Math.PI) / 3
      const tx = px + Math.cos(a) * cell * 0.16
      const ty = py + Math.sin(a) * cell * 0.16
      if (k === 0) ctx.moveTo(tx, ty)
      else ctx.lineTo(tx, ty)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.arc(px, py, cell * 0.13, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}

/** 底部 HUD：刻度尺 + 读数（步数 / 标准杆 / 段数 / 手持 / 开口方向） */
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
  const holdingText = s.holding ?? '—'
  const parText = s.par !== undefined ? ` │ 标准杆 ${String(s.par).padStart(3, '0')}` : ''
  const stageText =
    s.stages.length > 1 ? ` │ 段 ${Math.min(s.stage + 1, s.stages.length)}/${s.stages.length}` : ''
  ctx.fillText(
    `步数 ${String(s.moves).padStart(3, '0')}${parText}${stageText} │ 手持 ${holdingText} │ 开口 ${leavingText} · 从开口的对面撞入`,
    x0,
    yTop + 26,
  )
  // 胜利后按标准杆评星（纯展示）
  if (s.won && s.par !== undefined) {
    const stars = s.moves <= s.par ? '★★★' : s.moves <= s.par + 3 ? '★★☆' : '★☆☆'
    ctx.fillStyle = '#e0b64f'
    ctx.fillText(`${stars} 完成`, x0 + width - ctx.measureText(`${stars} 完成`).width, yTop + 26)
  }
}

/** v3 特殊格：光照（金色放射纹）/ 回收（井口下箭头）/ 脱保护（开锁）/ 弹射台（双箭头） */
function drawSpecialCells(
  ctx: CanvasRenderingContext2D,
  s: ChemState,
  cx: (x: number) => number,
  cy: (y: number) => number,
  cell: number,
  now: number,
): void {
  // 光照格：中心点 + 八条放射线（缓慢呼吸）
  for (const [x, y] of s.lights) {
    const px = cx(x)
    const py = cy(y)
    ctx.save()
    ctx.strokeStyle = '#e0b64f'
    ctx.fillStyle = '#e0b64f'
    ctx.globalAlpha = 0.55 + 0.2 * Math.sin(now / 500)
    ctx.lineWidth = Math.max(1.5, cell * 0.04)
    ctx.beginPath()
    ctx.arc(px, py, cell * 0.1, 0, Math.PI * 2)
    ctx.fill()
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4 + Math.PI / 8
      line(
        ctx,
        px + Math.cos(a) * cell * 0.18,
        py + Math.sin(a) * cell * 0.18,
        px + Math.cos(a) * cell * 0.32,
        py + Math.sin(a) * cell * 0.32,
      )
    }
    ctx.restore()
  }
  // 回收格：虚线圈 + 向下箭头（东西放进去就没了）
  for (const [x, y] of s.disposals) {
    const px = cx(x)
    const py = cy(y)
    dashedCircle(ctx, px, py, cell * 0.32, BOND, 0.9)
    ctx.save()
    ctx.strokeStyle = INK
    ctx.globalAlpha = 0.6
    ctx.lineWidth = Math.max(1.5, cell * 0.05)
    line(ctx, px, py - cell * 0.16, px, py + cell * 0.12)
    ctx.beginPath()
    ctx.moveTo(px - cell * 0.1, py + cell * 0.02)
    ctx.lineTo(px, py + cell * 0.16)
    ctx.lineTo(px + cell * 0.1, py + cell * 0.02)
    ctx.stroke()
    ctx.restore()
  }
  // 脱保护格：打开的锁（锁体 + 掀开的锁环）
  for (const [x, y] of s.deprotections) {
    const px = cx(x)
    const py = cy(y)
    ctx.save()
    ctx.strokeStyle = '#46a758'
    ctx.globalAlpha = 0.85
    ctx.lineWidth = Math.max(1.5, cell * 0.05)
    ctx.strokeRect(px - cell * 0.16, py - cell * 0.02, cell * 0.32, cell * 0.24)
    ctx.beginPath()
    ctx.arc(px - cell * 0.02, py - cell * 0.12, cell * 0.13, Math.PI, Math.PI * 1.9)
    ctx.stroke()
    ctx.restore()
  }
  // 弹射台：指向台面方向的双箭头
  for (const l of s.launchers) {
    const px = cx(l.pos[0])
    const py = cy(l.pos[1])
    const [dx, dy] = DIR_VEC[l.dir]
    ctx.save()
    ctx.strokeStyle = INK
    ctx.globalAlpha = 0.7
    ctx.lineWidth = Math.max(1.5, cell * 0.055)
    for (const off of [-0.12, 0.08]) {
      const bx = px + dx * cell * off
      const by = py + dy * cell * off
      // 「>」形箭头：两条斜线汇向方向
      const pxp = -dy // 垂直方向单位
      const pyp = dx
      ctx.beginPath()
      ctx.moveTo(bx - dx * cell * 0.12 + pxp * cell * 0.14, by - dy * cell * 0.12 + pyp * cell * 0.14)
      ctx.lineTo(bx + dx * cell * 0.06, by + dy * cell * 0.06)
      ctx.lineTo(bx - dx * cell * 0.12 - pxp * cell * 0.14, by - dy * cell * 0.12 - pyp * cell * 0.14)
      ctx.stroke()
    }
    ctx.restore()
  }
}

/** 背景：极低透明度的四面体线框（《109.5°》的几何本体），缓慢自转 */
function drawBackdrop(ctx: CanvasRenderingContext2D, W: number, H: number, now: number): void {
  const t = now * TETRA_SPIN
  tetra(ctx, W * 0.16, H * 0.2, W * 0.15, 0.55 + t, 0.4, 0.06)
  tetra(ctx, W * 0.86, H * 0.28, W * 0.11, -0.3 - t * 0.7, 0.7, 0.05)
  tetra(ctx, W * 0.22, H * 0.86, W * 0.13, 0.9 + t * 0.5, -0.35, 0.05)
  tetra(ctx, W * 0.84, H * 0.82, W * 0.16, 0.2 + t * 0.3, 0.95, 0.045)
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
  alpha = 0.85,
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.globalAlpha = alpha
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
