import { DIRS, DIR_VEC, cellKey, opposite } from '../core/protocol'
import type { Dir } from '../core/protocol'
import { getEjectionPreview, isShielded } from '../games/chem/engine'
import type { ChemState } from '../games/chem/engine'

/**
 * 01–05 的壳层操作引导。
 *
 * 只从当前 ChemState 推导眼前可见的操作与交换结果，不调用 solver、不写多步解法，
 * 因此它是 UI 解释层而不是另一套玩法规则。
 */

export type TutorialEvent =
  | { kind: 'blocked'; dir: Dir }
  | { kind: 'preview'; dir: Dir }
  | null

export type TutorialInputMode = 'keyboard' | 'touch'

export interface TutorialInputCapabilities {
  coarsePrimaryPointer: boolean
  maxTouchPoints: number
}

export interface TutorialForecast {
  center: number
  dir: Dir
  injected: string
  extracted: string | null
  landingArm: Dir
  showExtraction: boolean
}

export interface TutorialSpotlight {
  /** 棋盘格坐标；允许 .5，供相邻中心之间的共振键使用。 */
  pos: readonly [number, number]
  radiusCells: number
}

export interface TutorialGesture {
  from: readonly [number, number]
  dir: Dir
  distanceCells: number
  /** 到达方向后继续保持，不立即松开执行。 */
  hold?: boolean
}

export interface TutorialModel {
  kicker: string
  title: string
  body: string
  tip: string
  focusDirs: readonly Dir[]
  forecast: TutorialForecast | null
  feedback: string | null
  feedbackTone: 'info' | 'warning'
  /** 这一拍只做对象辨认；轻触棋盘或方向输入推进讲解，不执行游戏动作。 */
  advanceOnTap?: boolean
  /** 棋盘外的具体操作按钮；壳层负责高亮，模型不读取 DOM。 */
  controlTarget?: 'hint'
  spotlight?: TutorialSpotlight
  gesture?: TutorialGesture
}

interface ImmediateAttack {
  center: number
  dir: Dir
  extracted: string | null
}

const COLOR_TEXT: Record<string, string> = {
  red: '红',
  blue: '蓝',
  green: '绿',
  yellow: '黄',
  purple: '紫',
}

const DIR_TEXT: Record<Dir, string> = { N: '上', E: '右', S: '下', W: '左' }
const DIR_KEY: Record<Dir, string> = { N: 'W', E: 'D', S: 'S', W: 'A' }

export const tutorialColorText = (color: string): string => COLOR_TEXT[color] ?? color
export const tutorialDirText = (dir: Dir): string => DIR_TEXT[dir]
export const tutorialKeyForDir = (dir: Dir): string => DIR_KEY[dir]

/**
 * 首屏只做输入能力预判，不猜测设备身份。真实输入会通过
 * tutorialInputModeFromPointerType / 方向键事件立即覆盖它。
 */
export function initialTutorialInputMode(capabilities: TutorialInputCapabilities): TutorialInputMode {
  return capabilities.coarsePrimaryPointer && capabilities.maxTouchPoints > 0 ? 'touch' : 'keyboard'
}

export function tutorialInputModeFromPointerType(pointerType: string): TutorialInputMode | null {
  if (pointerType === 'touch' || pointerType === 'pen') return 'touch'
  if (pointerType === 'mouse') return 'keyboard'
  return null
}

function adjacentGroupDirs(state: ChemState): Dir[] {
  return DIRS.filter((dir) => {
    const [dx, dy] = DIR_VEC[dir]
    const x = state.player[0] + dx
    const y = state.player[1] + dy
    return state.groups.some((group) => group.pos[0] === x && group.pos[1] === y)
  })
}

/** 只给对象教学找“下一格怎么靠近”，不搜索关卡目标或机制解法。 */
function nextDirToward(state: ChemState, target: readonly [number, number]): Dir | undefined {
  const startKey = cellKey(state.player[0], state.player[1])
  const blocked = new Set(state.walls)
  for (const center of state.centers) blocked.add(cellKey(center.pos[0], center.pos[1]))
  const seen = new Set([startKey])
  const queue: { pos: readonly [number, number]; first?: Dir }[] = [{ pos: state.player }]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.pos[0] === target[0] && current.pos[1] === target[1]) return current.first
    for (const dir of DIRS) {
      const [dx, dy] = DIR_VEC[dir]
      const x = current.pos[0] + dx
      const y = current.pos[1] + dy
      const key = cellKey(x, y)
      if (x < 0 || y < 0 || x >= state.width || y >= state.height || blocked.has(key) || seen.has(key)) continue
      seen.add(key)
      queue.push({ pos: [x, y], first: current.first ?? dir })
    }
  }
  return undefined
}

function immediateAttack(state: ChemState): ImmediateAttack | null {
  for (const dir of DIRS) {
    const [dx, dy] = DIR_VEC[dir]
    const x = state.player[0] + dx
    const y = state.player[1] + dy
    const center = state.centers.findIndex((candidate) => candidate.pos[0] === x && candidate.pos[1] === y)
    if (center < 0) continue
    const target = state.centers[center]
    if (target.leaving !== dir || isShielded(state, target)) continue
    return { center, dir, extracted: target.arms[dir] ?? null }
  }
  return null
}

function exchangeForecast(
  state: ChemState,
  showExtraction: boolean,
): TutorialForecast | null {
  if (state.holding === null) return null
  const attack = immediateAttack(state)
  if (!attack) return null
  return {
    center: attack.center,
    dir: attack.dir,
    injected: state.holding,
    extracted: attack.extracted,
    landingArm: opposite(attack.dir),
    showExtraction,
  }
}

