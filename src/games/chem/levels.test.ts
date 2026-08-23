import { describe, expect, it } from 'vitest'
import { solve } from '../../core/solver'
import { chemGame } from './engine'

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
  './levels/level-13.json': 17, // 循环交换
  './levels/level-14.json': 18, // 空手一击的时机（手不可再空）
  './levels/level-15.json': 16, // 毕业题：同一位两扇门
  './levels/level-16.json': 4, // 共振：一击翻两个中心
  './levels/level-17.json': 7, // 多米诺：三级链逐级接通
  './levels/level-18.json': 14, // 点火之前：奇偶点火 + 换站位 + 换手
  './levels/level-19.json': 14, // 断链：两枚色珠只有一枚安全
  './levels/level-20.json': 16, // 毕业：奇偶序列点燃两条链
  './levels/level-21.json': 6, // 光照格：转轴开出进攻路
  './levels/level-22.json': 13, // 回收格：打破手持不变式
  './levels/level-23.json': 6, // 光 × 共振：转出开口再点火
  './levels/level-24.json': 7, // 分步目标：中间体 → 产物
  './levels/level-25.json': 7, // 三元中心：mod 3 初体验
  './levels/level-26.json': 9, // 光 × 回收组合
  './levels/level-27.json': 5, // 三元搬运：下下家落臂
  './levels/level-28.json': 9, // 分步 × 共振：空手先做中间体（强制顺序）
  './levels/level-29.json': 9, // 光 × 三元：三方向内轮转
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
  './levels/level-40.json': 21, // 大毕业：解锁 + 光照 + 双发射 + 换珠
}

const entries = Object.entries(levelFiles).sort(([a], [b]) => a.localeCompare(b))

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
})
