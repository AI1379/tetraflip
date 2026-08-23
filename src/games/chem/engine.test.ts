import { describe, expect, it } from 'vitest'
import { solve } from '../../core/solver'
import type { Dir, Vec } from '../../core/protocol'
import { initialState, step, chemGame, stateKey } from './engine'
import type { ChemLauncherDef } from './level'
import type { ChemLevel } from './level'
import level01 from './levels/level-01.json'

/** ChemLevel 字面量的 v3 缺省字段（测试只关注各自机制） */
const V3_DEFAULTS = {
  lights: [] as Vec[],
  disposals: [] as Vec[],
  deprotections: [] as Vec[],
  launchers: [] as ChemLauncherDef[],
}

describe('chem（Inversion）引擎', () => {
  it('解析 level-01 通过', () => {
    expect(() => chemGame.parseLevel(level01)).not.toThrow()
  })

  it('非背面进攻无效果（不消耗回合）', () => {
    // 绕到中心东侧再向西撞：移动方向 W ≠ 开口臂 E → 无效
    let s = initialState(chemGame.parseLevel(level01))
    for (const d of ['N', 'E', 'E', 'S'] as const) s = step(s, d) // (1,2)→(3,2)
    const bumped = step(s, 'W')
    expect(bumped).toBe(s) // 原样返回，未消耗回合
  })

  it('背面进攻触发 180° 翻转且开口臂翻到对侧', () => {
    const s0 = initialState(chemGame.parseLevel(level01))
    const s = step(s0, 'E') // 玩家在 (1,2)，向 E 撞入 = 从开口臂 E 的背面进攻
    const c = s.centers[0]
    expect(c.arms).toEqual({ N: 'green', E: 'yellow', S: 'blue', W: 'red' })
    expect(c.leaving).toBe('W')
    expect(s.player).toEqual([1, 2]) // 攻击者留在原地
    expect(s.moves).toBe(1)
    expect(s.won).toBe(true) // level-01 目标：N 臂为 green
  })

  it('撞墙 / 撞边界无效果（不消耗回合）', () => {
    const s0 = initialState(chemGame.parseLevel(level01))
    const s1 = step(s0, 'N') // (1,1)
    const s2 = step(s1, 'N') // (1,0)
    expect(step(s2, 'N')).toBe(s2) // 撞边界
    expect(step(s2, 'E')).toBe(s2) // (2,0) 是墙
  })

  it('solver 1 步解出 level-01', () => {
    const result = solve(chemGame, chemGame.parseLevel(level01), { maxDepth: 10 })
    expect(result.solved).toBe(true)
    expect(result.solution).toEqual(['E'])
  })
})