function feedbackFor(state: ChemState, event: TutorialEvent): Pick<TutorialModel, 'feedback' | 'feedbackTone'> {
  if (event?.kind === 'preview') {
    return {
      feedback: '预演中：虚线轮廓是松开后将发生的结果；回到原位或按 Esc 可以取消。',
      feedbackTone: 'info',
    }
  }
  if (event?.kind !== 'blocked') return { feedback: null, feedbackTone: 'info' }

  const [dx, dy] = DIR_VEC[event.dir]
  const x = state.player[0] + dx
  const y = state.player[1] + dy
  let reason = '这一步没有改变局面，也不会计入行动。换个方向试试。'
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    reason = '撞到棋盘边界了：这一步没有消耗行动，可以直接换个方向。'
  } else if (state.walls.includes(cellKey(x, y))) {
    reason = '这边被墙挡住了：这一步没有消耗行动，可以直接换个方向。'
  } else {
    const center = state.centers.find((candidate) => candidate.pos[0] === x && candidate.pos[1] === y)
    if (center && center.leaving !== event.dir) {
      reason = '刚才撞到了封闭面：白箭头指向可进攻方向，先绕到它的反面再沿箭头撞入。'
    } else if (center) {
      reason = '这个中心当前不能被进攻：留意护罩或喷口是否受阻。'
    }
  }
  return { feedback: reason, feedbackTone: 'warning' }
}

function model(
  levelIndex: number,
  state: ChemState,
  event: TutorialEvent,
  content: Omit<TutorialModel, 'kicker' | 'feedback' | 'feedbackTone'>,
): TutorialModel {
  return {
    kicker: levelIndex <= 4
      ? `CORE INPUT · ${String(levelIndex + 1).padStart(2, '0')} / 05`
      : `MECHANIC REVEAL · LEVEL ${String(levelIndex + 1).padStart(2, '0')}`,
    ...content,
    ...feedbackFor(state, event),
  }
}

interface RevealPage {
  title: string
  body: string
  spotlight: TutorialSpotlight
  tip?: string
}

function pointOnArm(
  state: ChemState,
  centerIndex: number,
  dir: Dir,
  distance = 0.46,
): readonly [number, number] {
  const center = state.centers[centerIndex]
  const [dx, dy] = DIR_VEC[dir]
  return [center.pos[0] + dx * distance, center.pos[1] + dy * distance]
}

function revealModel(
  levelIndex: number,
  state: ChemState,
  event: TutorialEvent,
  page: RevealPage,
  step: number,
  total: number,
  label: string,
): TutorialModel {
  const reveal = model(levelIndex, state, event, {
    title: page.title,
    body: page.body,
    tip: page.tip ?? '点击或轻触棋盘任意位置继续',
    focusDirs: [],
    forecast: null,
    advanceOnTap: true,
    spotlight: page.spotlight,
  })
  return {
    ...reveal,
    kicker: `${label} · ${String(step).padStart(2, '0')} / ${String(total).padStart(2, '0')}`,
  }
}

function actionKicker(guide: TutorialModel, label: string, total: number): TutorialModel {
  const n = String(total).padStart(2, '0')
  return { ...guide, kicker: `${label} · ${n} / ${n}` }
}

