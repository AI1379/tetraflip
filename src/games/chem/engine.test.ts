import { describe, expect, it } from 'vitest'
import { solve } from '../../core/solver'
import type { Dir, Vec } from '../../core/protocol'
import {
  chemGame,
  getEjectionPreview,
  initialState,
  isShielded,
  peekFlip,
  stateKey,
  step,
} from './engine'
import type { ChemLevel } from './level'
import level01 from './levels/level-01.json'

/** ChemLevel 字面量的 v3 缺省字段（测试只关注各自机制） */
const V3_DEFAULTS = {
  lights: [] as Vec[],
}

describe('chem（Inversion）引擎', () => {
  it('解析 level-01 通过', () => {
    expect(() => chemGame.parseLevel(level01)).not.toThrow()
  })

  it('非背面进攻无效果（不消耗回合）', () => {
    // 绕到中心东侧再向西撞：移动方向 W ≠ 开口臂 E → 无效
    let s = initialState(chemGame.parseLevel(level01))
    for (const d of ['N', 'E', 'E', 'S'] as const) s = step(s, d) // (0,1)→(2,1)
    const bumped = step(s, 'W')
    expect(bumped).toBe(s) // 原样返回，未消耗回合
  })

  it('背面进攻触发 180° 翻转且开口臂翻到对侧', () => {
    const s0 = initialState(chemGame.parseLevel(level01))
    const s = step(s0, 'E') // 玩家在 (0,1)，向 E 撞入 = 从开口臂 E 的背面进攻
    const c = s.centers[0]
    expect(c.arms).toEqual({ N: 'green', E: 'yellow', S: 'blue', W: 'red' })
    expect(c.leaving).toBe('W')
    expect(s.player).toEqual([0, 1]) // 攻击者留在原地
    expect(s.moves).toBe(1)
    expect(s.won).toBe(true) // level-01 目标：N 臂为 green
  })

  it('撞墙 / 撞边界无效果（不消耗回合）', () => {
    const level = chemGame.parseLevel({ ...level01, id: 'test-wall', walls: [[1, 0]] })
    const s0 = initialState(level)
    expect(step(s0, 'W')).toBe(s0) // 撞边界
    const s1 = step(s0, 'N') // (0,0)
    expect(step(s1, 'E')).toBe(s1) // (1,0) 是墙
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

/** v3.2 机制群（design §5）：光照转轴 / 阶段护罩 / 分步目标 / 弹射中心 / 三臂中心 */
describe('chem v3 机制群引擎', () => {
  it('光照格：开口顺时针移到下一条现存臂，三臂中心跳过缺口', () => {
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
    }
    const s0 = initialState(level)
    const s = step(s0, 'W') // (1,0) → (0,0) 光照格
    expect(s.centers[0].leaving).toBe('E') // N → E
    expect(s.centers[1].leaving).toBe('N') // 三臂：S → W（缺失）→ N
    expect(s.centers[0].arms).toEqual(s0.centers[0].arms) // 只转开口
    expect(s.moves).toBe(1)
  })

  it('三臂中心校验：缺口可位于任一槽，开口必须有臂，目标可指向翻转后出现的槽位', () => {
    const raw = {
      id: 'test-trigonal-schema',
      width: 3,
      height: 3,
      walls: [],
      player: [0, 0],
      centers: [
        {
          pos: [1, 1],
          arms: { N: 'red', S: 'green', W: 'blue' }, // 初始缺 E；翻转后 blue 会到 E
          leaving: 'N',
          kind: 'trigonal',
        },
      ],
      goals: [{ center: 0, arm: 'E', color: 'blue' }],
    }
    expect(() => chemGame.parseLevel(raw)).not.toThrow()
    expect(() =>
      chemGame.parseLevel({
        ...raw,
        centers: [{ ...raw.centers[0], leaving: 'E' }], // 开口不能指向缺口
      }),
    ).toThrow()
    expect(() =>
      chemGame.parseLevel({
        ...raw,
        centers: [
          {
            ...raw.centers[0],
            arms: { N: 'red', E: 'yellow', S: 'green', W: 'blue' }, // 不能伪装成四臂
          },
        ],
      }),
    ).toThrow()
  })

  it('三臂中心的移动缺口会在翻转后接通共振链', () => {
    const level: ChemLevel = {
      id: 'test-trigonal-gap-resonance',
      width: 4,
      height: 3,
      walls: [],
      player: [1, 0],
      centers: [
        {
          pos: [1, 1],
          arms: { N: 'red', S: 'green', W: 'blue' }, // 缺 E；翻后 W 的 blue 移到 E
          leaving: 'S',
          kind: 'trigonal',
        },
        {
          pos: [2, 1],
          arms: { N: 'yellow', E: 'red', S: 'green', W: 'blue' },
          leaving: 'E',
        },
      ],
      groups: [],
      stages: [{ goals: [{ center: 1, arm: 'N', color: 'green' }] }],
      ...V3_DEFAULTS,
    }
    const s = step(initialState(level), 'S')
    expect(s.centers[0].arms).toEqual({ N: 'green', S: 'red', E: 'blue' })
    expect(s.centers[1].arms.N).toBe('green') // 新出现的 E=blue 对上邻居 W=blue，传导成功
    expect(s.won).toBe(true)
  })

  it('两个相对空穴没有颜色，不会因 undefined 相等而形成共振键', () => {
    const level: ChemLevel = {
      id: 'test-two-facing-holes',
      width: 4,
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
        {
          pos: [2, 1],
          arms: { N: 'red', E: 'blue', S: 'green' },
          leaving: 'E',
          kind: 'trigonal',
        },
      ],
      groups: [],
      // A 翻后缺口 E，正对 B 的缺口 W；若误把 undefined 当同色，B 会翻转并错误达标。
      stages: [{ goals: [{ center: 1, arm: 'N', color: 'green' }] }],
      ...V3_DEFAULTS,
    }
    const s0 = initialState(level)
    const s = step(s0, 'S')
    expect(s.centers[0].arms.E).toBeUndefined()
    expect(s.centers[1].arms.W).toBeUndefined()
    expect(s.centers[1].arms).toEqual(s0.centers[1].arms)
    expect(s.won).toBe(false)
  })

  it('阶段护罩：阶段前阻挡直接进攻与共振；完成阶段当步不追溯，下一次攻击可传播', () => {
    const level: ChemLevel = {
      id: 'test-stage-shield',
      width: 5,
      height: 3,
      walls: [],
      player: [0, 1],
      centers: [
        { pos: [1, 1], arms: { N: 'red', E: 'green', S: 'yellow', W: 'blue' }, leaving: 'E' },
        {
          pos: [2, 1],
          arms: { N: 'yellow', E: 'red', S: 'green', W: 'blue' },
          leaving: 'N',
          shieldUntilStage: 1,
        },
        { pos: [3, 1], arms: { N: 'red', E: 'yellow', S: 'green', W: 'blue' }, leaving: 'E' },
      ],
      groups: [],
      stages: [
        { goals: [{ center: 0, arm: 'N', color: 'yellow' }] },
        { goals: [{ center: 2, arm: 'N', color: 'green' }] },
      ],
      ...V3_DEFAULTS,
    }
    const s0 = initialState(level)
    expect(isShielded(s0, s0.centers[1])).toBe(true)

    let sh = step(s0, 'S')
    sh = step(sh, 'E')
    sh = step(sh, 'E')
    expect(step(sh, 'N')).toBe(sh)

    // A 翻后 E=blue 与 B.W=blue 接通；传播仍按动作开始时的 stage=0 结算，B 不追溯翻转。
    let s = step(s0, 'E')
    expect(s.stage).toBe(1)
    expect(s.centers[1].arms).toEqual(s0.centers[1].arms)
    expect(isShielded(s, s.centers[1])).toBe(false)

    // 下一动作进攻 B：B 翻后 E=blue 与 C.W=blue 接通，C 被传播翻转。
    for (const d of ['S', 'E', 'E'] as const) s = step(s, d)
    const propagated = step(s, 'N')
    expect(propagated.centers[1].arms.N).toBe('green')
    expect(propagated.centers[2].arms.N).toBe('green')
    expect(propagated.won).toBe(true)
  })

  it('光照穿透阶段护罩：只移动罩内开口，不构成进攻或共振', () => {
    const level: ChemLevel = {
      id: 'test-shield-light',
      width: 3,
      height: 3,
      walls: [],
      player: [0, 0],
      centers: [
        {
          pos: [1, 1],
          arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
          leaving: 'N',
          shieldUntilStage: 1,
        },
      ],
      groups: [],
      stages: [
        { goals: [{ center: 0, arm: 'N', color: 'green' }] },
        { goals: [{ center: 0, arm: 'N', color: 'red' }] },
      ],
      lights: [[1, 0]],
    }
    const s = step(initialState(level), 'E')
    expect(s.stage).toBe(0)
    expect(isShielded(s, s.centers[0])).toBe(true)
    expect(s.centers[0].leaving).toBe('E')
    expect(s.centers[0].arms).toEqual({ N: 'red', E: 'blue', S: 'green', W: 'yellow' })
  })

  it('多个阶段护罩按各自阈值依次解除', () => {
    const level: ChemLevel = {
      id: 'test-multi-stage-shield',
      width: 5,
      height: 4,
      walls: [],
      player: [0, 1],
      centers: [
        { pos: [1, 1], arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' }, leaving: 'E' },
        {
          pos: [3, 1],
          arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
          leaving: 'N',
          shieldUntilStage: 1,
        },
        {
          pos: [3, 2],
          arms: { N: 'yellow', E: 'red', S: 'blue', W: 'green' },
          leaving: 'N',
          shieldUntilStage: 2,
        },
      ],
      groups: [],
      stages: [
        { goals: [{ center: 0, arm: 'N', color: 'green' }] },
        { goals: [{ center: 0, arm: 'N', color: 'red' }] },
        { goals: [{ center: 2, arm: 'E', color: 'green' }] },
      ],
      ...V3_DEFAULTS,
    }
    let s = initialState(level)
    expect(s.centers.map((c) => isShielded(s, c))).toEqual([false, true, true])
    s = step(s, 'E')
    expect(s.stage).toBe(1)
    expect(s.centers.map((c) => isShielded(s, c))).toEqual([false, false, true])
    for (const d of ['N', 'E', 'E', 'S', 'W'] as const) s = step(s, d)
    expect(s.stage).toBe(2)
    expect(s.centers.map((c) => isShielded(s, c))).toEqual([false, false, false])
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
    expect(getEjectionPreview(s, 0)).toEqual({
      center: 0,
      from: [1, 1],
      dir: 'W',
      color: 'green',
      path: [[0, 1]],
      landing: [0, 1],
      blockedCenter: null,
    })
    s = step(s, 'E') // 进攻
    expect(s.holding).toBe(null) // 携带珠已注入 ⇒ 手变空
    expect(s.centers[0].arms.W).toBe('purple') // 携带物照常装入
    expect(s.centers[0].arms.E).toBe('blue')
    expect(s.groups).toContainEqual({ pos: [0, 1], color: 'green' }) // green 弹到身后 (0,1)

    // 身后第一格是墙 ⇒ 进攻无效
    let t = step(initialState(mk([[0, 1]])), 'E')
    t = step(t, 'S')
    expect(getEjectionPreview(t, 0)).toMatchObject({ path: [], landing: null, color: 'green' })
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

  it('三臂中心：三颗珠、缺口与开口整体翻转 180°，两次进攻回到恒等', () => {
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
      // 中性目标（purple 不在翻转内）：防止第一次翻转后提前胜利挡住第二次进攻
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'purple' }] }],
      ...V3_DEFAULTS,
    }
    // 第一次（站位北侧 (1,0)，向南撞）：整体翻转，缺口 W → E
    let s = step(initialState(level), 'S')
    expect(s.centers[0].arms).toEqual({ N: 'green', W: 'blue', S: 'red' })
    expect(s.centers[0].leaving).toBe('N')
    // 第二次：开口 N ⇒ 站位南侧 (1,2)：E S S W 绕行后向北撞
    for (const d of ['E', 'S', 'S', 'W'] as const) s = step(s, d)
    s = step(s, 'N')
    expect(s.centers[0].arms).toEqual({ N: 'red', E: 'blue', S: 'green' })
    expect(s.centers[0].leaving).toBe('S')
  })

  it('三臂中心：持珠取代完全复用普通中心语义，携带物随翻转落到对侧', () => {
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
      stages: [{ goals: [{ center: 0, arm: 'N', color: 'yellow' }] }],
      ...V3_DEFAULTS,
    }
    let s = step(initialState(level), 'E') // (2,0) 拾取 yellow
    expect(s.holding).toBe('yellow')
    s = step(s, 'W') // 回到 (1,0)
    s = step(s, 'S') // 持珠进攻（开口 S，向南撞）
    expect(s.holding).toBe('green') // 提取开口臂
    // 手持珠先装入 S，整体翻转后落到 N；原 E 臂连同缺口一起转到 W。
    expect(s.centers[0].arms).toEqual({ N: 'yellow', W: 'blue', S: 'red' })
    expect(Object.values(s.centers[0].arms)).toHaveLength(3) // 空穴不会被注入或填补
    expect(s.won).toBe(true)
  })

  it('旧外围字段被 schema 拒绝，stateKey 只保留会影响转移的 stage', () => {
    const base = {
      id: 'test-legacy-fields',
      width: 3,
      height: 3,
      walls: [],
      player: [0, 1],
      centers: [
        { pos: [1, 1], arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' }, leaving: 'W' },
      ],
      groups: [],
      stages: [
        { goals: [{ center: 0, arm: 'N', color: 'green' }] },
        { goals: [{ center: 0, arm: 'N', color: 'red' }] },
      ],
      lights: [],
    }
    for (const legacy of [
      { disposals: [[0, 0]] },
      { deprotections: [[0, 0]] },
      { launchers: [{ pos: [0, 0], dir: 'E' }] },
      { centers: [{ ...base.centers[0], shielded: true }] },
    ]) {
      expect(() => chemGame.parseLevel({ ...base, ...legacy })).toThrow()
    }

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
      stages: [
        { goals: [{ center: 0, arm: 'N', color: 'green' }] },
        { goals: [{ center: 0, arm: 'N', color: 'red' }] },
      ],
      ...V3_DEFAULTS,
    }
    const s0 = initialState(level)
    expect(stateKey(s0)).toContain('|T0|')
    expect(stateKey(s0)).not.toContain('|D')
    const s1 = { ...s0, stage: 1 }
    expect(stateKey(s0)).not.toBe(stateKey(s1))
  })
})