/** v1 基团搬运规则（design §5）：拾取 / 交换 / 取代进攻 / 开口轴不变式 */
describe('chem v1 基团搬运引擎', () => {
  // 开口 E ⇒ 攻击姿态 = 中心西侧 (1,2) 向东撞；携带物落到 W 臂（正对攻击者）
  const level: ChemLevel = {
    id: 'test-carry',
    width: 7,
    height: 5,
    walls: [],
    player: [3, 2],
    centers: [
      {
        pos: [2, 2],
        arms: { N: 'red', E: 'green', S: 'yellow', W: 'purple' },
        leaving: 'E',
      },
    ],
    groups: [
      { pos: [4, 2], color: 'blue' },
      { pos: [0, 0], color: 'red' },
    ],
    stages: [{ goals: [{ center: 0, arm: 'W', color: 'blue' }] }],
    ...V3_DEFAULTS,
  }

  const walk = (s: ReturnType<typeof initialState>, dirs: readonly string[]) => {
    let cur = s
    for (const d of dirs) cur = step(cur, d as 'N' | 'E' | 'S' | 'W')
    return cur
  }

  it('groups 缺省为空（旧关格式兼容），holding 初始为空手', () => {
    const legacy = chemGame.parseLevel(level01)
    expect(legacy.groups).toEqual([])
    expect(initialState(legacy).holding).toBe(null)
  })

  it('走上游离基团格拾取；持物再走上另一格则交换', () => {
    let s = walk(initialState(level), ['E']) // (4,2) 拾取 blue
    expect(s.holding).toBe('blue')
    expect(s.groups.map((g) => g.pos)).toEqual([[0, 0]])
    s = walk(s, ['N', 'N', 'W', 'W', 'W', 'W']) // 漫步到 (0,0)：blue 落地，red 入手
    expect(s.holding).toBe('red')
    expect(s.groups).toContainEqual({ pos: [0, 0], color: 'blue' })
    expect(s.groups).not.toContainEqual({ pos: [0, 0], color: 'red' })
  })

  it('持基团进攻：落到正对攻击者的臂（开口臂对面），开口臂基团换到手', () => {
    let s = walk(initialState(level), ['E', 'N', 'W', 'W', 'W', 'S']) // 拾取 blue，绕到 (1,2)
    expect(s.player).toEqual([1, 2])
    const attacked = step(s, 'E') // d=E=leaving ✓ 携带 blue 撞入
    const c = attacked.centers[0]
    expect(c.arms).toEqual({ N: 'yellow', E: 'purple', S: 'red', W: 'blue' })
    expect(c.leaving).toBe('W')
    expect(attacked.holding).toBe('green') // 原开口臂（E）的基团被顶出
    expect(attacked.player).toEqual([1, 2]) // 攻击者原地
    expect(attacked.moves).toBe(7)
    expect(attacked.won).toBe(true) // 目标 W=blue 达成
  })

  it('空手进攻 = v0 纯翻转，手中不获得基团', () => {
    const s0 = walk(initialState(level), ['N', 'W', 'W', 'S']) // 绕到 (1,2)，空手
    const s = step(s0, 'E')
    expect(s.centers[0].arms).toEqual({ N: 'yellow', E: 'purple', S: 'red', W: 'green' })
    expect(s.holding).toBe(null)
  })

  it('开口轴不变式：任意多次进攻后 leaving 仍在原轴上', () => {
    let s = walk(initialState(level), ['N', 'W', 'W', 'S']) // (1,2)
    s = step(s, 'E') // E→W
    expect(s.centers[0].leaving).toBe('W')
    s = walk(s, ['N', 'E', 'E', 'S']) // 绕到东侧 (3,2)
    s = step(s, 'W') // W→E
    expect(s.centers[0].leaving).toBe('E')
  })

  it('交换后允许同中心重复色（初始互异约束只作用于关卡初始态）', () => {
    const redLevel: ChemLevel = {
      ...level,
      groups: [{ pos: [4, 2], color: 'red' }],
      stages: [{ goals: [{ center: 0, arm: 'W', color: 'red' }] }],
    }
    // 拾取 red（中心 N 臂已是 red）后撞入：red 同时出现在 S 与 W
    const s = walk(initialState(redLevel), ['E', 'N', 'W', 'W', 'W', 'S', 'E'])
    const colors = Object.values(s.centers[0].arms)
    expect(colors.filter((c) => c === 'red').length).toBe(2)
  })

  it('stateKey 包含 holding 与游离基团（solver 去重依赖）', () => {
    const s0 = initialState(level)
    const picked = step(s0, 'E')
    expect(stateKey(s0)).not.toBe(stateKey(picked))
    const other: ChemLevel = { ...level, groups: [{ pos: [4, 2], color: 'red' }] }
    const otherPicked = step(initialState(other), 'E')
    expect(stateKey(picked)).not.toBe(stateKey(otherPicked))
  })

  it('solver 最短解 = 拾取 → 绕到开口背面 → 撞入（7 步，搬运不可绕开）', () => {
    const result = solve(chemGame, level, { maxDepth: 12 })
    expect(result.solved).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.solution.length).toBe(7)
  })

  it('目标颜色不在本关任何臂/基团中被校验拒绝', () => {
    expect(() =>
      chemGame.parseLevel({ ...level, goals: [{ center: 0, arm: 'W', color: 'black' }] }),
    ).toThrow()
  })
})

