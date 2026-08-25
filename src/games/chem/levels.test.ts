import { describe, expect, it } from 'vitest'
import { DIR_VEC, opposite } from '../../core/protocol'
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

/** 设计意图基线：文件名 → 最短解步数（逐关 `pnpm solve` 核对；分段与 v3.2 正式曲线一致） */
const baseline: Record<string, number> = {
  './levels/level-01.json': 1, // 第一次撞入
  './levels/level-02.json': 5, // 从错误侧绕到背面
  './levels/level-03.json': 2, // 拾珠并第一次持珠取代
  './levels/level-04.json': 2, // 两步观察输入落臂与开口珠换手
  './levels/level-05.json': 5, // 从 A 取出蓝珠送到 B
  './levels/level-06.json': 8, // 三中心连续交换，手不会自然变空
  './levels/level-07.json': 3, // 轴臂插槽与垂臂奇偶锁
  './levels/level-08.json': 6, // 空手只有开局一次，先纯翻转再拾珠
  './levels/level-09.json': 8, // 共享站位 + 克制已达标中心
  './levels/level-10.json': 6, // 紧凑三中心颜色接力毕业
  './levels/level-11.json': 1, // 共振入门：一击翻两个中心
  './levels/level-12.json': 1, // 多米诺：三级链逐级接通
  './levels/level-13.json': 7, // 点火前先调整奇偶与手持珠
  './levels/level-14.json': 7, // 安全点火：红珠止链，蓝珠误烧链尾
  './levels/level-15.json': 9, // 奇偶序列点燃两条链
  './levels/level-16.json': 5, // 同时双响：一击点亮两个远端目标
  './levels/level-17.json': 1, // 四中心分叉链毕业
  './levels/level-18.json': 6, // 光照入门：转轴开出进攻路
  './levels/level-19.json': 7, // 分步目标入门
  './levels/level-20.json': 6, // 光照 × 共振
  './levels/level-21.json': 9, // 光照 × 分步
  './levels/level-22.json': 10, // 光照 × 搬运 × 分步
  './levels/level-23.json': 9, // 分步共振毕业
  './levels/level-24.json': 3, // 空穴断路器：先断链，翻空穴后再接通链尾
  './levels/level-25.json': 2, // 三臂中心：标准翻转 + 缺口移到对侧
  './levels/level-26.json': 9, // 光照 × 空穴 × 分步
  './levels/level-27.json': 1, // 空穴保险丝：传播后翻洞保护已达标链尾
  './levels/level-28.json': 8, // 南北双路换向：两次翻洞依次接通两支路
  './levels/level-29.json': 3, // 阶段护罩 × 空穴：开罩后扩张共振图
  './levels/level-30.json': 3, // 弹射入门：顶出珠沿身后落地
  './levels/level-31.json': 7, // 压缩后的弹射资源复用
  './levels/level-32.json': 4, // 一击三果：翻转 + 连锁 + 弹射
  './levels/level-33.json': 8, // 弹射珠跨中心复用
  './levels/level-34.json': 6, // 光照改变喷流轴
  './levels/level-35.json': 5, // 三臂弹射中心：障碍控制落点
  './levels/level-36.json': 5, // 阶段护罩：完成当步不追溯，下一步扩链
  './levels/level-37.json': 5, // 延迟连锁：下一动作才穿透护罩
  './levels/level-38.json': 3, // 多护罩按阶段依次解除
  './levels/level-39.json': 6, // 光照预对齐阶段护罩
  './levels/level-40.json': 9, // 阶段护罩 + 空穴 + 光照 + 弹射中心
  './levels/level-41.json': 3, // 阶段护罩 × 空穴扩链
  './levels/level-42.json': 4, // 阶段护罩 × 弹射 × 共振
  './levels/level-43.json': 8, // E/W 空穴双路换向
  './levels/level-44.json': 6, // 光照 × 空穴 × 搬运
  './levels/level-45.json': 7, // 双弹射资源接力
  './levels/level-46.json': 19, // 光照改轴后回收弹射珠
  './levels/level-47.json': 1, // 空穴分叉保险丝
  './levels/level-48.json': 6, // 光照预对齐三阶段护罩
  './levels/level-49.json': 8, // 护罩解除后 N/S 空穴换路
  './levels/level-50.json': 12, // 三阶段：光照 × 搬运 × 弹射 × 护罩
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

const centerChanged = (t: Transition, index: number): boolean =>
  t.before.centers[index].arms !== t.after.centers[index].arms

const holeAt = (s: ChemState, index: number): Dir | undefined =>
  (['N', 'E', 'S', 'W'] as const).find((d) => s.centers[index].arms[d] === undefined)

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

describe('chem（109.5°）正式关卡批次 01–50', () => {
  it('关卡数量与基线表一致', () => {
    expect(entries.map(([file]) => file)).toEqual(Object.keys(baseline))
    expect(entries).toHaveLength(50)
  })

  it('v3.2 正式曲线按机制段落落位', () => {
    const at = (n: number): ChemLevel =>
      chemGame.parseLevel(levelFiles[`./levels/level-${String(n).padStart(2, '0')}.json`])
    const hasAdjacentCenters = (level: ChemLevel): boolean =>
      level.centers.some((a, i) =>
        level.centers.some(
          (b, j) => i !== j && Math.abs(a.pos[0] - b.pos[0]) + Math.abs(a.pos[1] - b.pos[1]) === 1,
        ),
      )

    for (let n = 11; n <= 17; n++) expect(hasAdjacentCenters(at(n)), `level-${n} 应使用共振拓扑`).toBe(true)
    for (let n = 18; n <= 23; n++) {
      const level = at(n)
      expect(level.lights.length > 0 || level.stages.length > 1, `level-${n} 应使用光照或分步目标`).toBe(true)
    }
    for (let n = 24; n <= 29; n++) {
      expect(at(n).centers.some((c) => c.kind === 'trigonal'), `level-${n} 应使用三臂空穴`).toBe(true)
    }
    for (let n = 30; n <= 35; n++) {
      expect(at(n).centers.some((c) => c.ejects), `level-${n} 应使用弹射中心`).toBe(true)
    }
    for (let n = 36; n <= 42; n++) {
      expect(
        at(n).centers.some((c) => c.shieldUntilStage !== undefined),
        `level-${n} 应使用阶段护罩`,
      ).toBe(true)
    }
    for (let n = 43; n <= 50; n++) {
      const level = at(n)
      const usesMasteryMechanic =
        level.lights.length > 0 ||
        level.stages.length > 1 ||
        level.centers.some(
          (c) => c.kind === 'trigonal' || c.ejects || c.shieldUntilStage !== undefined,
        )
      expect(usesMasteryMechanic, `level-${n} 应深化既有机制`).toBe(true)
    }
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

  it('11–50 每关带 hint 且不泄露解法箭头序列', () => {
    for (const [file, json] of entries.slice(10)) {
      const level = chemGame.parseLevel(json)
      expect(level.hint, `${file} 缺少教学 hint`).toBeTruthy()
      expect(level.hint).not.toMatch(/[↑↓←→]{2,}/)
    }
  })

  it('level-14 仍强制安全色判断：红珠一次点火通关，蓝珠会烧过链尾并显著增加恢复代价', () => {
    const level = chemGame.parseLevel(levelFiles['./levels/level-14.json'])
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

  it('level-24 空穴断路器：最短解先断开链尾，再翻空穴接通；缺少接通事件无等长解', () => {
    const file = './levels/level-24.json'
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

  it('level-27 空穴保险丝：共振命中三臂中心后先翻洞，已达标链尾保持不动', () => {
    const file = './levels/level-27.json'
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

  it('level-28 南北换路：两次翻洞分别只接通北支与南支，任一事件缺失均无等长解', () => {
    const file = './levels/level-28.json'
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

  it('level-29 阶段拓扑：第一段断链后护罩解除，第二段翻洞才把新节点纳入', () => {
    const file = './levels/level-29.json'
    const transitions = shortestTransitions(file)
    const opensShieldBehindGap = (t: Transition): boolean =>
      t.before.stage === 0 &&
      t.after.stage === 1 &&
      isShielded(t.before, t.before.centers[2]) &&
      !isShielded(t.after, t.after.centers[2]) &&
      holeAt(t.after, 1) === 'E' &&
      !centerChanged(t, 2)
    const expandsTopology = (t: Transition): boolean =>
      t.before.stage === 1 &&
      holeAt(t.before, 1) === 'E' &&
      holeAt(t.after, 1) === 'W' &&
      centerChanged(t, 2)

    expect(transitions.some(opensShieldBehindGap)).toBe(true)
    expect(transitions.some(expandsTopology)).toBe(true)
    const level = chemGame.parseLevel(levelFiles[file])
    expect(hasWinningPathAvoiding(level, baseline[file], opensShieldBehindGap)).toBe(false)
    expect(hasWinningPathAvoiding(level, baseline[file], expandsTopology)).toBe(false)
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
      ['carry:empty>purple', 'attack:0:purple', 'attack:1:blue', 'attack:2:green'],
    ],
    ['./levels/level-07.json', ['carry:empty>purple', 'attack:0:purple']],
    [
      './levels/level-08.json',
      ['attack:0:empty', 'carry:empty>purple', 'attack:1:purple'],
    ],
    [
      './levels/level-09.json',
      ['carry:empty>blue', 'attack:2:blue', 'attack:1:yellow'],
    ],
    [
      './levels/level-10.json',
      ['carry:empty>purple', 'attack:0:purple', 'attack:1:blue', 'attack:2:green'],
    ],
    [
      './levels/level-13.json',
      ['attack:0:empty', 'carry:empty>blue', 'attack:0:blue'],
    ],
    [
      './levels/level-15.json',
      ['attack:1:empty', 'carry:empty>purple', 'attack:1:purple'],
    ],
  ])('%s 最短解仍执行目标教学交互序列', (file, expected) => {
    expect(shortestInteractionTrace(file)).toEqual(expected)
  })
})