describe('chem v4 新机制（弹射打结构 / 护罩再生）', () => {
  it('弹射打结构：hitLights 落到光照格时触发转轴，珠留在格上', () => {
    const level: ChemLevel = {
      id: 'test-hit-light',
      width: 5,
      height: 3,
      walls: [],
      player: [0, 0],
      centers: [
        {
          pos: [2, 1],
          arms: { N: 'red', E: 'green', S: 'yellow', W: 'blue' },
          leaving: 'E',
          ejects: true,
          hitLights: true,
        },
        {
          pos: [4, 1],
          arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
          leaving: 'W',
        },
      ],
      groups: [{ pos: [1, 0], color: 'purple' }],
      lights: [[0, 1]],
      stages: [{ goals: [{ center: 0, arm: 'W', color: 'purple' }] }],
    }
    let s = initialState(level)
    s = step(s, 'E') // 拾取 purple
    s = step(s, 'S') // 走到弹射中心背面 (1,1)
    expect(getEjectionPreview(s, 0)?.landing).toEqual([0, 1])
    const before = s.centers.map((c) => c.leaving)
    const after = step(s, 'E')
    // 弹射中心本身先完成取代 + 翻转（leaving E→W），随后落地光照再统一转轴 W→N
    expect(after.centers[0].leaving).toBe('N')
    expect(after.centers[1].leaving).toBe('N')
    expect(after.groups).toContainEqual({ pos: [0, 1], color: 'green' })
    expect(before).not.toEqual(after.centers.map((c) => c.leaving))
  })

  it('弹射打结构：hitCenters 落到中心进攻位时触发该中心纯翻转', () => {
    const level: ChemLevel = {
      id: 'test-hit-center',
      width: 5,
      height: 3,
      walls: [],
      player: [1, 0],
      centers: [
        {
          pos: [3, 1],
          arms: { N: 'red', E: 'green', S: 'yellow', W: 'blue' },
          leaving: 'E',
          ejects: true,
          hitCenters: true,
        },
        {
          pos: [0, 1],
          arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
          leaving: 'W',
        },
      ],
      groups: [{ pos: [2, 0], color: 'purple' }],
      lights: [],
      stages: [{ goals: [{ center: 0, arm: 'W', color: 'purple' }] }],
    }
    let s = initialState(level)
    s = step(s, 'E') // 拾取 purple (2,0)
    s = step(s, 'S') // 到 (2,1)，弹射中心背面
    const plan = getEjectionPreview(s, 0)
    expect(plan?.landing).toEqual([1, 1])
    expect(plan?.blockedCenter).toBe(1)
    const after = step(s, 'E')
    // 目标中心被弹射珠撞翻：W→E，N=red→green
    expect(after.centers[1].leaving).toBe('E')
    expect(after.centers[1].arms.N).toBe('green')
    expect(after.centers[1].arms.S).toBe('red')
    // 弹射珠仍落在 [1,1] 成为可拾取基团
    expect(after.groups).toContainEqual({ pos: [1, 1], color: 'green' })
  })

  it('弹射打结构：hitCenters 不开启时，落点即使合法也不触发撞翻', () => {
    const level: ChemLevel = {
      id: 'test-hit-center-off',
      width: 5,
      height: 3,
      walls: [],
      player: [1, 0],
      centers: [
        {
          pos: [3, 1],
          arms: { N: 'red', E: 'green', S: 'yellow', W: 'blue' },
          leaving: 'E',
          ejects: true,
        },
        {
          pos: [0, 1],
          arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
          leaving: 'W',
        },
      ],
      groups: [{ pos: [2, 0], color: 'purple' }],
      lights: [],
      stages: [{ goals: [{ center: 0, arm: 'W', color: 'purple' }] }],
    }
    let s = initialState(level)
    s = step(s, 'E')
    s = step(s, 'S')
    const after = step(s, 'E')
    expect(after.centers[1].leaving).toBe('W') // 未触发
    expect(after.centers[1].arms.N).toBe('red')
  })

  it('护罩再生：中间产物被破坏时护罩回来，修复后重新打开', () => {
    const level: ChemLevel = {
      id: 'test-reactive-shield',
      width: 4,
      height: 3,
      walls: [],
      player: [0, 0],
      centers: [
        {
          pos: [1, 1],
          arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
          leaving: 'S',
        },
        {
          pos: [2, 1],
          arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
          leaving: 'N',
          reactiveTo: { center: 0, arm: 'N', color: 'red' },
        },
      ],
      groups: [],
      lights: [],
      stages: [
        { goals: [{ center: 0, arm: 'N', color: 'red' }] },
        { goals: [{ center: 1, arm: 'W', color: 'blue' }] },
      ],
    }
    let s = initialState(level)
    // 第 1 段自动完成，中心 0 的 N=red 是已达标中间产物：护罩未再生
    expect(s.stage).toBe(1)
    expect(isShielded(s, s.centers[1])).toBe(false)
    // 第一次进攻翻转中心 0，N=red 被破坏
    s = step(s, 'E') // (1,0)
    s = step(s, 'S') // 撞中心 0
    expect(s.centers[0].arms.N).toBe('green')
    expect(isShielded(s, s.centers[1])).toBe(true)
    // 护罩期间直接进攻中心 1 无效
    s = step(s, 'E') // (2,0)
    const blocked = step(s, 'S')
    expect(blocked).toBe(s)
    // 第 1 段目标仍要求 N=red；绕到中心 0 北侧再纯翻转一次，恢复中间产物
    s = step(blocked, 'E') // (3,0)
    s = step(s, 'S') // (3,1)
    s = step(s, 'S') // (3,2)
    s = step(s, 'W') // (2,2)
    s = step(s, 'W') // (1,2)
    s = step(s, 'N') // 撞中心 0
    expect(s.centers[0].arms.N).toBe('red')
    expect(isShielded(s, s.centers[1])).toBe(false)
  })
})