/** v2 共振传导（design §5）：面对臂同色的相邻中心传播纯翻转 */
describe('chem v2 共振传导引擎', () => {
  // X(2,2) leaving=E（西侧 (1,2) 可进攻）；Y(3,2) 与 X 相邻，开口 E ⇒ 站位被 X 占据、不可直接进攻
  const pairLevel = (yArms: Record<'N' | 'E' | 'S' | 'W', string>): ChemLevel => ({
    id: 'test-resonance',
    width: 5,
    height: 5,
    walls: [],
    player: [1, 2],
    centers: [
      { pos: [2, 2], arms: { N: 'red', E: 'green', S: 'yellow', W: 'blue' }, leaving: 'E' },
      { pos: [3, 2], arms: yArms, leaving: 'E' },
    ],
    groups: [],
    stages: [{ goals: [{ center: 1, arm: 'E', color: 'blue' }] }],
    ...V3_DEFAULTS,
  })

  it('一击翻两个中心：判定用翻转后的颜色（翻前不通、翻后接通）', () => {
    // 翻前 X.armE=green ≠ Y.armW=blue；翻后 X.armE=blue == Y.armW=blue ⇒ 传导
    const s0 = initialState(pairLevel({ N: 'yellow', E: 'red', S: 'green', W: 'blue' }))
    const s = step(s0, 'E')
    expect(s.centers[0].arms).toEqual({ N: 'yellow', E: 'blue', S: 'red', W: 'green' })
    expect(s.centers[0].leaving).toBe('W')
    expect(s.centers[1].arms).toEqual({ N: 'green', E: 'blue', S: 'yellow', W: 'red' })
    expect(s.centers[1].leaving).toBe('W') // 开口也被传导翻转
    expect(s.moves).toBe(1) // 整条连锁只消耗一回合
    expect(s.won).toBe(true)
  })

  it('面对臂颜色不同 ⇒ 不传导', () => {
    const s0 = initialState(pairLevel({ N: 'yellow', E: 'red', S: 'blue', W: 'green' }))
    const s = step(s0, 'E')
    expect(s.centers[1].arms).toEqual(s0.centers[1].arms)
    expect(s.centers[1].leaving).toBe('E')
  })

  it('翻前同色但翻后不同色 ⇒ 不传导（判定不用翻前颜色）', () => {
    const s0 = initialState(pairLevel({ N: 'yellow', E: 'red', S: 'blue', W: 'green' }))
    const flipped = step(s0, 'E')
    // 翻后 X.armE=blue ≠ Y.armW=green：虽然翻前 X.armE=green == Y.armW=green
    expect(flipped.centers[1].arms).toEqual({ N: 'yellow', E: 'red', S: 'blue', W: 'green' })
  })

  it('多米诺：中段要等翻过之后才接通（三级链）', () => {
    const level: ChemLevel = {
      id: 'test-domino',
      width: 5,
      height: 5,
      walls: [],
      player: [0, 2],
      centers: [
        { pos: [1, 2], arms: { N: 'red', E: 'green', S: 'yellow', W: 'blue' }, leaving: 'E' },
        { pos: [2, 2], arms: { N: 'yellow', E: 'green', S: 'red', W: 'blue' }, leaving: 'W' },
        { pos: [3, 2], arms: { N: 'green', E: 'yellow', S: 'red', W: 'blue' }, leaving: 'E' },
      ],
      groups: [],
      stages: [{ goals: [{ center: 2, arm: 'E', color: 'blue' }] }],
      ...V3_DEFAULTS,
    }
    // 初始 B-C 不通（B.armE=green ≠ C.armW=blue）；B 被传导翻转后 B.armE=blue == C.armW ⇒ 接通
    const s = step(initialState(level), 'E')
    expect(s.moves).toBe(1)
    expect(s.centers[1].arms.E).toBe('blue')
    expect(s.centers[2].arms.E).toBe('blue')
    expect(s.centers[2].leaving).toBe('W')
  })

  it('传导翻转是纯翻转：手持与场上色珠不受连锁影响', () => {
    const base = pairLevel({ N: 'yellow', E: 'red', S: 'green', W: 'blue' })
    const level: ChemLevel = {
      ...base,
      player: [0, 2],
      groups: [{ pos: [1, 2], color: 'purple' }],
    }
    let s = step(initialState(level), 'E') // 拾取 purple
    expect(s.holding).toBe('purple')
    s = step(s, 'E') // 持珠进攻 X：purple 装入 X 的 W 臂，Y 被传导（纯翻转）
    expect(s.holding).toBe('green') // 只被进攻本身的换出影响（X 原 E 臂）
    expect(s.groups.length).toBe(0)
    expect(s.centers[0].arms.W).toBe('purple')
    expect(s.centers[1].arms.E).toBe('blue') // 传导发生
  })

  it('连锁按进攻重置：下一次进攻可以再次触发新的连锁', () => {
    // 中性目标（永不达成）⇒ won 恒为 false，只考察连锁本身
    const base = pairLevel({ N: 'yellow', E: 'red', S: 'green', W: 'blue' })
    const level: ChemLevel = { ...base, stages: [{ goals: [{ center: 0, arm: 'N', color: 'purple' }] }] }
    let s = step(initialState(level), 'E') // X、Y 各翻一次
    // 绕到 Y 东侧（Y 翻后开口 W ⇒ 从 (4,2) 向西撞）
    for (const d of ['N', 'E', 'E', 'E', 'S'] as const) s = step(s, d)
    s = step(s, 'W') // 新连锁：Y 翻转，且翻后 Y.armW=blue == X.armE=blue ⇒ X 被传回
    expect(s.centers[1].arms).toEqual({ N: 'yellow', E: 'red', S: 'green', W: 'blue' })
    expect(s.centers[0].arms).toEqual({ N: 'red', E: 'green', S: 'yellow', W: 'blue' }) // X 翻回初始
    expect(s.centers[0].leaving).toBe('E')
  })
})

