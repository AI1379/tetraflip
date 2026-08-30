import { describe, expect, it } from 'vitest'
import level01Json from './levels/level-01.json'
import level38Json from './levels/level-38.json'
import level74Json from './levels/level-74.json'
import { parseChemLevel } from './level'
import {
  CHEM_ML_COLORS,
  CHEM_ML_PROTOCOL_VERSION,
  chemMlActionOrder,
  createChemMlInstance,
  describeChemLevelForMl,
  observeChemForMl,
  stepChemMlInstance,
} from './ml-bridge'

describe('chem ML bridge contract', () => {
  it('固定协议版本、动作与颜色编码', () => {
    expect(CHEM_ML_PROTOCOL_VERSION).toBe(1)
    expect(chemMlActionOrder).toEqual(['N', 'E', 'S', 'W'])
    expect(CHEM_ML_COLORS).toEqual(['red', 'blue', 'green', 'yellow', 'purple'])
  })

  it('导出静态关卡描述，但不泄漏 solver 距离或最优动作', () => {
    const descriptor = describeChemLevelForMl(parseChemLevel(level38Json), 38)
    expect(descriptor.ordinal).toBe(38)
    expect(descriptor.centers.some((center) => center.ejects === 1)).toBe(true)
    expect(descriptor.centers.some((center) => center.hitLights === 1)).toBe(true)
    expect('distance' in descriptor).toBe(false)
    expect('solution' in descriptor).toBe(false)
  })

  it('用真实引擎逐步走完 01，输出胜利、进度与 stateKey', () => {
    const level = parseChemLevel(level01Json)
    let instance = createChemMlInstance(level, 1)
    expect(observeChemForMl(instance.state, 1).progress).toBe(0)

    const down = stepChemMlInstance(instance, 2, true)
    instance = down.instance
    expect(down.result.effective).toBe(true)
    expect(down.result.observation.won).toBe(false)

    const right = stepChemMlInstance(instance, 1, true)
    expect(right.result.observation.won).toBe(true)
    expect(right.result.observation.progress).toBe(1)
    expect(right.result.events.flips).toBeGreaterThan(0)
    expect(right.result.stateKey).toContain('|T1|')
  })

  it('无红线反事实只移除 moveLimit，不改地图与目标', () => {
    const level = parseChemLevel(level74Json)
    const actual = createChemMlInstance(level, 74)
    const counterfactual = createChemMlInstance(level, 74, true)
    expect(actual.state.moveLimit).toBe(level.moveLimit)
    expect(counterfactual.state.moveLimit).toBeUndefined()
    expect(counterfactual.state.centers).toEqual(actual.state.centers)
    expect(counterfactual.state.stages).toEqual(actual.state.stages)
    expect(counterfactual.state.player).toEqual(actual.state.player)
  })
})
