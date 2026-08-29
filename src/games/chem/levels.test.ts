import { describe, expect, it } from 'vitest'
import { DIR_VEC, cellKey, opposite } from '../../core/protocol'
import type { Dir } from '../../core/protocol'
import { solve, solveFrom } from '../../core/solver'
import { chemGame, initialState, isShielded, step } from './engine'
import type { ChemState } from './engine'
import type { ChemLevel } from './level'

/**
 * chem（《109.5°》）关卡批次基线测试。
 *
 * 入库关卡必须：
 * 1. 通过 zod + 语义校验（parseLevel）；
 * 2. 初始局面未胜利（不允许空关）；
 * 3. solver 可解，且最短解长度等于设计意图基线（防止改图后出现绕开设计意图的捷径，
 *    见 AGENTS.md 关卡规范与 docs/design.md §5 批次决策）。
 */

const levelFiles = import.meta.glob('./levels/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

/** 设计意图基线：文件名 → 最短解步数（逐关 `pnpm solve` 核对；01–74 正式 + LV.999 隐藏彩蛋） */
const baseline: Record<string, number> = {
  './levels/level-01.json': 2, // 滑动到固定站位，再完成第一次撞入
  './levels/level-02.json': 5, // 从错误侧绕到背面
  './levels/level-03.json': 2, // 拾珠并第一次持珠取代
  './levels/level-04.json': 2, // 两步观察输入落臂与开口珠换手
  './levels/level-05.json': 5, // 从 A 取出蓝珠送到 B
  './levels/level-06.json': 6, // 先后顺序发现题：保留结构，不在关名 / 教程宣布手持不变式（旧 07）
  './levels/level-07.json': 6, // 共振首现即教学：换出蓝珠后一击接通双中心（旧 06）
  './levels/level-08.json': 1, // 多米诺：三级链逐级接通（旧 11）
  './levels/level-09.json': 3, // 碰不到的中心：共振是唯一的门（v5 新关）
  './levels/level-10.json': 7, // 点火前先调整奇偶与手持珠（旧 12）
  './levels/level-11.json': 7, // 安全点火：红珠止链，蓝珠误烧链尾（旧 13）
  './levels/level-12.json': 9, // 奇偶序列点燃两条链（旧 14）
  './levels/level-13.json': 6, // 光照入门：转轴开出进攻路（旧 16）
  './levels/level-14.json': 7, // 分步目标入门（旧 17）
  './levels/level-15.json': 6, // 光照 × 共振（旧 18）
  './levels/level-16.json': 10, // 光照 × 搬运 × 分步（旧 19）
  './levels/level-17.json': 9, // 分步共振毕业（旧 20）
  './levels/level-18.json': 2, // 三臂中心：标准翻转 + 缺口移到对侧（旧 21）
  './levels/level-19.json': 3, // 空穴断路器：先断链，翻空穴后再接通链尾（旧 22）
  './levels/level-20.json': 1, // 空穴保险丝：传播后翻洞保护已达标链尾（旧 23）
  './levels/level-21.json': 8, // 南北双路换向：两次翻洞依次接通两支路（旧 24）
  './levels/level-22.json': 9, // 光照 × 空穴 × 分步（旧 25）
  './levels/level-23.json': 5, // 双染引链：染色换出的珠成为第二次染色的输入（旧 26）
  './levels/level-24.json': 3, // 弹射入门：顶出珠沿身后落地（旧 27）
  './levels/level-25.json': 7, // 压缩后的弹射资源复用（旧 28）
  './levels/level-26.json': 4, // 一击三果：翻转 + 连锁 + 弹射（旧 29）
  './levels/level-27.json': 8, // 弹射珠跨中心复用（旧 30）
  './levels/level-28.json': 6, // 光照改变喷流轴（旧 31）
  './levels/level-29.json': 5, // 三臂弹射中心：障碍控制落点（旧 32）
  './levels/level-30.json': 5, // 阶段护罩：完成当步不追溯，下一步扩链（旧 33）
  './levels/level-31.json': 5, // 延迟连锁：下一动作才穿透护罩（旧 34）
  './levels/level-32.json': 3, // 多护罩按阶段依次解除（旧 35）
  './levels/level-33.json': 6, // 光照预对齐阶段护罩（旧 36）
  './levels/level-34.json': 6, // 开罩接空穴：第一击连锁被护罩拦下（旧 37）
  './levels/level-35.json': 4, // 阶段护罩 × 弹射 × 共振（旧 38）
  './levels/level-36.json': 9, // 毕业：阶段护罩 + 空穴 + 光照 + 弹射中心（旧 39）
  './levels/level-37.json': 8, // v4 弹射撞核：弹射珠撞中心纯翻转（旧 41）
  './levels/level-38.json': 8, // v4 撞光又撞核：先转轴后顺势撞入（旧 42）
  './levels/level-39.json': 7, // v4 关闸保形：主动关盾隔离共振（旧 43）
  './levels/level-40.json': 9, // v4 回授闸门：闭→开→闭→开（旧 44）
  './levels/level-41.json': 10, // v4 护罩缓冲：关盾挡下飞珠撞核（旧 45）
  './levels/level-42.json': 9, // v4 撞核共振链：撞核后共振继续传播（旧 46）
  './levels/level-43.json': 4, // 双态闸门：互补双闸交换通行权（候选池 53 提升）
  './levels/level-44.json': 6, // mastery：光照预对齐三阶段护罩（旧 48）
  './levels/level-45.json': 7, // mastery：开罩接三路，奇偶复位后接通（旧 49）
  './levels/level-46.json': 8, // mastery：开罩后三臂弹射、共振与余料终投（候选池 59 提升）
  './levels/level-47.json': 10, // mastery：一束光转正两个开口后回收弹射珠（旧 47）
  './levels/level-48.json': 11, // mastery：光照预调后三臂再生闸门开→关→开（候选池 58 提升）
  './levels/level-49.json': 14, // mastery：双喷口接力，飞珠连续接力（候选池 55 提升）
  './levels/level-50.json': 12, // 终局：三阶段光照 × 搬运 × 弹射 × 护罩（旧 50，唯一终局）
  './levels/level-51.json': 9, // 进阶综合：双锁撞核（旧 51）
  './levels/level-52.json': 10, // 进阶综合：缺口缓冲（旧 52）
  './levels/level-53.json': 12, // 进阶综合：解锁撞链（旧 54）
  './levels/level-54.json': 12, // 进阶综合：三段注入（旧 56）
  './levels/level-55.json': 11, // 进阶综合：三路余波（旧 57）
  './levels/level-56.json': 12, // 进阶综合：双锁回收（旧 60，去终局命名）
  './levels/level-57.json': 11, // 全机制组合：撞核转喷口（撞核目标首次是弹射中心本体）
  './levels/level-58.json': 11, // 全机制组合：空穴准星（撞核翻空穴接通共振键）
  './levels/level-59.json': 9, // 全机制组合：撞核关闸（空穴撞进监视槽主动关再生闸）
  './levels/level-60.json': 11, // 全机制组合：双光时序（双光照 + 双护罩顺序谜题）
  './levels/level-61.json': 14, // 全机制组合：喷口对射（对脸撞核再瞄准 + 撞光转轴）
  './levels/level-62.json': 13, // 全机制组合：空手关闸（监视臂怕染料，只能空手撞）
  './levels/level-63.json': 14, // 全机制组合：三级火箭（弹射三级接力，中段触光）
  './levels/level-64.json': 11, // 全机制组合：罩内预瞄（护罩内预转喷口，解锁即射）
  './levels/level-65.json': 19, // 全机制组合：合流（三段闭环：连锁 → 光瞄撞核关闸 → 余料终投）
  './levels/level-66.json': 23, // 全机制组合：四段全谱（四段闭环 + 双弹射 + 双光照 + 空穴接收端）
  './levels/level-67.json': 11, // 转辙：北口回声（波反弹换向 + 三段接力注入）
  './levels/level-68.json': 10, // 转辙：唤醒（先西后北的顺序由键奇偶锁死）
  './levels/level-69.json': 10, // 转辙·遥扳（步数红线 + 漏斗墙 + 撞核二跳级联）
  './levels/level-70.json': 14, // 红线·对射（61 镜像 + 预算使绕行非法）
  './levels/level-71.json': 14, // 红线·接力（63 旋转 + 预算）
  './levels/level-72.json': 11, // 红线·预瞄（64 旋转 + 预算）
  './levels/level-73.json': 19, // 红线·合流（65 旋转 + 预算）
  './levels/level-74.json': 14, // 转辙·终章（三波换向 + 借射第四波 + 红线）
  './levels/level-75.json': 25, // LV.999：01 复刻口袋 + 重写总线 + 全锁设施，零冗余红线
}

const entries = Object.entries(levelFiles).sort(([a], [b]) => a.localeCompare(b))

function shortestInteractionTrace(file: string): string[] {
  const level = chemGame.parseLevel(levelFiles[file])
  const result = solve(chemGame, level, { maxDepth: 30 })
  expect(result.solved).toBe(true)
  let state = initialState(level)
  const events: string[] = []
  for (const action of result.solution) {
    const before = state
    state = step(state, action)
    if (before.player[0] === state.player[0] && before.player[1] === state.player[1]) {
      const [dx, dy] = DIR_VEC[action as Dir]
      const target = before.centers.findIndex(
        (c) => c.pos[0] === before.player[0] + dx && c.pos[1] === before.player[1] + dy,
      )
      events.push(`attack:${target}:${before.holding ?? 'empty'}`)
    } else if (before.holding !== state.holding || before.groups.length !== state.groups.length) {
      events.push(`carry:${before.holding ?? 'empty'}>${state.holding ?? 'empty'}`)
    }
  }
  return events
}

interface Transition {
  before: ChemState
  after: ChemState
  action: Dir
}

function shortestTransitions(file: string): Transition[] {
  const level = chemGame.parseLevel(levelFiles[file])
  const result = solve(chemGame, level, { maxDepth: 30 })
  expect(result.solved).toBe(true)
  let state = initialState(level)
  return result.solution.map((action) => {
    const before = state
    const after = step(before, action)
    state = after
    return { before, after, action }
  })
}

function reactiveShieldPhases(file: string): boolean[] {
  const level = chemGame.parseLevel(levelFiles[file])
  const guarded = level.centers.findIndex((c) => c.reactiveTo !== undefined)
  expect(guarded, `${file} 应有再生护罩中心`).toBeGreaterThanOrEqual(0)
  const transitions = shortestTransitions(file)
  const states = [initialState(level), ...transitions.map((t) => t.after)]
  return states
    .map((s) => isShielded(s, s.centers[guarded]))
    .filter((shielded, i, all) => i === 0 || shielded !== all[i - 1])
}

function withoutReactiveShields(level: ChemLevel): ChemLevel {
  return {
    ...level,
    centers: level.centers.map((c) => ({ ...c, reactiveTo: undefined })),
  }
}

const centerChanged = (t: Transition, index: number): boolean =>
  t.before.centers[index].arms !== t.after.centers[index].arms

const holeAt = (s: ChemState, index: number): Dir | undefined =>
  (['N', 'E', 'S', 'W'] as const).find((d) => s.centers[index].arms[d] === undefined)

function attackedCenter(t: Transition): number {
  if (t.before.player[0] !== t.after.player[0] || t.before.player[1] !== t.after.player[1]) return -1
  const [dx, dy] = DIR_VEC[t.action]
  return t.before.centers.findIndex(
    (center) =>
      center.pos[0] === t.before.player[0] + dx && center.pos[1] === t.before.player[1] + dy,
  )
}

function isEjection(t: Transition, centerIndex = attackedCenter(t)): boolean {
  return (
    centerIndex >= 0 &&
    t.before.centers[centerIndex].ejects === true &&
    t.before.holding !== null &&
    t.after.holding === null &&
    centerChanged(t, centerIndex) &&
    t.after.groups.length === t.before.groups.length + 1
  )
}

function shortestMechanismEvents(file: string): Set<string> {
  const level = chemGame.parseLevel(levelFiles[file])
  const transitions = shortestTransitions(file)
  const lightKeys = new Set(level.lights.map(([x, y]) => cellKey(x, y)))
  const events = new Set<string>()

  for (const t of transitions) {
    const moved = t.before.player[0] !== t.after.player[0] || t.before.player[1] !== t.after.player[1]
    if (moved && lightKeys.has(cellKey(t.after.player[0], t.after.player[1]))) events.add('light')
    if (t.after.stage > t.before.stage) events.add('stage')
    if (t.before.holding !== t.after.holding) events.add('carry')

    const changed = t.before.centers.flatMap((_, index) => (centerChanged(t, index) ? [index] : []))
    if (changed.length > 1) events.add('multi-center')
    if (
      level.centers.some(
        (center, index) =>
          center.kind === 'trigonal' && holeAt(t.before, index) !== holeAt(t.after, index),
      )
    ) {
      events.add('hole')
    }
    if (
      level.centers.some(
        (center, index) =>
          center.shieldUntilStage !== undefined &&
          isShielded(t.before, t.before.centers[index]) !== isShielded(t.after, t.after.centers[index]),
      )
    ) {
      events.add('stage-shield')
    }
    if (
      level.centers.some(
        (center, index) =>
          center.reactiveTo !== undefined &&
          isShielded(t.before, t.before.centers[index]) !== isShielded(t.after, t.after.centers[index]),
      )
    ) {
      events.add('reactive')
    }

    const launcher = attackedCenter(t)
    if (isEjection(t, launcher)) {
      events.add('eject')
      if (changed.some((index) => index !== launcher)) events.add('hit-center')
    }
  }
  return events
}

/**
 * 穷举到设计最短深度，并过滤掉某类关键语义转移。
 * 返回 false 表示：不发生该机制事件，就不存在等长（或更短）解。
 */
function hasWinningPathAvoiding(
  level: ChemLevel,
  maxDepth: number,
  required: (transition: Transition) => boolean,
): boolean {
  let frontier: ChemState[] = [initialState(level)]
  const visited = new Set<string>([chemGame.stateKey(frontier[0])])
  for (let depth = 0; depth < maxDepth; depth++) {
    const nextFrontier: ChemState[] = []
    for (const before of frontier) {
      for (const action of chemGame.actions(before)) {
        const after = step(before, action)
        if (required({ before, after, action })) continue
        const key = chemGame.stateKey(after)
        if (visited.has(key)) continue
        if (after.won) return true
        visited.add(key)
        nextFrontier.push(after)
      }
    }
    frontier = nextFrontier
  }
  return false
}

describe('chem（109.5°）正式 01–74 + LV.999 隐藏彩蛋', () => {
  it('关卡数量与基线表一致', () => {
    expect(entries.map(([file]) => file)).toEqual(Object.keys(baseline))
    expect(entries).toHaveLength(75)
  })

  it('文件序号与内部 id 一一对应', () => {
    for (const [file, json] of entries) {
      const number = /level-(\d+)\.json$/.exec(file)?.[1]
      expect(number, `${file} 应使用 level-XX 文件名`).toBeDefined()
      const expectedId = number === '75' ? '109.5°-999' : `109.5°-${number}`
      expect(chemGame.parseLevel(json).id).toBe(expectedId)
    }
  })

  it('v5 正式曲线按机制段落落位（首现即教学，无倒挂）', () => {
    const at = (n: number): ChemLevel =>
      chemGame.parseLevel(levelFiles[`./levels/level-${String(n).padStart(2, '0')}.json`])
    const hasAdjacentCenters = (level: ChemLevel): boolean =>
      level.centers.some((a, i) =>
        level.centers.some(
          (b, j) => i !== j && Math.abs(a.pos[0] - b.pos[0]) + Math.abs(a.pos[1] - b.pos[1]) === 1,
        ),
      )

    // 07 = 共振首现即教学（旧 06）；07–12 共振段全部使用共振拓扑
    expect(hasAdjacentCenters(at(7)), 'level-7 应是共振首现教学关').toBe(true)
    for (let n = 7; n <= 12; n++) expect(hasAdjacentCenters(at(n)), `level-${n} 应使用共振拓扑`).toBe(true)
    for (let n = 13; n <= 17; n++) {
      const level = at(n)
      expect(level.lights.length > 0 || level.stages.length > 1, `level-${n} 应使用光照或分步目标`).toBe(true)
    }
    for (let n = 18; n <= 23; n++) {
      expect(at(n).centers.some((c) => c.kind === 'trigonal'), `level-${n} 应使用三臂空穴`).toBe(true)
    }
    for (let n = 24; n <= 29; n++) {
      expect(at(n).centers.some((c) => c.ejects), `level-${n} 应使用弹射中心`).toBe(true)
    }
    for (let n = 30; n <= 36; n++) {
      expect(
        at(n).centers.some((c) => c.shieldUntilStage !== undefined),
        `level-${n} 应使用阶段护罩`,
      ).toBe(true)
    }
    for (let n = 37; n <= 75; n++) {
      const level = at(n)
      const usesMasteryMechanic =
        level.lights.length > 0 ||
        level.stages.length > 1 ||
        level.centers.some(
          (c) =>
            c.kind === 'trigonal' ||
            c.ejects ||
            c.shieldUntilStage !== undefined ||
            c.hitLights ||
            c.hitCenters ||
            c.reactiveTo !== undefined,
        )
      expect(usesMasteryMechanic, `level-${n} 应深化既有机制`).toBe(true)
    }
    for (const n of [37, 38, 42]) {
      expect(
        at(n).centers.some((c) => c.hitLights || c.hitCenters),
        `level-${n} 应使用弹射打结构`,
      ).toBe(true)
    }
    for (const n of [39, 40, 41, 43, 48]) {
      expect(at(n).centers.some((c) => c.reactiveTo), `level-${n} 应使用再生护罩`).toBe(true)
    }
    // 唯一终局：50；赛后挑战 51–74 与正式曲线其余关不得使用终局命名
    for (let n = 1; n <= 49; n++) expect(at(n).name).not.toMatch(/^终局/)
    for (let n = 51; n <= 75; n++) expect(at(n).name).not.toMatch(/^终局/)
    expect(at(50).name).toMatch(/^终局/)
    expect(at(50).stages).toHaveLength(3)
  })

  it.each(entries)('%s 通过关卡校验', (_file, json) => {
    expect(() => chemGame.parseLevel(json)).not.toThrow()
  })

  it.each(entries)('%s 初始局面未胜利（无空关）', (_file, json) => {
    const level = chemGame.parseLevel(json)
    expect(chemGame.isWin(chemGame.initialState(level))).toBe(false)
  })

  it.each(entries)('%s 可解且最短解长度符合设计基线', (file, json) => {
    const level = chemGame.parseLevel(json)
    const result = solve(chemGame, level, { maxDepth: 30 })
    expect(result.solved).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.solution.length, `最短解长度应与 ${file} 的设计意图一致`).toBe(
      baseline[file],
    )
    expect(level.par, `${file} 的 JSON 标准杆应与最短解基线一致`).toBe(baseline[file])
  })

  it('10–LV.999 每关带 hint 且不泄露解法箭头序列', () => {
    for (const [file, json] of entries.slice(9)) {
      const level = chemGame.parseLevel(json)
      expect(level.hint, `${file} 缺少教学 hint`).toBeTruthy()
      expect(level.hint).not.toMatch(/[↑↓←→]{2,}/)
    }
  })

  it('全部关卡 hint 使用定名术语：不含 design §10 术语表淘汰的说法', () => {
    // 每个概念只保留一个玩家可见词；淘汰清单见 docs/design.md §10「游戏内术语表与文案风格」。
    // 2026-08-28 文案整治覆盖 01–56；#62 起已套用到 57–74 与 LV.999，守护全部关卡。
    const banned = [
      '离去珠', '飞珠', '被顶出', '余料', '终投', '注入物', '喷流', '转轴', '触光', '照光',
      '点火', '点燃', '震动', '闸门', '回授', '阶段锁', '条件锁', '关盾', '预调', '校准',
      '插槽', '游离', '构型', '纯翻转', '空翻', '翻面', '换边', '缺口', '三响', '副产物',
      '投递', '下一棒', '货物', '余波', '双态', '连锁', '180°',
    ]
    for (const [file, json] of entries) {
      const level = chemGame.parseLevel(json)
      if (!level.hint) continue
      for (const term of banned) {
        expect(level.hint, `${file} 的 hint 含淘汰术语「${term}」`).not.toContain(term)
      }
    }
  })

  it('level-11 仍强制安全色判断：红珠一次点火通关，蓝珠会烧过链尾并显著增加恢复代价', () => {
    const level = chemGame.parseLevel(levelFiles['./levels/level-11.json'])
    let safe = initialState(level)
    for (const d of ['W', 'E', 'N'] as const) safe = step(safe, d)
    const safeResult = solveFrom(chemGame, safe, { maxDepth: 12 })
    expect(safeResult.solved).toBe(true)
    expect(safeResult.solution.length).toBe(4)

    let dangerous = initialState(level)
    for (const d of ['E', 'W', 'N'] as const) dangerous = step(dangerous, d)
    const dangerousResult = solveFrom(chemGame, dangerous, { maxDepth: 30 })
    expect(dangerousResult.solved).toBe(true)
    expect(dangerousResult.solution.length).toBe(16)

    // 若仍按教学路线去点左侧，蓝色会把 B→C 接通，C 的初始 ✓ 被翻掉。
    for (const d of ['W', 'W', 'N', 'E'] as const) dangerous = step(dangerous, d)
    expect(dangerous.centers[2].arms.N).not.toBe('red')
    expect(dangerous.won).toBe(false)
  })

  it('level-19 空穴断路器：最短解先断开链尾，再翻空穴接通；缺少接通事件无等长解', () => {
    const file = './levels/level-19.json'
    const transitions = shortestTransitions(file)
    const breaksTail = (t: Transition): boolean =>
      holeAt(t.before, 1) === 'W' &&
      holeAt(t.after, 1) === 'E' &&
      centerChanged(t, 0) &&
      !centerChanged(t, 2)
    const connectsTail = (t: Transition): boolean =>
      holeAt(t.before, 1) === 'E' &&
      holeAt(t.after, 1) === 'W' &&
      centerChanged(t, 2)

    expect(transitions.some(breaksTail)).toBe(true)
    expect(transitions.some(connectsTail)).toBe(true)
    const level = chemGame.parseLevel(levelFiles[file])
    expect(hasWinningPathAvoiding(level, baseline[file], connectsTail)).toBe(false)
  })

  it('level-20 空穴保险丝：共振命中三臂中心后先翻洞，已达标链尾保持不动', () => {
    const file = './levels/level-20.json'
    const transitions = shortestTransitions(file)
    const protectsTail = (t: Transition): boolean =>
      holeAt(t.before, 1) === 'W' &&
      holeAt(t.after, 1) === 'E' &&
      centerChanged(t, 0) &&
      centerChanged(t, 1) &&
      !centerChanged(t, 2)

    expect(transitions).toHaveLength(1)
    expect(protectsTail(transitions[0])).toBe(true)
    const level = chemGame.parseLevel(levelFiles[file])
    expect(hasWinningPathAvoiding(level, baseline[file], protectsTail)).toBe(false)
  })

  it('level-21 南北换路：两次翻洞分别只接通北支与南支，任一事件缺失均无等长解', () => {
    const file = './levels/level-21.json'
    const transitions = shortestTransitions(file)
    const northRoute = (t: Transition): boolean =>
      holeAt(t.before, 0) === 'N' &&
      holeAt(t.after, 0) === 'S' &&
      centerChanged(t, 1) &&
      !centerChanged(t, 2)
    const southRoute = (t: Transition): boolean =>
      holeAt(t.before, 0) === 'S' &&
      holeAt(t.after, 0) === 'N' &&
      !centerChanged(t, 1) &&
      centerChanged(t, 2)

    expect(transitions.some(northRoute)).toBe(true)
    expect(transitions.some(southRoute)).toBe(true)
    const level = chemGame.parseLevel(levelFiles[file])
    expect(hasWinningPathAvoiding(level, baseline[file], northRoute)).toBe(false)
    expect(hasWinningPathAvoiding(level, baseline[file], southRoute)).toBe(false)
  })

  it('level-23 双染引链：两次染色缺一不可，第二次染色的输入来自第一次换出的珠', () => {
    const file = './levels/level-23.json'
    expect(shortestInteractionTrace(file)).toEqual([
      'carry:empty>purple',
      'attack:1:purple',
      'attack:0:yellow',
    ])

    // 约束：不存在绕开第二次染色（对中心 0 的持珠进攻）的等长解
    const level = chemGame.parseLevel(levelFiles[file])
    expect(
      hasWinningPathAvoiding(level, baseline[file], (t) => {
        if (t.before.player[0] !== t.after.player[0] || t.before.player[1] !== t.after.player[1])
          return false
        const [dx, dy] = DIR_VEC[t.action]
        const target = t.before.centers.findIndex(
          (c) => c.pos[0] === t.before.player[0] + dx && c.pos[1] === t.before.player[1] + dy,
        )
        return target === 0 && t.before.holding !== null
      }),
    ).toBe(false)
  })

  it('level-34 开罩接空穴：第一击连锁够到护罩但被拦下，开罩后罩内中心才被使用', () => {
    const file = './levels/level-34.json'
    const transitions = shortestTransitions(file)
    const firstStrike = transitions[0]

    // 第一击：三臂中心翻转，连锁到达护罩前——罩内中心与受保护链尾都不翻，护罩在结算后解除
    expect(centerChanged(firstStrike, 1)).toBe(true)
    expect(centerChanged(firstStrike, 2)).toBe(false)
    expect(centerChanged(firstStrike, 3)).toBe(false)
    expect(firstStrike.before.stage).toBe(0)
    expect(firstStrike.after.stage).toBe(1)
    expect(isShielded(firstStrike.before, firstStrike.before.centers[2])).toBe(true)
    expect(isShielded(firstStrike.after, firstStrike.after.centers[2])).toBe(false)

    // 罩内中心的变化只发生在解锁之后的动作
    const usedAfterRelease = transitions.findIndex((t) => centerChanged(t, 2))
    expect(usedAfterRelease).toBeGreaterThan(0)

    // 去罩对照：没有护罩时连锁第一击就贯穿，整关退化为一步——护罩是硬约束
    const stripped = JSON.parse(JSON.stringify(levelFiles[file])) as {
      centers: { shieldUntilStage?: number }[]
    }
    for (const center of stripped.centers) delete center.shieldUntilStage
    const noShield = solve(chemGame, chemGame.parseLevel(stripped), { maxDepth: 30 })
    expect(noShield.solved).toBe(true)
    expect(noShield.solution.length).toBeLessThan(baseline[file])
  })

  it('level-45 开罩接三路：第一击的南向连锁被护罩拦下，奇偶复位后才接通', () => {
    const file = './levels/level-45.json'
    const transitions = shortestTransitions(file)
    const firstStrike = transitions[0]

    // 第一击：S 与三臂中心翻转，北支无事、南向连锁被护罩拦下；护罩在结算后解除
    expect(centerChanged(firstStrike, 0)).toBe(true)
    expect(centerChanged(firstStrike, 1)).toBe(true)
    expect(centerChanged(firstStrike, 3)).toBe(false)
    expect(firstStrike.before.stage).toBe(0)
    expect(firstStrike.after.stage).toBe(1)
    expect(isShielded(firstStrike.before, firstStrike.before.centers[3])).toBe(true)
    expect(isShielded(firstStrike.after, firstStrike.after.centers[3])).toBe(false)

    // 护罩中心的翻转发生在后续动作（奇偶复位后的连锁）
    const reachedAfterRelease = transitions.findIndex((t) => centerChanged(t, 3))
    expect(reachedAfterRelease).toBeGreaterThan(0)
    expect(reachedAfterRelease).toBe(transitions.length - 1)

    // 去罩对照：没有护罩时第一击连锁直接贯穿通关——护罩是硬约束
    const stripped = JSON.parse(JSON.stringify(levelFiles[file])) as {
      centers: { shieldUntilStage?: number }[]
    }
    for (const center of stripped.centers) delete center.shieldUntilStage
    const noShield = solve(chemGame, chemGame.parseLevel(stripped), { maxDepth: 30 })
    expect(noShield.solved).toBe(true)
    expect(noShield.solution.length).toBeLessThan(baseline[file])
  })

  it.each([
    [43, ['stage', 'reactive', 'multi-center']],
    [46, ['hole', 'stage-shield', 'eject', 'carry', 'multi-center']],
    [48, ['light', 'hole', 'reactive', 'multi-center', 'stage']],
    [49, ['light', 'eject', 'carry']],
    [51, ['light', 'stage-shield', 'reactive', 'hole', 'eject', 'hit-center']],
    [52, ['hole', 'reactive', 'eject', 'carry']],
    [53, ['stage-shield', 'eject', 'hit-center', 'multi-center', 'carry']],
    [54, ['light', 'stage-shield', 'carry', 'stage']],
    [55, ['hole', 'stage-shield', 'eject', 'carry', 'multi-center']],
    [56, ['light', 'stage-shield', 'reactive', 'hole', 'eject', 'hit-center', 'carry']],
  ] as const)('level-%s 综合关的最短解实际使用全部设计机制', (number, expected) => {
    const file = `./levels/level-${number}.json`
    const events = shortestMechanismEvents(file)
    expect(events.size, `${file} 至少应有三类实际机制事件`).toBeGreaterThanOrEqual(3)
    for (const event of expected) expect(events, `${file} 缺少 ${event} 事件`).toContain(event)
  })

  it.each([
    ['./levels/level-51.json', 0, 2],
    ['./levels/level-53.json', 0, 1],
    ['./levels/level-56.json', 1, 3],
  ] as const)('%s 的最短解必须由弹射珠撞翻指定远端中心', (file, launcher, target) => {
    const hitsTarget = (t: Transition): boolean =>
      attackedCenter(t) === launcher && isEjection(t, launcher) && centerChanged(t, target)
    const transitions = shortestTransitions(file)
    expect(transitions.some(hitsTarget)).toBe(true)

    const level = chemGame.parseLevel(levelFiles[file])
    expect(hasWinningPathAvoiding(level, baseline[file], hitsTarget)).toBe(false)
  })

  it('level-52 缺口缓冲：三臂控制臂往返，关盾期间飞珠落地但不撞翻罩内中心', () => {
    const file = './levels/level-52.json'
    expect(reactiveShieldPhases(file)).toEqual([false, true, false])
    const transitions = shortestTransitions(file)
    const bufferedShot = transitions.find(
      (t) => isEjection(t, 2) && isShielded(t.before, t.before.centers[1]),
    )
    expect(bufferedShot).toBeDefined()
    expect(centerChanged(bufferedShot!, 1)).toBe(false)
    expect(holeAt(transitions[2].before, 0)).toBe('W')
    expect(holeAt(transitions[2].after, 0)).toBe('E')
    expect(holeAt(transitions.at(-1)!.before, 0)).toBe('E')
    expect(holeAt(transitions.at(-1)!.after, 0)).toBe('W')
    expect(centerChanged(transitions.at(-1)!, 4), '缺口复位后必须接通新增链尾').toBe(true)

    const opensTail = (t: Transition): boolean =>
      holeAt(t.before, 0) === 'E' && holeAt(t.after, 0) === 'W' && centerChanged(t, 4)
    const level = chemGame.parseLevel(levelFiles[file])
    expect(hasWinningPathAvoiding(level, baseline[file], opensTail)).toBe(false)
  })

  it('level-43 双态闸门：同一控制臂把通行权从下闸交给上闸', () => {
    const file = './levels/level-43.json'
    const transitions = shortestTransitions(file)
    const states = [transitions[0].before, ...transitions.map((t) => t.after)]
    const lower = states.map((state) => isShielded(state, state.centers[2]))
    const upper = states.map((state) => isShielded(state, state.centers[3]))
    expect(lower[0]).toBe(false)
    expect(upper[0]).toBe(true)
    expect(lower.some((shielded, index) => shielded && !upper[index])).toBe(true)
    expect(centerChanged(transitions[0], 2)).toBe(true)
    expect(centerChanged(transitions.at(-1)!, 3)).toBe(true)
  })

  it('level-49 双喷口接力：两次喷流的输出依次成为下一次输入', () => {
    expect(shortestInteractionTrace('./levels/level-49.json')).toEqual([
      'carry:empty>purple',
      'attack:0:purple',
      'carry:empty>blue',
      'attack:1:blue',
      'carry:empty>green',
      'attack:2:green',
    ])
  })

  it('level-48 光启缺口：只预调一次光，三臂反馈令再生闸门开→关→开', () => {
    const file = './levels/level-48.json'
    const level = chemGame.parseLevel(levelFiles[file])
    const lightKeys = new Set(level.lights.map(([x, y]) => cellKey(x, y)))
    const transitions = shortestTransitions(file)
    expect(
      transitions.filter(
        (t) =>
          (t.before.player[0] !== t.after.player[0] || t.before.player[1] !== t.after.player[1]) &&
          lightKeys.has(cellKey(t.after.player[0], t.after.player[1])),
      ),
    ).toHaveLength(1)
    expect(reactiveShieldPhases(file)).toEqual([true, false, true, false])

    const opensGap = (t: Transition): boolean =>
      holeAt(t.before, 2) === 'E' && holeAt(t.after, 2) === 'W'
    const closesGap = (t: Transition): boolean =>
      holeAt(t.before, 2) === 'W' && holeAt(t.after, 2) === 'E'
    expect(transitions.some(opensGap)).toBe(true)
    expect(transitions.some(closesGap)).toBe(true)
    expect(hasWinningPathAvoiding(level, baseline[file], opensGap)).toBe(false)
    expect(hasWinningPathAvoiding(level, baseline[file], closesGap)).toBe(false)
  })

  it.each([
    ['./levels/level-55.json', ['attack:2:green', 'carry:empty>red', 'attack:4:red']],
    ['./levels/level-46.json', ['attack:1:purple', 'carry:empty>blue', 'attack:3:blue']],
    ['./levels/level-56.json', ['attack:1:blue', 'carry:empty>red', 'attack:2:red']],
  ] as const)('%s 弹射余料必须被回收并投入终段', (file, requiredTail) => {
    const trace = shortestInteractionTrace(file)
    let cursor = 0
    for (const event of trace) {
      if (event === requiredTail[cursor]) cursor++
    }
    expect(cursor).toBe(requiredTail.length)
  })

  it.each([
    [57, ['stage', 'hole', 'eject', 'hit-center', 'carry', 'multi-center']],
    [58, ['stage', 'hole', 'eject', 'hit-center', 'carry', 'multi-center']],
    [59, ['stage', 'hole', 'eject', 'hit-center', 'reactive', 'multi-center']],
    [60, ['light', 'stage-shield', 'hole', 'carry', 'stage']],
    [61, ['light', 'eject', 'hit-center', 'carry', 'stage']],
    [62, ['stage', 'hole', 'reactive', 'carry', 'multi-center']],
    [63, ['light', 'hole', 'eject', 'hit-center', 'carry', 'multi-center', 'stage']],
    [64, ['light', 'stage-shield', 'eject', 'hit-center', 'carry', 'multi-center', 'stage']],
    [65, ['light', 'hole', 'eject', 'hit-center', 'reactive', 'carry', 'multi-center', 'stage']],
    [66, ['light', 'hole', 'eject', 'hit-center', 'reactive', 'carry', 'multi-center', 'stage']],
    [75, ['light', 'hole', 'eject', 'hit-center', 'reactive', 'carry', 'multi-center', 'stage']],
  ] as const)('level-%s 高难关的最短解实际使用全部设计机制', (number, expected) => {
    const file = `./levels/level-${number}.json`
    const events = shortestMechanismEvents(file)
    expect(events.size, `${file} 至少应有三类实际机制事件`).toBeGreaterThanOrEqual(3)
    for (const event of expected) expect(events, `${file} 缺少 ${event} 事件`).toContain(event)
  })

  it.each([
    ['./levels/level-57.json', 1, 0],
    ['./levels/level-58.json', 0, 1],
    ['./levels/level-59.json', 4, 3],
    ['./levels/level-61.json', 0, 1],
    ['./levels/level-64.json', 1, 2],
    ['./levels/level-65.json', 5, 4],
    ['./levels/level-66.json', 5, 4],
    ['./levels/level-75.json', 4, 5],
  ] as const)('%s 撞核命题不可绕开：最短解必须由弹射珠撞翻指定目标', (file, launcher, target) => {
    const hitsTarget = (t: Transition): boolean =>
      attackedCenter(t) === launcher && isEjection(t, launcher) && centerChanged(t, target)
    const transitions = shortestTransitions(file)
    expect(transitions.some(hitsTarget)).toBe(true)

    const level = chemGame.parseLevel(levelFiles[file])
    expect(hasWinningPathAvoiding(level, baseline[file], hitsTarget)).toBe(false)
  })

  it('level-59 撞核关闸：撞击瞬间闸门合上，罩内受害者保持达标；去掉再生护罩则不可解', () => {
    const file = './levels/level-59.json'
    expect(reactiveShieldPhases(file)).toEqual([false, true])
    const transitions = shortestTransitions(file)
    const shot = transitions.find((t) => isEjection(t, 4))
    expect(shot).toBeDefined()
    expect(isShielded(shot!.after, shot!.after.centers[1]), '撞击后闸门必须已合上').toBe(true)
    expect(centerChanged(shot!, 1), '关闸后闸内中心不得再翻').toBe(false)
    expect(centerChanged(shot!, 2), '关闸后链尾不得再翻').toBe(false)

    const unshieldedBefore: ChemState = {
      ...shot!.before,
      centers: shot!.before.centers.map((c, i) => (i === 1 ? { ...c, reactiveTo: undefined } : c)),
    }
    const wouldBurn = step(unshieldedBefore, shot!.action)
    expect(
      wouldBurn.centers[1].arms,
      '同一发射若无护罩，共振必须烧进闸内',
    ).not.toBe(unshieldedBefore.centers[1].arms)

    const level = chemGame.parseLevel(levelFiles[file])
    expect(solve(chemGame, withoutReactiveShields(level), { maxDepth: 30 }).solved).toBe(false)
  })

  it('level-62 空手关闸：关闸只能空手（持珠会污染监视臂）；去掉再生护罩则不可解', () => {
    const file = './levels/level-62.json'
    expect(reactiveShieldPhases(file)).toEqual([false, true])
    const latch = (t: Transition): boolean =>
      attackedCenter(t) === 5 && t.before.holding === null && centerChanged(t, 5)
    const transitions = shortestTransitions(file)
    expect(transitions.some(latch)).toBe(true)

    const level = chemGame.parseLevel(levelFiles[file])
    expect(hasWinningPathAvoiding(level, baseline[file], latch)).toBe(false)
    expect(solve(chemGame, withoutReactiveShields(level), { maxDepth: 30 }).solved).toBe(false)
  })

  it('level-60 双光时序：两块光照格各只踏一次，北闸先于南闸被使用', () => {
    const file = './levels/level-60.json'
    const level = chemGame.parseLevel(levelFiles[file])
    const lightKeys = new Set(level.lights.map(([x, y]) => cellKey(x, y)))
    const visits = new Map<string, number>()
    for (const t of shortestTransitions(file)) {
      const key = cellKey(t.after.player[0], t.after.player[1])
      if (lightKeys.has(key)) visits.set(key, (visits.get(key) ?? 0) + 1)
    }
    expect(visits.size).toBe(2)
    for (const [key, count] of visits) {
      expect(count, `光照格 ${key} 被踏入 ${count} 次`).toBe(1)
    }

    const transitions = shortestTransitions(file)
    const northUsed = transitions.findIndex((t) => centerChanged(t, 1))
    const southUsed = transitions.findIndex((t) => centerChanged(t, 2))
    expect(northUsed).toBeGreaterThanOrEqual(0)
    expect(southUsed).toBeGreaterThan(northUsed)
  })

  it('level-63 三级火箭：一颗种子珠依次烧穿三级喷口', () => {
    expect(shortestInteractionTrace('./levels/level-63.json')).toEqual([
      'carry:empty>green',
      'attack:0:green',
      'carry:empty>blue',
      'attack:1:blue',
      'carry:empty>purple',
      'attack:2:purple',
    ])
  })

  it('level-66 第二级喷料的落点必须在远端光照格上，并转出末段进攻位', () => {
    const file = './levels/level-66.json'
    const level = chemGame.parseLevel(levelFiles[file])
    const lightKey = cellKey(7, 1)
    const shot = shortestTransitions(file).find(
      (t) => isEjection(t, 3) && t.after.groups.some((g) => cellKey(g.pos[0], g.pos[1]) === lightKey),
    )
    expect(shot, '第二级喷料必须落在远端光照格').toBeDefined()

    const finalAttack = shortestTransitions(file).find((t) => centerChanged(t, 6))
    expect(finalAttack).toBeDefined()
    expect(finalAttack!.before.centers[6].leaving, '末段三臂中心必须被转到开口 N').toBe('N')
    expect(level.lights.some(([x, y]) => cellKey(x, y) === lightKey)).toBe(true)
  })

  it('level-75 以 LV.999 特殊 ID 收尾：01 复刻口袋 + 重写总线 + 全机制闭环零冗余', () => {
    const file = './levels/level-75.json'
    const level = chemGame.parseLevel(levelFiles[file])
    expect(level.id).toBe('109.5°-999')
    expect(level.name).toBe('GAME NOT OVER')
    expect(level.stages).toHaveLength(4)
    expect(level.lights).toHaveLength(2)
    expect(level.centers.filter((center) => center.ejects)).toHaveLength(2)
    expect(level.centers.filter((center) => center.kind === 'trigonal')).toHaveLength(2)
    expect(level.centers.filter((center) => center.reactiveTo !== undefined)).toHaveLength(1)
    // 全锁设施：盾 1（T1/V，段 1 开）与盾 2（E2/G1，段 2 开）各两座，锁廊里锁号不同
    expect(level.centers.filter((center) => center.shieldUntilStage === 1)).toHaveLength(2)
    expect(level.centers.filter((center) => center.shieldUntilStage === 2)).toHaveLength(2)
    expect(level.moveLimit).toBe(baseline[file])

    // 口袋 = 01 复刻：出生点、中心 0 构型与首段目标逐字段一致，最短解前两步就是 01 的解
    const lv01 = chemGame.parseLevel(levelFiles['./levels/level-01.json'])
    expect(level.player).toEqual(lv01.player)
    expect(level.centers[0].arms).toEqual(lv01.centers[0].arms)
    expect(level.centers[0].leaving).toBe(lv01.centers[0].leaving)
    expect(level.stages[0].goals).toEqual(lv01.stages[0].goals)
    const solution = solve(chemGame, level, { maxDepth: 30 }).solution
    expect(solution.slice(0, 2)).toEqual(solve(chemGame, lv01, { maxDepth: 10 }).solution)

    // 重写总线的结构性保护：中心 1–3 的进攻位被总线邻座永久占据，只有共振能翻动它们
    for (const i of [1, 2, 3]) {
      const [dx, dy] = DIR_VEC[opposite(level.centers[i].leaving)]
      const attackX = level.centers[i].pos[0] + dx
      const attackY = level.centers[i].pos[1] + dy
      expect(
        level.centers.some((c) => c.pos[0] === attackX && c.pos[1] === attackY),
        `中心 ${i} 的进攻位应被总线邻座占据`,
      ).toBe(true)
    }
  })

  it('level-75 第 999 场：第二步重写五中心；假绝路内只有口袋能推进；弹射回扫全总线', () => {
    const file = './levels/level-75.json'
    const level = chemGame.parseLevel(levelFiles[file])
    const transitions = shortestTransitions(file)

    // 第二步收尾 01 复刻：一次动作翻转口袋 + 总线共 5 座中心，阶段 0 → 1，主盘纹丝不动
    const rewrite = transitions[1]
    expect(rewrite.before.stage).toBe(0)
    expect(rewrite.after.stage).toBe(1)
    expect([0, 1, 2, 3, 4].every((i) => centerChanged(rewrite, i))).toBe(true)
    expect([5, 6, 7, 8, 9, 10].every((i) => !centerChanged(rewrite, i))).toBe(true)

    // 假绝路：不直接进攻口袋中心，阶段永远无法推进（深度 10 穷举全部非等价局面）
    let frontier: ChemState[] = [initialState(level)]
    const visited = new Set([chemGame.stateKey(frontier[0])])
    let escaped = false
    for (let depth = 0; depth < 10; depth++) {
      const next: ChemState[] = []
      for (const before of frontier) {
        for (const action of chemGame.actions(before)) {
          const after = step(before, action)
          if (chemGame.stateKey(after) === chemGame.stateKey(before)) continue
          if (attackedCenter({ before, after, action }) === 0) continue
          if (after.stage > 0) escaped = true
          const key = chemGame.stateKey(after)
          if (!visited.has(key) && !after.won) {
            visited.add(key)
            next.push(after)
          }
        }
      }
      frontier = next
    }
    expect(escaped, '除口袋进攻外不应存在任何推进阶段的路线').toBe(false)

    // HUB 弹射回扫：撞翻 T1 的同一动作把总线翻回开局构型（单动作 7 座，全游戏最长）
    const hubShot = transitions.find((t) => isEjection(t, 4))
    expect(hubShot, '最短解必须包含对 HUB 的持珠弹射').toBeDefined()
    expect(centerChanged(hubShot!, 5), 'T1 必须被飞珠撞翻').toBe(true)
    expect(centerChanged(hubShot!, 6), 'V 必须被共振续翻').toBe(true)
    expect([0, 1, 2, 3].every((i) => centerChanged(hubShot!, i)), '总线必须整体回扫').toBe(true)
    for (const i of [0, 1, 2, 3]) {
      expect(hubShot!.after.centers[i].arms, `总线中心 ${i} 应回到开局构型`).toEqual(
        initialState(level).centers[i].arms,
      )
    }

    // 末段：拾蓝必须踩光，R 的终投在南侧进攻位完成并共振翻 F
    const lightKeys = new Set(level.lights.map(([x, y]) => cellKey(x, y)))
    const finalPickup = transitions.find(
      (t) => t.after.holding === 'blue' && t.before.holding === null,
    )
    expect(finalPickup, '必须从光照格拾起蓝珠').toBeDefined()
    expect(lightKeys.has(cellKey(finalPickup!.after.player[0], finalPickup!.after.player[1]))).toBe(
      true,
    )
    const final = transitions.at(-1)!
    expect(attackedCenter(final)).toBe(9)
    expect(final.before.centers[9].leaving, '踩光后 R 的开口必须朝北').toBe('N')
    expect(centerChanged(final, 10), '终投 R 必须共振翻 F').toBe(true)
    expect(final.after.won).toBe(true)

    // 双光陷阱：通往圣所的光照格恰好踏入一次；盾门暗格里的陷阱光格 (8,0) 最短解从不踏入
    const visits = new Map<string, number>()
    for (const t of transitions) {
      const key = cellKey(t.after.player[0], t.after.player[1])
      if (lightKeys.has(key)) visits.set(key, (visits.get(key) ?? 0) + 1)
    }
    expect(visits.get(cellKey(3, 4)), '拾蓝光照格应恰好踏入一次').toBe(1)
    expect(visits.get(cellKey(8, 0)), '陷阱光照格不应出现在最短解').toBeUndefined()
  })

  it.each([
    [67, ['stage', 'hole', 'carry', 'multi-center']],
    [68, ['stage', 'hole', 'carry', 'multi-center']],
    [69, ['stage', 'hole', 'carry', 'multi-center', 'eject', 'hit-center', 'stage-shield']],
    [70, ['stage', 'light', 'carry', 'eject', 'hit-center']],
    [71, ['stage', 'light', 'hole', 'carry', 'eject', 'hit-center', 'multi-center']],
    [72, ['stage', 'light', 'stage-shield', 'carry', 'eject', 'hit-center', 'multi-center']],
    [73, ['stage', 'light', 'hole', 'reactive', 'carry', 'eject', 'hit-center', 'multi-center']],
    [74, ['stage', 'hole', 'carry', 'multi-center', 'eject', 'hit-center']],
  ] as const)('level-%s 转辙/红线关的最短解实际使用全部设计机制', (number, expected) => {
    const file = `./levels/level-${number}.json`
    const events = shortestMechanismEvents(file)
    expect(events.size, `${file} 至少应有三类实际机制事件`).toBeGreaterThanOrEqual(3)
    for (const event of expected) expect(events, `${file} 缺少 ${event} 事件`).toContain(event)
  })

  it('预算关红线分两档：零冗余关（含 LV.999）= 最短解，其余 = 最短解 + 3', () => {
    const tight = new Set([69, 70, 71, 74, 75])
    for (const [file, json] of entries) {
      const level = chemGame.parseLevel(json)
      if (level.moveLimit === undefined) continue
      const number = Number(/level-(\d+)\.json$/.exec(file)?.[1])
      const result = solve(chemGame, level, { maxDepth: 30 })
      expect(result.solved, `${file} 预算内必须可解`).toBe(true)
      if (tight.has(number)) {
        expect(level.moveLimit, `${file} 是零冗余红线关，moveLimit 应恰为最短解`).toBe(
          result.solution.length,
        )
      } else {
        expect(
          level.moveLimit,
          `${file} 的 moveLimit 应为最短解 + 3（宽松红线统一口径）`,
        ).toBe(result.solution.length + 3)
      }
    }
  })

  it('level-67 北口回声：第一波同时出北口与东口，第二波借北口进、南口出', () => {
    const file = './levels/level-67.json'
    const transitions = shortestTransitions(file)
    const wave1 = transitions.find(
      (t) => attackedCenter(t) === 0 && centerChanged(t, 2) && centerChanged(t, 4),
    )
    expect(wave1, '第一波应一次点燃北口与东口两座终端').toBeDefined()
    expect(wave1!.before.stage).toBe(0)
    expect(wave1!.after.stage).toBe(1)
    const wave2 = transitions.find((t) => attackedCenter(t) === 2 && centerChanged(t, 3))
    expect(wave2, '第二波应从北口回传、南口输出').toBeDefined()

    const level = chemGame.parseLevel(levelFiles[file])
    expect(
      hasWinningPathAvoiding(level, baseline[file], (t) => attackedCenter(t) === 2 && centerChanged(t, 3)),
    ).toBe(false)
  })

  it('level-68 唤醒：北口开火必须晚于西口（奇偶锁死顺序）', () => {
    const file = './levels/level-68.json'
    const transitions = shortestTransitions(file)
    const west = transitions.findIndex((t) => attackedCenter(t) === 0)
    const north = transitions.findIndex((t) => attackedCenter(t) === 1)
    expect(west).toBeGreaterThanOrEqual(0)
    expect(north).toBeGreaterThan(west)

    // 结构性验证：北口先开火时波传不进去（S2 翻转后的南臂 = 其初始北臂 ≠ T 初始北臂）
    const level = chemGame.parseLevel(levelFiles[file])
    const s0 = initialState(level)
    const t = s0.centers[2]
    const s2 = s0.centers[1]
    expect(t.arms.N === s2.arms.N).toBe(false)
    expect(
      hasWinningPathAvoiding(level, baseline[file], (tr) => attackedCenter(tr) === 0 && centerChanged(tr, 3)),
    ).toBe(false)
  })

  it.each([
    ['./levels/level-69.json', 4, 1],
    ['./levels/level-74.json', 4, 1],
  ] as const)('%s 红线下撞核不可替代：预算内不存在绕开撞击的通关路径', (file, launcher, target) => {
    const level = chemGame.parseLevel(levelFiles[file])
    const hitsTarget = (t: Transition): boolean =>
      attackedCenter(t) === launcher && isEjection(t, launcher) && centerChanged(t, target)
    const transitions = shortestTransitions(file)
    expect(transitions.some(hitsTarget)).toBe(true)
    expect(hasWinningPathAvoiding(level, level.moveLimit!, hitsTarget)).toBe(false)
  })

  it('level-69 遥扳：撞核一次点燃两级级联（Vn → V2），步行绕行在红线外', () => {
    const file = './levels/level-69.json'
    const transitions = shortestTransitions(file)
    const doubleHop = transitions.find(
      (t) => isEjection(t, 4) && centerChanged(t, 1) && centerChanged(t, 2) && centerChanged(t, 3),
    )
    expect(doubleHop, '一发飞珠应连翻 T → Vn → V2 三座').toBeDefined()
    expect(doubleHop!.before.stage).toBe(1)

    // 漏斗墙：岔心正面 (3,2) 只能从东侧 (4,2) 进入
    const level = chemGame.parseLevel(levelFiles[file])
    expect(level.walls).toContainEqual([3, 1])
    expect(level.walls).toContainEqual([3, 3])
  })

  it('level-74 终章：同一岔心被翻三次，第三次只由飞珠完成', () => {
    const file = './levels/level-74.json'
    const transitions = shortestTransitions(file)
    const tFlips = transitions.filter((t) => centerChanged(t, 1))
    expect(tFlips.length, '岔心在最短解中恰好翻三次').toBe(3)
    const third = tFlips[2]
    expect(isEjection(third, 4), '第三翻必须来自弹射撞击').toBe(true)
    expect(third.before.centers[1].leaving).toBe('W')
  })

  it('level-47 最短解不重复踏入同一光照格（无光格乒乓）', () => {
    const file = './levels/level-47.json'
    const level = chemGame.parseLevel(levelFiles[file])
    const lightKeys = new Set(level.lights.map(([x, y]) => cellKey(x, y)))
    const visits = new Map<string, number>()
    for (const t of shortestTransitions(file)) {
      const key = cellKey(t.after.player[0], t.after.player[1])
      if (lightKeys.has(key)) visits.set(key, (visits.get(key) ?? 0) + 1)
    }
    for (const [key, count] of visits) {
      expect(count, `光照格 ${key} 被踏入 ${count} 次`).toBe(1)
    }
  })

  it('所有空穴关的最短解都实际翻动空穴，而非把三臂中心当静态摆设', () => {
    for (const [file, json] of entries) {
      const level = chemGame.parseLevel(json)
      const trigonal = level.centers
        .map((center, index) => ({ center, index }))
        .filter(({ center }) => center.kind === 'trigonal')
      if (trigonal.length === 0) continue

      const transitions = shortestTransitions(file)
      const movesHole = transitions.some((t) =>
        trigonal.some(({ index }) => {
          const before = holeAt(t.before, index)
          const after = holeAt(t.after, index)
          return before !== undefined && after === opposite(before)
        }),
      )
      expect(movesHole, `${file} 的最短解必须实际翻动空穴`).toBe(true)
    }
  })

  it('所有弹射关的最短解都实际清空手持并生成飞珠', () => {
    for (const [file, json] of entries) {
      const level = chemGame.parseLevel(json)
      if (!level.centers.some((center) => center.ejects)) continue

      const fires = shortestTransitions(file).some((t) => {
        if (t.before.holding === null || t.after.holding !== null) return false
        const [dx, dy] = DIR_VEC[t.action]
        const target = t.before.centers.findIndex(
          (center) =>
            center.pos[0] === t.before.player[0] + dx &&
            center.pos[1] === t.before.player[1] + dy,
        )
        return (
          target >= 0 &&
          t.before.centers[target].ejects &&
          centerChanged(t, target) &&
          t.after.groups.length === t.before.groups.length + 1
        )
      })
      expect(fires, `${file} 的最短解必须实际触发弹射`).toBe(true)
    }
  })

  it('所有护罩关的最短解都先按阶段解锁，再于后续动作使用罩内中心', () => {
    for (const [file, json] of entries) {
      const level = chemGame.parseLevel(json)
      const shielded = level.centers
        .map((center, index) => ({ center, index }))
        .filter(({ center }) => center.shieldUntilStage !== undefined)
      if (shielded.length === 0) continue

      const transitions = shortestTransitions(file)
      for (const { index } of shielded) {
        const release = transitions.findIndex(
          (t) => isShielded(t.before, t.before.centers[index]) && !isShielded(t.after, t.after.centers[index]),
        )
        expect(release, `${file} 的中心 ${index} 必须在最短解中按阶段解除护罩`).toBeGreaterThanOrEqual(0)
        expect(
          transitions.some((t, stepIndex) => stepIndex > release && centerChanged(t, index)),
          `${file} 的中心 ${index} 必须等到解锁后的动作才参与变化`,
        ).toBe(true)
      }
    }
  })

  it.each([
    ['./levels/level-03.json', ['carry:empty>purple', 'attack:0:purple']],
    ['./levels/level-04.json', ['carry:empty>purple', 'attack:0:purple']],
    [
      './levels/level-05.json',
      ['carry:empty>purple', 'attack:0:purple', 'attack:1:blue'],
    ],
    [
      './levels/level-06.json',
      ['attack:0:empty', 'carry:empty>purple', 'attack:1:purple'],
    ],
    [
      './levels/level-07.json',
      ['carry:empty>purple', 'attack:0:purple', 'attack:1:blue'],
    ],
    [
      './levels/level-09.json',
      ['carry:empty>purple', 'attack:0:purple'],
    ],
    [
      './levels/level-10.json',
      ['attack:0:empty', 'carry:empty>blue', 'attack:0:blue'],
    ],
    [
      './levels/level-12.json',
      ['attack:1:empty', 'carry:empty>purple', 'attack:1:purple'],
    ],
  ])('%s 最短解仍执行目标教学交互序列', (file, expected) => {
    expect(shortestInteractionTrace(file)).toEqual(expected)
  })

  it('level-07 共振首现：最后一击只直接进攻中心 B，却由新接通绿键带动中心 C', () => {
    const transitions = shortestTransitions('./levels/level-07.json')
    const final = transitions.at(-1)!
    expect(final.before.holding).toBe('blue')
    expect(centerChanged(final, 1)).toBe(true)
    expect(centerChanged(final, 2)).toBe(true)
    expect(final.before.centers[1].arms.W).toBe('green')
    expect(final.before.centers[2].arms.W).toBe('green')
    expect(
      Math.abs(final.before.player[0] - final.before.centers[2].pos[0]) +
        Math.abs(final.before.player[1] - final.before.centers[2].pos[1]),
    ).toBeGreaterThan(1)
    expect(final.after.won).toBe(true)
  })

  it('level-09 碰不到的中心：两座封锁中心从未被直接进攻，只能由共振翻转', () => {
    const file = './levels/level-09.json'
    const level = chemGame.parseLevel(levelFiles[file])

    // 结构性强制：两座右侧中心的进攻位被墙永久封死
    for (const index of [1, 2]) {
      const center = level.centers[index]
      const [dx, dy] = DIR_VEC[opposite(center.leaving)]
      const attackCell = [center.pos[0] + dx, center.pos[1] + dy]
      expect(
        level.walls.some(([x, y]) => x === attackCell[0] && y === attackCell[1]),
        `中心 ${index} 的进攻位必须是墙`,
      ).toBe(true)
    }

    const transitions = shortestTransitions(file)
    for (const t of transitions) {
      expect(
        attackedCenter(t),
        '最短解只允许直接进攻进攻位可达的中心（-1 为移动步）',
      ).toBeLessThanOrEqual(0)
    }
    expect(transitions.some((t) => attackedCenter(t) === 0)).toBe(true)
    // 一击三翻：三座中心全部变化，胜利来自同一次撞击
    const final = transitions.at(-1)!
    expect(centerChanged(final, 0)).toBe(true)
    expect(centerChanged(final, 1)).toBe(true)
    expect(centerChanged(final, 2)).toBe(true)
    expect(final.after.won).toBe(true)
  })

  it('v4 弹射打结构关：最短解必须真的用弹射中心发射（37/38/41/42）', () => {
    for (const file of [
      './levels/level-37.json',
      './levels/level-38.json',
      './levels/level-41.json',
      './levels/level-42.json',
    ]) {
      const level = chemGame.parseLevel(levelFiles[file])
      const ejectIndices = level.centers
        .map((c, i) => (c.ejects ? i : -1))
        .filter((i) => i >= 0)
      const events = shortestInteractionTrace(file)
      const usedLauncher = events.some((e) => {
        const m = /^attack:(\d+):(.+)$/.exec(e)
        return m !== null && ejectIndices.includes(Number(m[1])) && m[2] !== 'empty'
      })
      expect(usedLauncher, `${file} 最短解必须使用弹射中心发射`).toBe(true)
    }
  })

  it('v4 39 关闸保形：开→关→开，关盾确实阻断会烧坏已达标中心的共振', () => {
    const file = './levels/level-39.json'
    expect(reactiveShieldPhases(file)).toEqual([false, true, false])
    const transitions = shortestTransitions(file)
    const isolatedFlip = transitions.find(
      (t) => isShielded(t.before, t.before.centers[1]) && centerChanged(t, 2),
    )
    expect(isolatedFlip, '最短解应在关盾期间翻转共振源').toBeDefined()
    expect(centerChanged(isolatedFlip!, 1), '关盾时已达标中心必须保持不动').toBe(false)

    const unshieldedBefore: ChemState = {
      ...isolatedFlip!.before,
      centers: isolatedFlip!.before.centers.map((c, i) =>
        i === 1 ? { ...c, reactiveTo: undefined } : c,
      ),
    }
    const wouldBurn = step(unshieldedBefore, isolatedFlip!.action)
    expect(
      wouldBurn.centers[1].arms,
      '同一步若没有护罩，共振必须烧到受保护中心',
    ).not.toBe(unshieldedBefore.centers[1].arms)

    const level = chemGame.parseLevel(levelFiles[file])
    expect(solve(chemGame, withoutReactiveShields(level), { maxDepth: 30 }).solved).toBe(false)
  })

  it('v4 40 回授闸门：最短解形成闭→开→闭→开的完整反馈脉冲', () => {
    expect(reactiveShieldPhases('./levels/level-40.json')).toEqual([true, false, true, false])
  })

  it('v4 41 护罩缓冲：开→关→开，关盾期间发射只落珠、不撞翻受保护中心', () => {
    const file = './levels/level-41.json'
    expect(reactiveShieldPhases(file)).toEqual([false, true, false])
    const transitions = shortestTransitions(file)
    const bufferedShot = transitions.find(
      (t) =>
        isShielded(t.before, t.before.centers[1]) &&
        centerChanged(t, 2) &&
        t.after.groups.length > t.before.groups.length,
    )
    expect(bufferedShot, '最短解应在关盾期间使用弹射中心').toBeDefined()
    expect(centerChanged(bufferedShot!, 1), '护罩必须挡下飞珠撞核').toBe(false)

    const unshieldedBefore: ChemState = {
      ...bufferedShot!.before,
      centers: bufferedShot!.before.centers.map((c, i) =>
        i === 1 ? { ...c, reactiveTo: undefined } : c,
      ),
    }
    const wouldHit = step(unshieldedBefore, bufferedShot!.action)
    expect(wouldHit.centers[1].arms, '同一发飞珠若没有护罩，必须撞翻目标中心').not.toBe(
      unshieldedBefore.centers[1].arms,
    )

    const level = chemGame.parseLevel(levelFiles[file])
    expect(solve(chemGame, withoutReactiveShields(level), { maxDepth: 30 }).solved).toBe(false)
  })
})