/** 01–05 操作引导 + 后续机制首现揭示；通关态立即让位给真实棋盘动画。 */
export function getChemTutorial(
  levelIndex: number,
  state: ChemState,
  event: TutorialEvent,
  inputMode: TutorialInputMode = 'touch',
  introBeat = 0,
): TutorialModel | null {
  if (state.won) return null

  // 后续机制先逐物解释，最后一拍才开放真实输入；玩家开始行动后自动让位。
  if (state.moves === 0) {
    if (levelIndex === 9) {
      const pages: RevealPage[] = [
        {
          title: '这是两个中心之间的共振键',
          body: '相邻中心彼此面对的两条臂颜色不同时，键是暗的，翻转不会从这里传过去。',
          spotlight: { pos: [2.5, 2], radiusCells: 0.44 },
        },
        {
          title: '先看左侧中心的蓝珠',
          body: '它现在位于左臂。左侧中心翻转后，这颗蓝珠会来到右臂，正对另一座中心。',
          spotlight: { pos: pointOnArm(state, 0, 'W'), radiusCells: 0.32 },
        },
        {
          title: '右侧中心也有一颗面对的蓝珠',
          body: '两颗面对珠同色时，暗键会变亮。共振只沿动作结算时真正亮起的键传播。',
          spotlight: { pos: pointOnArm(state, 1, 'W', 0.34), radiusCells: 0.3 },
        },
        {
          title: '亮键会把翻转传给下一座中心',
          body: '左侧中心先翻转并接通亮键，右侧中心随后也翻转；它再按翻转后的构型检查下一跳。',
          spotlight: { pos: state.centers[1].pos, radiusCells: 0.84 },
        },
      ]
      if (introBeat < pages.length) {
        return revealModel(levelIndex, state, event, pages[introBeat], introBeat + 1, 5, 'RESONANCE')
      }
      const attack = immediateAttack(state)
      return actionKicker(model(levelIndex, state, event, {
        title: '现在撞动左侧中心',
        body: '这一次先预测：左侧翻转、键变亮、右侧跟着翻转。然后再执行。',
        tip: '按住可以先看完整连锁；松开执行',
        focusDirs: attack ? [attack.dir] : [],
        forecast: null,
        spotlight: { pos: state.player, radiusCells: 0.58 },
        gesture: attack ? { from: state.player, dir: attack.dir, distanceCells: 0.88, hold: true } : undefined,
      }), 'RESONANCE', 5)
    }
    if (levelIndex === 15) {
      const light = state.lights[0] ?? ([1, 0] as const)
      const center = state.centers[0]
      const pages: RevealPage[] = [
        {
          title: '金色放射格是光照格',
          body: '玩家走上光照格时，它会立刻触发一次全局转向。',
          spotlight: { pos: light, radiusCells: 0.62 },
        },
        {
          title: '光照只移动白箭头',
          body: '触发后，所有中心的白箭头顺时针移到下一条真实色臂，合法进攻方向随之改变。',
          spotlight: { pos: center.pos, radiusCells: 0.3 },
        },
        {
          title: '彩色臂本身不会旋转',
          body: '光照只是在重新选择开口，不会搬动任何色珠；中心构型保持原样。',
          spotlight: { pos: pointOnArm(state, 0, 'N'), radiusCells: 0.32 },
        },
      ]
      if (introBeat < pages.length) {
        return revealModel(levelIndex, state, event, pages[introBeat], introBeat + 1, 4, 'LIGHT CONTROL')
      }
      const dir = nextDirToward(state, light)
      return actionKicker(model(levelIndex, state, event, {
        title: '现在走向光照格',
        body: '先走上金色格，再观察白箭头怎样改变方向。',
        tip: '每次踏入都会再次触发光照',
        focusDirs: dir ? [dir] : [],
        forecast: null,
        spotlight: { pos: state.player, radiusCells: 0.58 },
        gesture: dir ? { from: state.player, dir, distanceCells: 0.88 } : undefined,
      }), 'LIGHT CONTROL', 4)
    }
    if (levelIndex === 16) {
      const currentGoal = state.stages[0]?.goals[0]
      const futureGoal = state.stages[1]?.goals[0]
      const pages: RevealPage[] = [
        {
          title: '亮圈是当前阶段目标',
          body: '现在只需要先满足这枚明亮的绿色目标圈。上方「阶段」读数显示当前进度。',
          spotlight: {
            pos: currentGoal ? pointOnArm(state, currentGoal.center, currentGoal.arm) : state.centers[0].pos,
            radiusCells: 0.34,
          },
        },
        {
          title: '淡圈是下一阶段目标',
          body: '这枚较淡的目标还不用立即满足；当前阶段完成后，它才会变亮并接管目标。',
          spotlight: {
            pos: futureGoal ? pointOnArm(state, futureGoal.center, futureGoal.arm) : state.centers[0].pos,
            radiusCells: 0.34,
          },
        },
        {
          title: '阶段会按顺序推进',
          body: '完成亮圈后不会立刻通关，而是进入下一组目标。同一座中心可能需要在后面再翻回来。',
          spotlight: { pos: state.centers[0].pos, radiusCells: 0.86 },
        },
      ]
      if (introBeat < pages.length) {
        return revealModel(levelIndex, state, event, pages[introBeat], introBeat + 1, 4, 'STAGED GOALS')
      }
      const center = state.centers[0]
      const [dx, dy] = DIR_VEC[center.leaving]
      const attackPos: readonly [number, number] = [center.pos[0] - dx, center.pos[1] - dy]
      const dir = nextDirToward(state, attackPos)
      return actionKicker(model(levelIndex, state, event, {
        title: '先完成当前的亮圈',
        body: '移动到白箭头反面的进攻位，先观察第一阶段完成后哪些目标会亮起。',
        tip: '淡圈只是预告，不必同时满足',
        focusDirs: dir ? [dir] : [],
        forecast: null,
        spotlight: { pos: state.player, radiusCells: 0.58 },
        gesture: dir ? { from: state.player, dir, distanceCells: 0.88 } : undefined,
      }), 'STAGED GOALS', 4)
    }
    if (levelIndex === 20) {
      const center = state.centers[0]
      const missing = DIRS.find((dir) => center.arms[dir] === undefined) ?? 'W'
      const target = state.stages[0]?.goals.find((goal) => goal.arm === missing)
      const source = target
        ? DIRS.find((dir) => center.arms[dir] === target.color) ?? opposite(missing)
        : opposite(missing)
      const pages: RevealPage[] = [
        {
          title: '三角核表示三臂中心',
          body: '它只有三条真实色臂，但进攻方式仍和普通中心相同。',
          spotlight: { pos: center.pos, radiusCells: 0.3 },
        },
        {
          title: '虚线空槽是空穴',
          body: '空穴没有颜色，不能拾取、注入或填补；空穴所在方向也不能形成共振键。',
          spotlight: { pos: pointOnArm(state, 0, missing), radiusCells: 0.3 },
        },
        {
          title: '目标仍可以指向空穴方向',
          body: '这不是要把空穴填满，而是要靠整体翻转，让一条真实色臂移动到这个方向。',
          spotlight: { pos: pointOnArm(state, 0, missing), radiusCells: 0.36 },
        },
        {
          title: '这条蓝臂会随空穴一起换边',
          body: '中心翻转 180° 时，三颗珠、白箭头和空穴全部移动到对侧；撞两次会回到原样。',
          spotlight: { pos: pointOnArm(state, 0, source), radiusCells: 0.32 },
        },
      ]
      if (introBeat < pages.length) {
        return revealModel(levelIndex, state, event, pages[introBeat], introBeat + 1, 5, 'VACANCY')
      }
      const [dx, dy] = DIR_VEC[center.leaving]
      const attackPos: readonly [number, number] = [center.pos[0] - dx, center.pos[1] - dy]
      const dir = nextDirToward(state, attackPos)
      return actionKicker(model(levelIndex, state, event, {
        title: '现在撞动三臂中心',
        body: '出手前先预测蓝臂与空穴各会移动到哪一侧。',
        tip: '三臂中心仍然是整体翻转 180°',
        focusDirs: dir ? [dir] : [],
        forecast: null,
        spotlight: { pos: state.player, radiusCells: 0.58 },
        gesture: dir ? { from: state.player, dir, distanceCells: 0.88 } : undefined,
      }), 'VACANCY', 5)
    }
    if (levelIndex === 26) {
      const center = state.centers[0]
      const outlet = pointOnArm(state, 0, opposite(center.leaving), 0.25)
      const pages: RevealPage[] = [
        {
          title: '菱形核是弹射中心',
          body: '它仍然接受持珠进攻，但离去珠不再换到手中。',
          spotlight: { pos: center.pos, radiusCells: 0.3 },
        },
        {
          title: '双箭头标出背后的喷口',
          body: '持珠撞入后，开口原珠会从玩家身后沿直线飞出，手会重新变空。',
          spotlight: { pos: outlet, radiusCells: 0.3 },
        },
      ]
      if (introBeat < pages.length) {
        return revealModel(levelIndex, state, event, pages[introBeat], introBeat + 1, 6, 'EJECTION')
      }
      const group = state.groups[0]
      const dir = group ? nextDirToward(state, group.pos) : undefined
      return { ...model(levelIndex, state, event, {
        title: '先拾取紫珠，再靠近弹射中心',
        body: '弹射只在持珠进攻时发生；先拿起场上的紫珠。',
        tip: '靠近合法进攻位后会继续解释离去珠与落点',
        focusDirs: dir ? [dir] : [],
        forecast: null,
        spotlight: { pos: group?.pos ?? state.player, radiusCells: 0.34 },
        gesture: dir ? { from: state.player, dir, distanceCells: 0.88 } : undefined,
      }), kicker: 'EJECTION · 03 / 06' }
    }
    if (levelIndex === 32) {
      const shieldIndex = state.centers.findIndex((center) => center.shieldUntilStage !== undefined)
      const shield = state.centers[shieldIndex >= 0 ? shieldIndex : 0]
      const currentGoal = state.stages[0]?.goals[0]
      const futureGoal = state.stages[1]?.goals[0]
      const pages: RevealPage[] = [
        {
          title: '六边形轮廓是阶段护罩',
          body: '罩内中心暂时挡住直接进攻与共振，但白箭头仍可被光照移动。',
          spotlight: { pos: shield.pos, radiusCells: 0.95 },
        },
        {
          title: '编号 02 表示第二阶段开放',
          body: '先完成当前亮圈，也就是第 1 阶段目标；护罩还不会提前放行。',
          spotlight: {
            pos: currentGoal ? pointOnArm(state, currentGoal.center, currentGoal.arm) : state.centers[0].pos,
            radiusCells: 0.34,
          },
        },
        {
          title: '罩内目标属于下一阶段',
          body: '第 1 阶段完成后，这枚目标才变成当前任务，罩内中心也从下一步起可进攻。',
          spotlight: {
            pos: futureGoal ? pointOnArm(state, futureGoal.center, futureGoal.arm) : shield.pos,
            radiusCells: 0.34,
          },
        },
        {
          title: '护罩在整次动作结算后才解除',
          body: '刚完成阶段的那次连锁仍会被挡住，不会追溯穿过刚打开的护罩；下一次动作才开放。',
          spotlight: { pos: shield.pos, radiusCells: 0.95 },
        },
      ]
      if (introBeat < pages.length) {
        return revealModel(levelIndex, state, event, pages[introBeat], introBeat + 1, 5, 'STAGE SHIELD')
      }
      const goalCenter = currentGoal ? state.centers[currentGoal.center] : state.centers[0]
      const [dx, dy] = DIR_VEC[goalCenter.leaving]
      const attackPos: readonly [number, number] = [goalCenter.pos[0] - dx, goalCenter.pos[1] - dy]
      const dir = nextDirToward(state, attackPos)
      return actionKicker(model(levelIndex, state, event, {
        title: '先完成第 1 阶段',
        body: '暂时不要撞护罩；先移动到当前亮圈所属中心的进攻位。',
        tip: '观察阶段推进后护罩何时真正消失',
        focusDirs: dir ? [dir] : [],
        forecast: null,
        spotlight: { pos: state.player, radiusCells: 0.58 },
        gesture: dir ? { from: state.player, dir, distanceCells: 0.88 } : undefined,
      }), 'STAGE SHIELD', 5)
    }
    if (levelIndex === 40) {
      const sourceIndex = state.centers.findIndex((center) => center.ejects && center.hitCenters)
      const source = state.centers[sourceIndex >= 0 ? sourceIndex : 0]
      const targetIndex = state.centers.findIndex((center, i) => i !== sourceIndex && center.pos[0] === 0)
      const target = state.centers[targetIndex >= 0 ? targetIndex : 1]
      const [tdx, tdy] = DIR_VEC[target.leaving]
      const landing: readonly [number, number] = [target.pos[0] - tdx, target.pos[1] - tdy]
      const pages: RevealPage[] = [
        {
          title: '这座弹射中心能撞动结构',
          body: '它的飞珠不只会落地；若弹道终点对准另一座中心的进攻面，还会触发一次结构翻转。',
          spotlight: { pos: source.pos, radiusCells: 0.92 },
        },
        {
          title: '这是飞珠要撞动的中心',
          body: '远端中心仍遵守普通进攻方向：只有飞珠落在白箭头反面的进攻位，撞核才会生效。',
          spotlight: { pos: target.pos, radiusCells: 0.84 },
        },
        {
          title: '这个格子正是远端进攻位',
          body: '飞珠沿直线停在这里时，会替你完成一次空手翻转，并继续检查共振传播。',
          spotlight: { pos: landing, radiusCells: 0.46 },
        },
        {
          title: '撞核后的珠仍留在落点',
          body: '结构翻转不会消耗飞珠；之后仍可走到落点把它捡起，继续完成后续运输。',
          spotlight: { pos: landing, radiusCells: 0.34 },
        },
      ]
      if (introBeat < pages.length) {
        return revealModel(levelIndex, state, event, pages[introBeat], introBeat + 1, 5, 'STRUCTURE HIT')
      }
      const group = state.groups[0]
      const dir = group ? nextDirToward(state, group.pos) : undefined
      return actionKicker(model(levelIndex, state, event, {
        title: '先拿起紫珠，准备弹射',
        body: '先完成取货；到达弹射中心进攻位后，用预演核对完整弹道。',
        tip: '先看落点，再看落点是否正对远端白箭头',
        focusDirs: dir ? [dir] : [],
        forecast: null,
        spotlight: { pos: group?.pos ?? state.player, radiusCells: 0.34 },
        gesture: dir ? { from: state.player, dir, distanceCells: 0.88 } : undefined,
      }), 'STRUCTURE HIT', 5)
    }
    if (levelIndex === 41) {
      const light = state.lights[0] ?? ([1, 1] as const)
      const targetIndex = state.centers.findIndex((center) => center.pos[0] === 0)
      const target = state.centers[targetIndex >= 0 ? targetIndex : 1]
      const pages: RevealPage[] = [
        {
          title: '飞珠也能触发光照格',
          body: '这座弹射中心的飞珠落在金色格时，会像玩家踏入一样，让所有白箭头先转一次。',
          spotlight: { pos: light, radiusCells: 0.62 },
        },
        {
          title: '远端中心的白箭头会先转向',
          body: '它现在朝下；飞珠触光后，白箭头顺时针转到左侧，合法进攻位随之改变。',
          spotlight: { pos: target.pos, radiusCells: 0.3 },
        },
        {
          title: '同一颗飞珠随后继续撞核',
          body: '结算顺序是先触光、再检查撞核。箭头转到左侧后，金色格恰好成为远端中心的新进攻位。',
          spotlight: { pos: light, radiusCells: 0.46 },
        },
        {
          title: '捡起落点珠会再次触光',
          body: '飞珠仍停在金色格；玩家之后走上去拾取时，光照格会再触发一次，白箭头继续顺时针移动。',
          spotlight: { pos: light, radiusCells: 0.62 },
        },
      ]
      if (introBeat < pages.length) {
        return revealModel(levelIndex, state, event, pages[introBeat], introBeat + 1, 5, 'LIGHT IMPACT')
      }
      const group = state.groups[0]
      const dir = group ? nextDirToward(state, group.pos) : undefined
      return actionKicker(model(levelIndex, state, event, {
        title: '先拿起紫珠，准备复合弹射',
        body: '到达弹射进攻位后，按住预演并按顺序检查：落光、转箭头、再撞核。',
        tip: '同一落点会被飞珠与玩家各触发一次',
        focusDirs: dir ? [dir] : [],
        forecast: null,
        spotlight: { pos: group?.pos ?? state.player, radiusCells: 0.34 },
        gesture: dir ? { from: state.player, dir, distanceCells: 0.88 } : undefined,
      }), 'LIGHT IMPACT', 5)
    }
    if (levelIndex === 42) {
      const reactiveIndex = state.centers.findIndex((center) => center.reactiveTo !== undefined)
      const reactive = state.centers[reactiveIndex >= 0 ? reactiveIndex : 0]
      const control = reactive.reactiveTo
      const controlPoint = control
        ? pointOnArm(state, control.center, control.arm)
        : state.centers[0].pos
      const linkMid: readonly [number, number] = [
        (reactive.pos[0] + controlPoint[0]) / 2,
        (reactive.pos[1] + controlPoint[1]) / 2,
      ]
      const neighbor = state.centers.find((center, i) =>
        i !== reactiveIndex && center.pos[0] === reactive.pos[0] && Math.abs(center.pos[1] - reactive.pos[1]) === 1)
      const bondMid: readonly [number, number] = neighbor
        ? [(reactive.pos[0] + neighbor.pos[0]) / 2, (reactive.pos[1] + neighbor.pos[1]) / 2]
        : reactive.pos
      const pages: RevealPage[] = [
        {
          title: '带 R 的是再生护罩',
          body: '它不是一次性打开的门，而会根据另一条控制臂的状态反复关闭与开放。',
          spotlight: { pos: reactive.pos, radiusCells: 0.95 },
        },
        {
          title: '这条红臂控制护罩',
          body: '红臂保持指定颜色时护罩开放；颜色被翻走或破坏时，护罩会重新关闭。',
          spotlight: { pos: controlPoint, radiusCells: 0.32 },
        },
        {
          title: '虚线把护罩与控制臂连在一起',
          body: '顺着这条控制线就能判断是哪条臂在开关护罩；修复红色后，护罩会再次开放。',
          spotlight: { pos: linkMid, radiusCells: 0.5 },
        },
        {
          title: '临时关盾可以切断危险共振',
          body: '护罩关闭时会挡住这条相邻链路。关门有时不是障碍，而是在保护已经对齐的中心。',
          spotlight: { pos: bondMid, radiusCells: 0.5 },
        },
      ]
      if (introBeat < pages.length) {
        return revealModel(levelIndex, state, event, pages[introBeat], introBeat + 1, 5, 'REACTIVE SHIELD')
      }
      const attack = immediateAttack(state)
      return actionKicker(model(levelIndex, state, event, {
        title: '现在先改变控制臂',
        body: '出手前预测：红臂翻走后，R 护罩会从开放变为关闭。',
        tip: '按住预演可以先看护罩生成',
        focusDirs: attack ? [attack.dir] : [],
        forecast: null,
        spotlight: { pos: state.player, radiusCells: 0.58 },
        gesture: attack ? { from: state.player, dir: attack.dir, distanceCells: 0.88, hold: true } : undefined,
      }), 'REACTIVE SHIELD', 5)
    }
  }

  if (levelIndex < 0 || levelIndex > 4) {
    // 弹射教学：拾珠后先引导就位，再逐物说明离去珠与弹道落点。
    if (levelIndex === 26 && state.holding !== null) {
      const ejectAttack = immediateAttack(state)
      if (ejectAttack) {
        const center = state.centers[ejectAttack.center]
        const preview = getEjectionPreview(state, ejectAttack.center)
        const pages: RevealPage[] = [
          {
            title: '开口原珠会被弹出',
            body: '普通中心会把开口原珠换到手中；弹射中心改为把这颗离去珠从背后喷口推出。',
            spotlight: { pos: pointOnArm(state, ejectAttack.center, center.leaving), radiusCells: 0.32 },
          },
          {
            title: '虚线弹道终点就是落点',
            body: '离去珠沿喷口直线飞到最后一个空格；执行后珠留在这里，而你的手会变空。',
            spotlight: { pos: preview?.landing ?? state.player, radiusCells: 0.42 },
          },
        ]
        if (introBeat < 4) {
          const step = Math.max(0, introBeat - 2)
          return revealModel(levelIndex, state, event, pages[step], step + 4, 6, 'EJECTION')
        }
        return actionKicker(model(levelIndex, state, event, {
          title: '喷口已对齐，长按先看飞珠落点',
          body: '这次撞击后你的手会变空；开口原珠沿进攻反方向飞到射线最后一个空格。',
          tip: '松开执行；身后第一格被堵时整次进攻无效',
          focusDirs: [ejectAttack.dir],
          forecast: exchangeForecast(state, false),
          spotlight: { pos: state.player, radiusCells: 0.58 },
          gesture: { from: state.player, dir: ejectAttack.dir, distanceCells: 1, hold: true },
        }), 'EJECTION', 6)
      }
      const center = state.centers[0]
      const [dx, dy] = DIR_VEC[center.leaving]
      const attackPos: readonly [number, number] = [center.pos[0] - dx, center.pos[1] - dy]
      const dir = nextDirToward(state, attackPos)
      return { ...model(levelIndex, state, event, {
        title: '把手持珠带到弹射中心的进攻位',
        body: '站到白箭头反面后，引导会继续指出哪颗珠被弹出、最终落在哪里。',
        tip: '弹射中心仍然只能从白箭头反面进攻',
        focusDirs: dir ? [dir] : [],
        forecast: null,
        spotlight: { pos: state.player, radiusCells: 0.58 },
        gesture: dir ? { from: state.player, dir, distanceCells: 0.88 } : undefined,
      }), kicker: 'EJECTION · POSITIONING' }
    }
    return null
  }

  const attack = immediateAttack(state)
  const pickupDirs = adjacentGroupDirs(state)
  const holdingText = state.holding === null ? null : `${tutorialColorText(state.holding)}珠`

  if (levelIndex === 0) {
    const center = state.centers[0]
    const [ax, ay] = DIR_VEC[center.leaving]
    const attackPos: readonly [number, number] = [center.pos[0] - ax, center.pos[1] - ay]
    const travelDir = nextDirToward(state, attackPos)
    const keyboard = inputMode === 'keyboard'

    if (state.moves === 0 && !attack && introBeat < 4) {
      const goal = state.stages[state.stage]?.goals[0]
      const goalCenter = goal ? state.centers[goal.center] : center
      const goalDir = goal?.arm ?? 'N'
      const [gdx, gdy] = DIR_VEC[goalDir]
      const sourceDir = goal
        ? DIRS.find((dir) => dir !== goalDir && goalCenter.arms[dir] === goal.color) ?? 'S'
        : 'S'
      const [sdx, sdy] = DIR_VEC[sourceDir]
      const beats = [
        {
          title: '这是你',
          body: '棋盘上的白色光环代表你。接下来先认识目标和中心，再开始移动。',
          spotlight: { pos: state.player, radiusCells: 0.58 },
        },
        {
          title: '绿色虚线圈是目标',
          body: '虚线圈的颜色表示这里需要什么色珠：绿色虚线圈里最终要放进绿色珠。',
          spotlight: {
            pos: [goalCenter.pos[0] + gdx * 0.46, goalCenter.pos[1] + gdy * 0.46] as const,
            radiusCells: 0.34,
          },
        },
        {
          title: '把这颗绿色珠送进目标圈',
          body: '这颗绿色珠现在在中心下方。你需要通过一次正确的顶撞，把它送进目标圈，也就是上方的绿色虚线圈。',
          spotlight: {
            pos: [goalCenter.pos[0] + sdx * 0.46, goalCenter.pos[1] + sdy * 0.46] as const,
            radiusCells: 0.32,
          },
        },
        {
          title: '白箭头表示顶撞方向',
          body: '先站到箭头所指方向的反面，再沿箭头方向撞入中心。撞对以后，整个中心会翻转 180°。',
          spotlight: { pos: center.pos, radiusCells: 0.3 },
        },
      ] as const
      const beat = beats[introBeat]
      const intro = model(levelIndex, state, event, {
        title: beat.title,
        body: beat.body,
        tip: '点击或轻触棋盘任意位置继续',
        focusDirs: [],
        forecast: null,
        advanceOnTap: true,
        spotlight: beat.spotlight,
      })
      return { ...intro, kicker: `FIRST CONTACT · 0${introBeat + 1} / 05` }
    }

    const guide = model(levelIndex, state, event, {
      title: attack
        ? '站在箭头反面，沿箭头方向撞入'
        : keyboard
          ? '现在用 WASD 或方向键移动'
          : '现在在棋盘上滑动',
      body: attack
        ? '白箭头指向开口，也指明撞入方向。有效撞击后，中心、四条色臂和箭头会整体翻转 180°；上下、左右各自交换位置。'
        : keyboard
          ? `每次移动一格。先按 ${travelDir ? tutorialKeyForDir(travelDir) : 'S'}，走到中心左侧的进攻位。`
          : `手指向一个方向滑动，就会移动一格。先向${travelDir ? tutorialDirText(travelDir) : '下'}滑到中心左侧。`,
      tip: attack
        ? keyboard
          ? `现在按 ${tutorialKeyForDir(attack.dir)} 沿箭头撞入；翻转后绿色珠会进入绿色虚线圈`
          : `现在向${tutorialDirText(attack.dir)}沿箭头撞入；翻转后绿色珠会进入绿色虚线圈`
        : keyboard
          ? 'W / A / S / D = 上 / 左 / 下 / 右；方向键也可以'
          : '也可以点按下方的方向按钮',
      focusDirs: attack ? [attack.dir] : travelDir ? [travelDir] : [],
      forecast: null,
      spotlight: attack
        ? { pos: state.centers[attack.center].pos, radiusCells: 0.92 }
        : { pos: state.player, radiusCells: 0.58 },
      gesture: attack
        ? { from: state.player, dir: attack.dir, distanceCells: 0.88 }
        : travelDir
          ? { from: state.player, dir: travelDir, distanceCells: 0.88 }
          : undefined,
    })
    return state.moves === 0 && !attack
      ? { ...guide, kicker: 'FIRST CONTACT · 05 / 05' }
      : guide
  }

  if (levelIndex === 1) {
    if (state.moves === 0 && event === null && introBeat === 0) {
      const intro = model(levelIndex, state, event, {
        title: '卡住时，用“提示一步”',
        body: '底部发光的按钮只会告诉你当前局面的下一步，不会替你行动，也不限使用次数。',
        tip: '点一下“提示一步”试用，或轻触棋盘跳过',
        focusDirs: [],
        forecast: null,
        advanceOnTap: true,
        controlTarget: 'hint',
      })
      return { ...intro, kicker: 'ASSIST · STEP HINT' }
    }
    return model(levelIndex, state, event, {
      title: attack ? `位置对了，向${tutorialDirText(attack.dir)}撞入` : '绕到白箭头的反面',
      body: '从错误的一面撞，中心不会动；普通空格仍可行走。找到箭头反面的进攻位，再沿箭头方向出手。',
      tip: '不确定时按住方向约 0.3 秒预演；松开执行，回到原位或按 Esc 取消',
      focusDirs: attack ? [attack.dir] : [],
      forecast: null,
      spotlight: { pos: state.centers[0].pos, radiusCells: 0.85 },
      gesture: attack ? { from: state.player, dir: attack.dir, distanceCells: 0.88 } : undefined,
    })
  }

  if (levelIndex === 2) {
    const forecast = exchangeForecast(state, false)
    const previewing = event?.kind === 'preview' && forecast !== null
    const group = state.groups[0]
    const pickupDir = group ? nextDirToward(state, group.pos) : undefined
    const keyboard = inputMode === 'keyboard'
    const center = state.centers[0]
    const goal = state.stages[state.stage]?.goals[0]
    const goalDir = goal?.arm ?? opposite(center.leaving)
    const [gdx, gdy] = DIR_VEC[goalDir]
    const goalPos: readonly [number, number] = [
      center.pos[0] + gdx * 0.46,
      center.pos[1] + gdy * 0.46,
    ]

    if (state.holding === null && state.moves === 0 && introBeat < 2) {
      const beats = [
        {
          title: '这是游离的紫珠',
          body: '场上的彩色小球可以被拾取。等会儿走到这颗紫珠上，它就会跟着你移动。',
          spotlight: { pos: group?.pos ?? state.player, radiusCells: 0.32 },
        },
        {
          title: '紫色虚线圈是这次的目标',
          body: '目标圈需要同色珠。染色完成后，刚才那颗紫珠要出现在这里。',
          spotlight: { pos: goalPos, radiusCells: 0.34 },
        },
      ] as const
      const beat = beats[introBeat]
      const intro = model(levelIndex, state, event, {
        title: beat.title,
        body: beat.body,
        tip: '点击或轻触棋盘任意位置继续',
        focusDirs: [],
        forecast: null,
        advanceOnTap: true,
        spotlight: beat.spotlight,
      })
      return { ...intro, kicker: `COLORING FLOW · 0${introBeat + 1} / 07` }
    }

    if (state.holding !== null && attack && state.moves === 1 && introBeat < 5) {
      const beats = [
        {
          title: '紫珠现在拿在手中',
          body: '玩家右上角的小紫珠表示“手持紫珠”，上方状态栏的「手持」也会显示紫色。',
          spotlight: {
            pos: [state.player[0] + 0.3, state.player[1] - 0.3] as const,
            radiusCells: 0.24,
          },
        },
        {
          title: '持珠会从白箭头开口进入',
          body: '你已经站在正确的进攻位。沿白箭头撞入时，手里的紫珠会先进入箭头对应的开口。',
          spotlight: { pos: center.pos, radiusCells: 0.3 },
        },
        {
          title: '翻转后，紫珠会落在这里',
          body: '紫珠进入开口后，整个中心翻转 180°，于是紫珠来到对侧，正好进入紫色目标圈。这就是染色。',
          spotlight: { pos: goalPos, radiusCells: 0.34 },
        },
      ] as const
      const beat = beats[introBeat - 2]
      const intro = model(levelIndex, state, event, {
        title: beat.title,
        body: beat.body,
        tip: '点击或轻触棋盘任意位置继续',
        focusDirs: [],
        forecast: null,
        advanceOnTap: true,
        spotlight: beat.spotlight,
      })
      return { ...intro, kicker: `COLORING FLOW · 0${introBeat + 2} / 07` }
    }

    const guide = model(levelIndex, state, event, {
      title: holdingText
        ? attack
          ? previewing
            ? '这就是预演：虚线是染色后的构型'
            : keyboard
              ? `按住 ${tutorialKeyForDir(attack.dir)}，先别松开`
              : `向${tutorialDirText(attack.dir)}拖住，先别松手`
          : `把${holdingText}带到中心的进攻位`
        : '先走到游离的紫珠上',
      body: previewing && forecast
        ? `棋盘上的虚线是松手后的结果：手中${tutorialColorText(forecast.injected)}珠先进入开口，再随整个中心翻到${tutorialDirText(forecast.landingArm)}侧。这就是染色。`
        : holdingText
          ? attack
            ? '保持按住会先显示动作结果，但不会立刻改变局面；这次先用预演看清色珠怎样进入中心。'
            : '把手中的色珠带到中心箭头反面的进攻位，靠近后再学习预演。'
        : '经过游离色珠会自动拿起；上方状态栏的「手持」会从“空”变成对应颜色。',
      tip: previewing && forecast
        ? `把上面的“放入”与虚线${tutorialDirText(forecast.landingArm)}侧对应起来，再松手执行；回到原位或按 Esc 取消`
        : holdingText
          ? attack
            ? keyboard
              ? '按住约 0.3 秒进入预演；方向键同样可以'
              : '拖过一格后保持手指不动；松手才会执行'
            : '白箭头反面是合法进攻位'
          : '走上色珠不需要额外的拾取按钮',
      focusDirs: attack ? [attack.dir] : pickupDir ? [pickupDir] : pickupDirs,
      forecast: previewing ? forecast : null,
      spotlight: previewing
        ? { pos: state.centers[0].pos, radiusCells: 0.9 }
        : holdingText && attack
          ? { pos: state.player, radiusCells: 0.58 }
          : holdingText
            ? { pos: state.centers[0].pos, radiusCells: 0.9 }
            : { pos: group?.pos ?? state.player, radiusCells: 0.58 },
      gesture: (attack || pickupDir || pickupDirs[0])
        ? {
            from: state.player,
            dir: attack?.dir ?? pickupDir ?? pickupDirs[0],
            distanceCells: 0.88,
            hold: attack !== null,
          }
          : undefined,
    })
    if (state.holding === null && state.moves === 0) {
      return { ...guide, kicker: 'COLORING FLOW · 03 / 07' }
    }
    if (state.holding !== null && attack && state.moves === 1 && introBeat >= 5) {
      return { ...guide, kicker: 'COLORING FLOW · 07 / 07' }
    }
    return guide
  }

  if (levelIndex === 3) {
    const forecast = exchangeForecast(state, true)
    const previewing = event?.kind === 'preview' && forecast !== null
    const center = state.centers[0]
    if (state.holding !== null && attack && state.moves === 1 && introBeat < 2) {
      const pages: RevealPage[] = [
        {
          title: '先看开口上原来的蓝珠',
          body: '持珠撞入时，这颗开口原珠会离开中心，不会消失；它将换到你的手中。',
          spotlight: { pos: pointOnArm(state, 0, center.leaving), radiusCells: 0.32 },
        },
        {
          title: '再看手里准备放入的紫珠',
          body: '紫珠进入刚才的开口，同时蓝珠换到手中；随后整个中心才翻转 180°。',
          spotlight: {
            pos: [state.player[0] + 0.3, state.player[1] - 0.3],
            radiusCells: 0.24,
          },
        },
      ]
      return revealModel(levelIndex, state, event, pages[introBeat], introBeat + 2, 4, 'EXCHANGE')
    }
    const guide = model(levelIndex, state, event, {
      title: holdingText ? (attack ? '出手前，先读懂这次交换' : `把${holdingText}带到进攻位`) : '先拿起游离的紫珠',
      body: holdingText
        ? '持珠进攻会同时发生两件事：手中珠进入中心，开口臂原来的珠换到手中；随后整个结构翻转。'
        : '先经过游离色珠。拿起以后，引导会把这次进攻的“放入 / 换出”分开显示。',
      tip: forecast ? '试着先说出两条结果，再长按方向核对预演' : '靠近正确进攻位后会出现交换预报',
      focusDirs: attack ? [attack.dir] : pickupDirs,
      forecast,
      spotlight: forecast
        ? previewing
          ? { pos: state.centers[forecast.center].pos, radiusCells: 0.9 }
          : { pos: state.player, radiusCells: 0.58 }
        : state.holding === null
          ? { pos: state.groups[0]?.pos ?? state.player, radiusCells: 0.32 }
          : { pos: state.player, radiusCells: 0.58 },
      gesture: forecast
        ? { from: state.player, dir: forecast.dir, distanceCells: 0.88, hold: true }
        : pickupDirs[0]
          ? { from: state.player, dir: pickupDirs[0], distanceCells: 0.88 }
          : undefined,
    })
    if (state.holding === null && state.moves === 0) {
      return { ...guide, kicker: 'EXCHANGE · 01 / 04' }
    }
    if (forecast && state.moves === 1 && introBeat >= 2) {
      return { ...guide, kicker: 'EXCHANGE · 04 / 04' }
    }
    return guide
  }

  const forecast = exchangeForecast(state, true)
  let title = '先拿起左侧的紫珠'
  let body = '这一关不再只改一个中心：先取出需要的颜色，再把它送到另一个中心。'
  if (holdingText) {
    if (state.holding === 'purple') {
      title = attack ? '用紫珠从左侧中心换货' : '把紫珠带到左侧中心的进攻位'
      body = '观察“换出”一行：左侧中心开口上的颜色，会成为下一段运输的货物。'
    } else if (state.holding === 'blue') {
      title = attack ? '把蓝珠送进右侧中心' : '蓝珠到手，把它送到右侧中心'
      body = '现在把刚换出的蓝珠带去缺蓝珠的中心；每次出手前都可以用同一张预报核对。'
    } else {
      title = attack ? `确认交换，再送出${holdingText}` : `继续运送手中的${holdingText}`
    }
  }
  return model(levelIndex, state, event, {
    title,
    body,
    tip: forecast ? '先预测：我会放入什么，又会换出什么？' : '走错可撤销 Z；卡住可用提示 H；重开是 R',
    focusDirs: attack ? [attack.dir] : pickupDirs,
    forecast,
    spotlight: forecast ? { pos: state.centers[forecast.center].pos, radiusCells: 0.9 } : undefined,
    gesture: forecast ? { from: state.player, dir: forecast.dir, distanceCells: 0.88 } : undefined,
  })
}
