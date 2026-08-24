import { describe, expect, it } from 'vitest'
import { DIR_VEC } from '../../core/protocol'
import type { Dir } from '../../core/protocol'
import { solve, solveFrom } from '../../core/solver'
import { chemGame, initialState, step } from './engine'

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

/** 设计意图基线：文件名 → 最短解步数（逐关 `pnpm solve` 核对；11–15 为 v1 搬运批次，16–20 为 v2 共振批次，21–40 为 v3 机制群批次） */
const baseline: Record<string, number> = {
  './levels/level-01.json': 1, // 第一次撞入
  './levels/level-02.json': 5, // 站到背面去
  './levels/level-03.json': 4, // 读开口方向
  './levels/level-04.json': 7, // 墙与绕行
  './levels/level-05.json': 10, // 完整路线规划
  './levels/level-06.json': 13, // 两个中心
  './levels/level-07.json': 13, // 顺序有代价
  './levels/level-08.json': 7, // 克制：别碰已达标中心
  './levels/level-09.json': 19, // 房间与门
  './levels/level-10.json': 20, // 综合毕业
  './levels/level-11.json': 6, // 拾取与投放（v1 搬运）
  './levels/level-12.json': 11, // 跨中心取送
  './levels/level-13.json': 10, // 循环交换（压缩纯通勤）
  './levels/level-14.json': 10, // 空手一击的时机（手不可再空；压缩纯通勤）
  './levels/level-15.json': 8, // 毕业题：同一位两扇门（压缩纯通勤）
  './levels/level-16.json': 4, // 共振：一击翻两个中心
  './levels/level-17.json': 7, // 多米诺：三级链逐级接通
  './levels/level-18.json': 7, // 点火之前：奇偶点火 + 换站位 + 换手（压缩纯通勤）
  './levels/level-19.json': 7, // 断链简化版：近身二选一，红珠安全 / 蓝珠误烧链尾
  './levels/level-20.json': 9, // 毕业：奇偶序列点燃两条链（压缩纯通勤）
  './levels/level-21.json': 6, // 光照格：转轴开出进攻路
  './levels/level-22.json': 13, // 回收格：打破手持不变式
  './levels/level-23.json': 6, // 光 × 共振：转出开口再点火
  './levels/level-24.json': 7, // 分步目标：中间体 → 产物
  './levels/level-25.json': 2, // 三臂中心：标准翻转 + 缺口移到对侧
  './levels/level-26.json': 9, // 光 × 回收组合
  './levels/level-27.json': 5, // 三臂搬运：复用普通取代与对侧落臂
  './levels/level-28.json': 9, // 分步 × 共振：空手先做中间体（强制顺序）
  './levels/level-29.json': 4, // 光 × 三臂：开口跳过缺失槽
  './levels/level-30.json': 10, // 毕业：光 + 分步 + 连锁
  './levels/level-31.json': 11, // 弹射中心：顶出物从身后飞出
  './levels/level-32.json': 3, // 弹射台：远程取代
  './levels/level-33.json': 9, // 保护基：先做能做的，再解锁
  './levels/level-34.json': 4, // 一击三果：翻转 + 连锁 + 弹射
  './levels/level-35.json': 3, // 狙击：射线打墙缝里的开口
  './levels/level-36.json': 11, // 链闸：罩子挡住共振
  './levels/level-37.json': 5, // 同时双响：一击点亮两个远端目标
  './levels/level-38.json': 8, // 弹射 × 共振：飞珠是资源
  './levels/level-39.json': 7, // 光照转轴对准弹射台射线
  './levels/level-40.json': 14, // 大毕业：解锁 + 光照 + 缺口翻面 + 双向发射
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

describe('chem（109.5°）关卡批次 01–40', () => {
  it('关卡数量与基线表一致', () => {
    expect(entries.map(([file]) => file)).toEqual(Object.keys(baseline))
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
  })

  it('11–40 批次（v1 搬运 + v2 共振 + v3 机制群）每关带 hint 且不泄露解法箭头序列', () => {
    for (const [file, json] of entries.slice(10)) {
      const level = chemGame.parseLevel(json)
      expect(level.hint, `${file} 缺少教学 hint`).toBeTruthy()
      expect(level.hint).not.toMatch(/[↑↓←→]{2,}/)
    }
  })

  it('level-19 简化版仍强制安全色判断：红珠一次点火通关，蓝珠会烧过链尾并显著增加恢复代价', () => {
    const level = chemGame.parseLevel(levelFiles['./levels/level-19.json'])
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

  it.each([
    [
      './levels/level-13.json',
      ['carry:empty>purple', 'attack:1:purple', 'attack:0:blue', 'attack:1:green'],
    ],
    [
      './levels/level-14.json',
      ['attack:0:empty', 'carry:empty>purple', 'attack:1:purple', 'attack:2:blue'],
    ],
    [
      './levels/level-15.json',
      ['carry:empty>blue', 'attack:2:blue', 'attack:1:yellow'],
    ],
    [
      './levels/level-18.json',
      ['attack:0:empty', 'carry:empty>blue', 'attack:0:blue'],
    ],
    [
      './levels/level-20.json',
      ['attack:1:empty', 'carry:empty>purple', 'attack:1:purple'],
    ],
  ])('%s 压缩后最短解仍执行原教学交互序列', (file, expected) => {
    expect(shortestInteractionTrace(file)).toEqual(expected)
  })
})