describe('chem peekFlip（Inspect 检视用纯函数，design §11）', () => {
  it('tetra：翻一次 = 四臂 180° 对换 + 开口反向；翻两次回到原构型（周期 2）', () => {
    const center = {
      pos: [1, 1] as Vec,
      arms: { N: 'red', E: 'blue', S: 'green', W: 'yellow' },
      leaving: 'W' as Dir,
      kind: 'tetra' as const,
      ejects: false,
      hitLights: false,
      hitCenters: false,
    }
    const once = peekFlip(center)
    expect(once.arms).toEqual({ N: 'green', E: 'yellow', S: 'red', W: 'blue' })
    expect(once.leaving).toBe('E')
    expect(peekFlip(once)).toEqual(center)
    // 纯函数：不改动入参
    expect(center.arms.N).toBe('red')
    expect(center.leaving).toBe('W')
  })

  it('trigonal：翻一次 = 三臂与缺口整体旋转 180°；翻两次回到原构型（周期 2）', () => {
    const center = {
      pos: [1, 1] as Vec,
      arms: { N: 'red', E: 'blue', S: 'green' },
      leaving: 'N' as Dir,
      kind: 'trigonal' as const,
      ejects: false,
      hitLights: false,
      hitCenters: false,
    }
    const once = peekFlip(center)
    expect(once.arms).toEqual({ N: 'green', W: 'blue', S: 'red' })
    expect(once.leaving).toBe('S')
    expect(peekFlip(once)).toEqual(center)
  })
})
