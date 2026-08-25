import { DIRS, DIR_VEC, cellKey, opposite } from '../core/protocol'
import type { Dir } from '../core/protocol'
import { isShielded } from '../games/chem/engine'
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
      feedback: '预演中：虚线轮廓是松开后将发生的结果；移开指针或按 Esc 可以取消。',
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

/** 01–05 操作引导 + 后续机制首现揭示；通关态立即让位给真实棋盘动画。 */
export function getChemTutorial(
  levelIndex: number,
  state: ChemState,
  event: TutorialEvent,
  inputMode: TutorialInputMode = 'touch',
): TutorialModel | null {
  if (state.won) return null

  // 后续机制只在首拍揭示；玩家开始行动后自动让位，不变成常驻攻略。
  if (state.moves === 0) {
    if (levelIndex === 9) {
      return model(levelIndex, state, event, {
        title: '这是共振键',
        body: '相邻中心的面对臂同色时会连成亮键。撞动一座中心，翻转会沿亮键继续传给下一座。',
        tip: '暗键不会传导；亮键会在动作结算后重新判断',
        focusDirs: ['E'],
        forecast: null,
        spotlight: { pos: [2.5, 2], radiusCells: 0.72 },
        gesture: { from: state.player, dir: 'E', distanceCells: 1 },
      })
    }
    if (levelIndex === 15) {
      return model(levelIndex, state, event, {
        title: '金色放射格是光照格',
        body: '走上它会让所有中心的白箭头顺时针移动；彩色臂本身不会跟着转。',
        tip: '它改变的是进攻方向，不是中心构型',
        focusDirs: [],
        forecast: null,
        spotlight: { pos: state.lights[0] ?? [1, 0], radiusCells: 0.62 },
      })
    }
    if (levelIndex === 16) {
      return model(levelIndex, state, event, {
        title: '亮圈是当前阶段，淡圈是下一阶段',
        body: '先满足当前亮圈，系统才会推进到下一组目标。同一座中心可能要在后面的阶段再翻回来。',
        tip: '上方「阶段」读数会同步推进',
        focusDirs: [],
        forecast: null,
        spotlight: { pos: state.centers[0].pos, radiusCells: 0.92 },
      })
    }
    if (levelIndex === 20) {
      return model(levelIndex, state, event, {
        title: '这是三臂中心，虚线空槽是空穴',
        body: '它仍然整体翻转 180°：三颗珠、白箭头和空穴都会一起移动到对侧。空穴所在方向不能形成共振键。',
        tip: '撞两次仍会回到原构型',
        focusDirs: [],
        forecast: null,
        spotlight: { pos: state.centers[0].pos, radiusCells: 0.9 },
      })
    }
    if (levelIndex === 26) {
      return model(levelIndex, state, event, {
        title: '菱形核是弹射中心',
        body: '持珠撞入时，手中珠照常进入中心；开口原珠不会换到手中，而会从背后喷口沿直线飞出。',
        tip: '双箭头标出喷口方向，虚线会预演完整弹道',
        focusDirs: [],
        forecast: null,
        spotlight: { pos: state.centers[0].pos, radiusCells: 0.92 },
      })
    }
    if (levelIndex === 32) {
      const shield = state.centers.find((center) => center.shieldUntilStage !== undefined)
      return model(levelIndex, state, event, {
        title: '六边形轮廓是阶段护罩',
        body: '罩内中心暂时挡住直接撞击和共振。编号 02 表示完成第 1 阶段后，它会在整次动作结算完毕时解除。',
        tip: '刚解除的同一步不会追溯传导；下一步起才开放',
        focusDirs: [],
        forecast: null,
        spotlight: { pos: shield?.pos ?? state.centers[0].pos, radiusCells: 0.95 },
      })
    }
    if (levelIndex === 40) {
      return model(levelIndex, state, event, {
        title: '飞珠现在也能撞动结构',
        body: '弹射珠若落在另一座中心当前的进攻位，会替你完成一次纯翻转；撞完的珠仍停在落点，可以继续拾取。',
        tip: '先沿喷口方向看终点，再检查终点是否正对另一座中心的白箭头',
        focusDirs: [],
        forecast: null,
        spotlight: { pos: state.centers[1].pos, radiusCells: 0.9 },
      })
    }
    if (levelIndex === 42) {
      const reactive = state.centers.find((center) => center.reactiveTo !== undefined)
      return model(levelIndex, state, event, {
        title: '带 R 的护罩会随控制臂开合',
        body: '虚线指向它监听的彩色臂：中间产物被破坏时护罩重新关闭，修复后再次打开。关盾有时也是保护动作。',
        tip: '按住预演可以先看护罩将生成还是消失',
        focusDirs: [],
        forecast: null,
        spotlight: { pos: reactive?.pos ?? state.centers[0].pos, radiusCells: 0.95 },
      })
    }
  }

  if (levelIndex < 0 || levelIndex > 4) {
    // 弹射教学在真正站到进攻位时再补一拍弹道提示。
    if (levelIndex === 26 && state.holding !== null) {
      const ejectAttack = immediateAttack(state)
      if (ejectAttack) {
        return model(levelIndex, state, event, {
          title: '喷口已对齐，长按先看飞珠落点',
          body: '这次撞击后你的手会变空；开口原珠沿进攻反方向飞到射线最后一个空格。',
          tip: '松开执行；身后第一格被堵时整次进攻无效',
          focusDirs: [ejectAttack.dir],
          forecast: exchangeForecast(state, false),
          spotlight: { pos: state.centers[ejectAttack.center].pos, radiusCells: 0.92 },
          gesture: { from: state.player, dir: ejectAttack.dir, distanceCells: 1 },
        })
      }
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
    return model(levelIndex, state, event, {
      title: attack
        ? '这是四元中心：从背面沿箭头撞入'
        : keyboard && travelDir
          ? `按 ${tutorialKeyForDir(travelDir)}，移动到进攻位`
          : `在棋盘上向${travelDir ? tutorialDirText(travelDir) : '目标方向'}滑动`,
      body: attack
        ? '四颗色珠组成四条臂，核内白箭头指向开口。有效撞击会让四条臂和箭头整体翻转到对侧。'
        : keyboard
          ? '亮色光环是你。WASD 或方向键每次移动一格；先移动到中心左侧的进攻位。'
          : '亮色光环是你。手指在棋盘上滑动，就会向同一方向走一格；先移动到中心左侧的进攻位。',
      tip: attack
        ? keyboard
          ? `现在按 ${tutorialKeyForDir(attack.dir)}，亲手触发第一次翻转`
          : `现在向${tutorialDirText(attack.dir)}滑动，亲手触发第一次翻转`
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
  }

  if (levelIndex === 1) {
    return model(levelIndex, state, event, {
      title: attack ? `位置对了，向${tutorialDirText(attack.dir)}撞入` : '绕到白箭头的反面',
      body: '从错误的一面撞，中心不会动；普通空格仍可行走。找到箭头反面的进攻位，再沿箭头方向出手。',
      tip: '不确定时按住方向约 0.3 秒预演；松开执行，移开或 Esc 取消',
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
    return model(levelIndex, state, event, {
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
        ? `把上面的“放入”与虚线${tutorialDirText(forecast.landingArm)}侧对应起来，再松手执行；移开或按 Esc 取消`
        : holdingText
          ? attack
            ? keyboard
              ? '按住约 0.3 秒进入预演；方向键同样可以'
              : '拖过一格后保持手指不动；松手才会执行'
            : '白箭头反面是合法进攻位'
          : '走上色珠不需要额外的拾取按钮',
      focusDirs: attack ? [attack.dir] : pickupDir ? [pickupDir] : pickupDirs,
      forecast: previewing ? forecast : null,
      spotlight: holdingText
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
  }

  if (levelIndex === 3) {
    const forecast = exchangeForecast(state, true)
    return model(levelIndex, state, event, {
      title: holdingText ? (attack ? '出手前，先读懂这次交换' : `把${holdingText}带到进攻位`) : '先拿起游离的紫珠',
      body: holdingText
        ? '持珠进攻会同时发生两件事：手中珠进入中心，开口臂原来的珠换到手中；随后整个结构翻转。'
        : '先经过游离色珠。拿起以后，引导会把这次进攻的“放入 / 换出”分开显示。',
      tip: forecast ? '试着先说出两条结果，再长按方向核对预演' : '靠近正确进攻位后会出现交换预报',
      focusDirs: attack ? [attack.dir] : pickupDirs,
      forecast,
      spotlight: forecast ? { pos: state.centers[forecast.center].pos, radiusCells: 0.9 } : undefined,
      gesture: forecast ? { from: state.player, dir: forecast.dir, distanceCells: 0.88 } : undefined,
    })
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