/** v3 机制群（design §5）：光照转轴 / 回收格 / 保护基 / 分步目标 / 弹射 / 弹射台 / 三元中心 */
describe('chem v3 机制群引擎', () => {
  it('光照格：走入的一瞬所有中心开口顺时针转 90°，臂色不动（三元中心在三方向内轮转）', () => {
    const level: ChemLevel = {
      id: 'test-light',
      width: 4,
      height: 4,
      walls: [],
      player: [1, 0],
      centers: [
        { pos: [1, 1], arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' }, leaving: 'N' },
        {
          pos: [2, 2],
          arms: { N: 'red', E: 'blue', S: 'green' },
          leaving: 'S',
          kind: 'trigonal',
        },
      ],
      groups: [],
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'blue' }] }],
      lights: [[0, 0]],
      disposals: [],
      deprotections: [],
      launchers: [],
    }
    const s0 = initialState(level)
    const s = step(s0, 'W') // (1,0) → (0,0) 光照格
    expect(s.centers[0].leaving).toBe('E') // N → E
    expect(s.centers[1].leaving).toBe('N') // 三元：S → N（不经过 W）
    expect(s.centers[0].arms).toEqual(s0.centers[0].arms) // 只转开口
    expect(s.moves).toBe(1)
  })

  it('回收格：手持走入销毁色珠；空手走入无效果', () => {
    const level: ChemLevel = {
      id: 'test-disposal',
      width: 3,
      height: 1,
      walls: [],
      player: [0, 0],
      centers: [{ pos: [2, 0], arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' }, leaving: 'W' }],
      groups: [{ pos: [1, 0], color: 'purple' }],
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'blue' }] }],
      ...V3_DEFAULTS,
      disposals: [[1, 0]],
    }
    // 校验：游离基团不能放特殊格上 ⇒ 上面这关应被拒绝；回收格测试用独立布局
    expect(() => chemGame.parseLevel(level)).toThrow()

    const ok: ChemLevel = { ...level, groups: [], disposals: [[1, 0]] }
    let s = initialState(ok)
    s = step(s, 'E') // 空手走上回收格
    expect(s.holding).toBe(null)
    expect(s.player).toEqual([1, 0])
  })

  it('回收格 + 拾取绕行：手持色珠走上回收格 ⇒ 手变空（打破手持不变式）', () => {
    const level: ChemLevel = {
      id: 'test-disposal-2',
      width: 3,
      height: 2,
      walls: [],
      player: [0, 0],
      centers: [{ pos: [2, 1], arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' }, leaving: 'W' }],
      groups: [{ pos: [1, 0], color: 'purple' }],
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'blue' }] }],
      ...V3_DEFAULTS,
      disposals: [[2, 0]],
    }
    let s = step(initialState(level), 'E') // (1,0) 拾取 purple
    expect(s.holding).toBe('purple')
    s = step(s, 'E') // (2,0) 回收格：销毁
    expect(s.holding).toBe(null)
    expect(s.groups.length).toBe(0)
  })

  it('保护基：受保护中心进攻无效；脱保护格永久解除；保护罩挡住共振（链闸）', () => {
    const level: ChemLevel = {
      id: 'test-shield',
      width: 4,
      height: 3,
      walls: [],
      player: [0, 1],
      centers: [
        { pos: [1, 1], arms: { N: 'red', E: 'green', S: 'yellow', W: 'blue' }, leaving: 'E' },
        // Y 与 X 相邻；X 翻后 armE=blue == Y.armW=blue ⇒ 无罩时会传导
        {
          pos: [2, 1],
          arms: { N: 'yellow', E: 'red', S: 'green', W: 'blue' },
          leaving: 'N',
          shielded: true,
        },
      ],
      groups: [],
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'yellow' }] }],
      lights: [],
      disposals: [],
      deprotections: [[0, 0]],
      launchers: [],
    }
    const s0 = initialState(level)
    // 绕到 Y 南侧 (2,2)：受保护中心进攻无效（不消耗回合）
    let sh = step(s0, 'S')
    sh = step(sh, 'E')
    sh = step(sh, 'E')
    expect(sh.player).toEqual([2, 2])
    const bumped = step(sh, 'N') // dir=N=Y.leaving，但 Y 受保护
    expect(bumped).toBe(sh)

    // 攻击 X：X 翻转，但传导被 Y 的保护罩挡住
    const s = step(s0, 'E') // 玩家 (0,1) 向 E：(1,1) 是 X，dir=E=X.leaving ✓
    expect(s.centers[0].arms.E).toBe('blue') // X 翻了
    expect(s.centers[1].arms).toEqual(s0.centers[1].arms) // Y 没被传导
    expect(s.centers[1].leaving).toBe('N')

    // 脱保护是永久状态位（进攻验证在独立用例）
    const t = step(s0, 'N') // (0,0) 脱保护格
    expect(t.deprotected).toBe(true)
    expect(stateKey(t)).not.toBe(stateKey(s0))
  })

  it('脱保护后进攻受保护中心有效', () => {
    const level: ChemLevel = {
      id: 'test-unshield',
      width: 3,
      height: 3,
      walls: [],
      player: [0, 1],
      centers: [
        {
          pos: [1, 1],
          arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
          leaving: 'E',
          shielded: true,
        },
      ],
      groups: [],
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'green' }] }],
      ...V3_DEFAULTS,
      deprotections: [[0, 0]],
    }
    let s = initialState(level)
    expect(step(s, 'E')).toBe(s) // 保护中：进攻无效
    s = step(s, 'N') // 脱保护
    s = step(s, 'S')
    const attacked = step(s, 'E')
    expect(attacked.centers[0].arms).toEqual({ N: 'green', E: 'yellow', S: 'red', W: 'blue' })
    expect(attacked.won).toBe(true)
  })

  it('分步目标：按段推进；后段条件提前满足不跳段；一步可连进多段', () => {
    const level: ChemLevel = {
      id: 'test-stages',
      width: 4,
      height: 3,
      walls: [],
      player: [0, 1],
      centers: [
        { pos: [1, 1], arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' }, leaving: 'E' },
      ],
      groups: [],
      stages: [
        { goals: [{ center: 0, arm: 'N', color: 'green' }] }, // 中间体：翻一次即达成
        { goals: [{ center: 0, arm: 'N', color: 'red' }] }, // 产物：翻两次还原（初始即满足但不跳段）
      ],
      ...V3_DEFAULTS,
    }
    const s0 = initialState(level)
    expect(s0.stage).toBe(0) // 后段条件初始即真，仍从第 1 段开始
    expect(s0.won).toBe(false)

    const s1 = step(s0, 'E') // 第一次翻转：N=green ⇒ 进入第 2 段
    expect(s1.stage).toBe(1)
    expect(s1.won).toBe(false)

    // 绕到东侧（翻后开口 W，站位 (2,1)）：N(0,0) E(1,0) E(2,0) S(2,1)
    let s = s1
    for (const d of ['N', 'E', 'E', 'S'] as const) s = step(s, d)
    const s2 = step(s, 'W') // 第二次翻转：N=red ⇒ 第 2 段达成 ⇒ 连进 ⇒ 胜利
    expect(s2.stage).toBe(2)
    expect(s2.won).toBe(true)
  })

  it('弹射中心：持珠进攻时被顶出的基团沿反方向飞出，手持不变；身后被堵 ⇒ 进攻无效', () => {
    const mk = (walls: Vec[]): ChemLevel => ({
      id: 'test-eject',
      width: 5,
      height: 3,
      walls,
      player: [0, 0],
      centers: [
        {
          pos: [2, 1],
          arms: { N: 'red', E: 'green', S: 'yellow', W: 'blue' },
          leaving: 'E',
          ejects: true,
        },
      ],
      groups: [{ pos: [1, 0], color: 'purple' }],
      stages: [{ goals: [{ center: 0, arm: 'W', color: 'purple' }] }],
      ...V3_DEFAULTS,
    })
    // 拾取 purple (1,0) → 下到 (1,1) → 向东撞入（身后 (0,1) 空 ⇒ 落在 (0,1)）
    let s = step(initialState(mk([])), 'E')
    expect(s.holding).toBe('purple')
    s = step(s, 'S')
    s = step(s, 'E') // 进攻
    expect(s.holding).toBe(null) // 携带珠已注入 ⇒ 手变空
    expect(s.centers[0].arms.W).toBe('purple') // 携带物照常装入
    expect(s.centers[0].arms.E).toBe('blue')
    expect(s.groups).toContainEqual({ pos: [0, 1], color: 'green' }) // green 弹到身后 (0,1)

    // 身后第一格是墙 ⇒ 进攻无效
    let t = step(initialState(mk([[0, 1]])), 'E')
    t = step(t, 'S')
    const bumped = step(t, 'E')
    expect(bumped).toBe(t)
  })

  it('弹射中心：空手进攻仍是纯翻转（无物可弹）', () => {
    const level: ChemLevel = {
      id: 'test-eject-empty',
      width: 3,
      height: 3,
      walls: [],
      player: [0, 1],
      centers: [
        {
          pos: [1, 1],
          arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
          leaving: 'E',
          ejects: true,
        },
      ],
      groups: [],
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'green' }] }],
      ...V3_DEFAULTS,
    }
    const s = step(initialState(level), 'E')
    expect(s.centers[0].arms).toEqual({ N: 'green', E: 'yellow', S: 'red', W: 'blue' })
    expect(s.holding).toBe(null)
    expect(s.groups.length).toBe(0)
    expect(s.won).toBe(true)
  })

  it('三元中心：进攻 = 三臂轮换（mod 3），三次进攻回到恒等', () => {
    const level: ChemLevel = {
      id: 'test-trigonal',
      width: 3,
      height: 4,
      walls: [],
      player: [1, 0],
      centers: [
        {
          pos: [1, 1],
          arms: { N: 'red', E: 'blue', S: 'green' },
          leaving: 'S',
          kind: 'trigonal',
        },
      ],
      groups: [],
      // 中性目标（purple 不在轮换内）：防止第二次轮换后提前胜利挡住第三次进攻
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'purple' }] }],
      ...V3_DEFAULTS,
    }
    // 第一次（站位北侧 (1,0)，向南撞）：轮换一步
    let s = step(initialState(level), 'S')
    expect(s.centers[0].arms).toEqual({ N: 'green', E: 'red', S: 'blue' })
    expect(s.centers[0].leaving).toBe('N')
    // 第二次：开口 N ⇒ 站位南侧 (1,2)：E S S W 绕行
    for (const d of ['E', 'S', 'S', 'W'] as const) s = step(s, d)
    s = step(s, 'N')
    expect(s.centers[0].arms).toEqual({ N: 'blue', E: 'green', S: 'red' })
    expect(s.centers[0].leaving).toBe('E')
    // 第三次：开口 E ⇒ 站位西侧 (0,1)
    for (const d of ['S', 'W', 'N'] as const) s = step(s, d) // (1,2)→(1,3)→(0,3)→(0,2)…
    s = step(s, 'N') // (0,1)
    s = step(s, 'E')
    expect(s.centers[0].arms).toEqual({ N: 'red', E: 'blue', S: 'green' }) // mod 3 恒等
    expect(s.centers[0].leaving).toBe('S')
  })

  it('三元中心：持珠进攻提取开口臂，携带物落到「下下家」臂', () => {
    const level: ChemLevel = {
      id: 'test-trigonal-carry',
      width: 3,
      height: 3,
      walls: [],
      player: [1, 0],
      centers: [
        {
          pos: [1, 1],
          arms: { N: 'red', E: 'blue', S: 'green' },
          leaving: 'S',
          kind: 'trigonal',
        },
      ],
      groups: [{ pos: [2, 0], color: 'yellow' }],
      stages: [{ goals: [{ center: 0, arm: 'E', color: 'yellow' }] }],
      ...V3_DEFAULTS,
    }
    let s = step(initialState(level), 'E') // (2,0) 拾取 yellow
    expect(s.holding).toBe('yellow')
    s = step(s, 'W') // 回到 (1,0)
    s = step(s, 'S') // 持珠进攻（开口 S，向南撞）
    expect(s.holding).toBe('green') // 提取开口臂
    // 轮换后：携带物落在 triPrev(S)=E 臂
    expect(s.centers[0].arms).toEqual({ N: 'green', E: 'yellow', S: 'blue' })
    expect(s.won).toBe(true)
  })

  it('弹射台：手持走入发射——命中开口一致的中心发生远程取代（触发共振），否则落珠', () => {
    const mk = (leaving: Dir, shielded = false): ChemLevel => ({
      id: 'test-launcher',
      width: 5,
      height: 3,
      walls: [],
      player: [1, 0],
      centers: [
        {
          pos: [3, 1],
          arms: { N: 'red', E: 'green', S: 'yellow', W: 'blue' },
          leaving,
          shielded,
        },
      ],
      groups: [{ pos: [0, 0], color: 'purple' }],
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'purple' }] }],
      ...V3_DEFAULTS,
      launchers: [{ pos: [0, 1], dir: 'E' }],
    })
    // 命中（开口 E）：远程取代 + 被顶出的 green 落回 (2,1)
    let s = step(initialState(mk('E')), 'W') // 拾取 purple
    s = step(s, 'S') // 走上弹射台 ⇒ 发射
    expect(s.holding).toBe(null)
    expect(s.player).toEqual([0, 1])
    expect(s.centers[0].arms).toEqual({ N: 'yellow', E: 'blue', S: 'red', W: 'purple' })
    expect(s.centers[0].leaving).toBe('W')
    expect(s.groups).toContainEqual({ pos: [2, 1], color: 'green' })
    expect(s.moves).toBe(2)

    // 方向不合：色珠停在中心前一格，中心不变
    let t = step(initialState(mk('N')), 'W')
    t = step(t, 'S')
    expect(t.centers[0].arms).toEqual({ N: 'red', E: 'green', S: 'yellow', W: 'blue' })
    expect(t.groups).toContainEqual({ pos: [2, 1], color: 'purple' })

    // 保护罩：同样挡住远程取代
    let u = step(initialState(mk('E', true)), 'W')
    u = step(u, 'S')
    expect(u.centers[0].arms).toEqual({ N: 'red', E: 'green', S: 'yellow', W: 'blue' })
    expect(u.groups).toContainEqual({ pos: [2, 1], color: 'purple' })
  })

  it('弹射台：撞墙停在墙前；飞出棋盘停在最后一格；空手走上只是移动', () => {
    const base: ChemLevel = {
      id: 'test-launcher-fly',
      width: 5,
      height: 3,
      walls: [],
      player: [1, 0],
      centers: [
        { pos: [4, 2], arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' }, leaving: 'N' },
      ],
      groups: [{ pos: [0, 0], color: 'purple' }],
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'purple' }] }],
      ...V3_DEFAULTS,
      launchers: [{ pos: [0, 1], dir: 'E' }],
    }
    // 飞出棋盘：射线全程无阻碍 ⇒ 停在最后一格 (4,1)
    let s = step(initialState(base), 'W')
    s = step(s, 'S')
    expect(s.groups).toContainEqual({ pos: [4, 1], color: 'purple' })

    // 撞墙：停在墙前一格
    const walled: ChemLevel = { ...base, walls: [[2, 1]] }
    let t = step(initialState(walled), 'W')
    t = step(t, 'S')
    expect(t.groups).toContainEqual({ pos: [1, 1], color: 'purple' })

    // 空手走上弹射台：只是移动（不发射）
    const u = step(step(initialState(base), 'S'), 'W')
    expect(u.player).toEqual([0, 1])
    expect(u.holding).toBe(null)
    expect(u.groups.length).toBe(1) // 色珠原封不动
  })

  it('stateKey 区分 stage 与 deprotected（solver 去重依赖）', () => {
    const level: ChemLevel = {
      id: 'test-key',
      width: 3,
      height: 3,
      walls: [],
      player: [0, 1],
      centers: [
        { pos: [1, 1], arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' }, leaving: 'W' },
      ],
      groups: [],
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'green' }] }],
      ...V3_DEFAULTS,
      deprotections: [[0, 0]],
    }
    const s0 = initialState(level)
    expect(stateKey(s0)).toContain('D0|T0')
    const s1 = step(s0, 'N') // 脱保护格
    expect(stateKey(s1)).toContain('D1')
    expect(stateKey(s0)).not.toBe(stateKey(s1))
  })
})
