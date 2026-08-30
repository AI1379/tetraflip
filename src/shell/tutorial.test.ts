import { describe, expect, it } from 'vitest'
import level01Json from '../games/chem/levels/level-01.json'
import level02Json from '../games/chem/levels/level-02.json'
import level03Json from '../games/chem/levels/level-03.json'
import level04Json from '../games/chem/levels/level-04.json'
import level05Json from '../games/chem/levels/level-05.json'
import level06Json from '../games/chem/levels/level-06.json'
import level07Json from '../games/chem/levels/level-07.json'
import level09Json from '../games/chem/levels/level-09.json'
import level13Json from '../games/chem/levels/level-13.json'
import level14Json from '../games/chem/levels/level-14.json'
import level18Json from '../games/chem/levels/level-18.json'
import level24Json from '../games/chem/levels/level-24.json'
import level30Json from '../games/chem/levels/level-30.json'
import level37Json from '../games/chem/levels/level-37.json'
import level38Json from '../games/chem/levels/level-38.json'
import level39Json from '../games/chem/levels/level-39.json'
import { chemGame } from '../games/chem'
import type { ChemState } from '../games/chem'
import {
  getChemTutorial,
  initialTutorialInputMode,
  tutorialInputModeFromPointerType,
} from './tutorial'

const initial = (json: unknown): ChemState => chemGame.initialState(chemGame.parseLevel(json))

describe('状态驱动操作引导与机制首现教学', () => {
  it('第一关先用五拍建立玩家、目标、色珠、箭头与操作的完整认知', () => {
    const state = initial(level01Json)
    const player = getChemTutorial(0, state, null, 'touch', 0)
    expect(player?.title).toBe('这是你')
    expect(player?.spotlight?.pos).toEqual(state.player)
    expect(player?.advanceOnTap).toBe(true)
    expect(player?.kicker).toContain('01 / 05')

    const goal = getChemTutorial(0, state, null, 'touch', 1)
    expect(goal?.title).toContain('目标')
    expect(goal?.body).toContain('所有目标都对上')
    expect(goal?.spotlight?.pos).toEqual([1, 0.54])
    expect(goal?.kicker).toContain('02 / 05')

    const bead = getChemTutorial(0, state, null, 'touch', 2)
    expect(bead?.title).toContain('同色珠')
    expect(bead?.spotlight?.pos).toEqual([1, 1.46])
    expect(bead?.kicker).toContain('03 / 05')

    const opening = getChemTutorial(0, state, null, 'touch', 3)
    expect(opening?.title).toContain('白箭头')
    expect(opening?.body).toContain('反面')
    expect(opening?.spotlight?.pos).toEqual([1, 1])
    expect(opening?.kicker).toContain('04 / 05')

    const guide = getChemTutorial(0, state, null, 'touch', 4)
    expect(guide?.focusDirs).toEqual(['S'])
    expect(guide?.gesture?.dir).toBe('S')
    expect(guide?.title).toContain('滑动')
    expect(guide?.spotlight?.pos).toEqual(state.player)
    expect(guide?.advanceOnTap).toBeUndefined()
    expect(guide?.kicker).toContain('05 / 05')

    const positioned = chemGame.step(state, 'S')
    const centerReveal = getChemTutorial(0, positioned, null, 'touch', 4)
    expect(centerReveal?.title).toContain('箭头反面')
    expect(centerReveal?.body).toContain('翻转半圈')
    expect(centerReveal?.focusDirs).toEqual(['E'])
    expect(centerReveal?.gesture?.dir).toBe('E')

    expect(getChemTutorial(0, chemGame.step(positioned, 'E'), null)).toBeNull()
  })

  it('第一关桌面版用 S / D 动态按键文案，但与触屏版共享同一语义手势', () => {
    const state = initial(level01Json)
    const guide = getChemTutorial(0, state, null, 'keyboard', 4)
    expect(guide?.title).toContain('WASD')
    expect(guide?.body).toContain('按 S')
    expect(guide?.gesture?.dir).toBe('S')

    const positioned = chemGame.step(state, 'S')
    const centerReveal = getChemTutorial(0, positioned, null, 'keyboard')
    expect(centerReveal?.title).toContain('箭头反面')
    expect(centerReveal?.tip).toContain('按 D')
    expect(centerReveal?.gesture?.dir).toBe('E')
  })

  it('首屏只用主指针精度与触点能力预判，不使用视口尺寸', () => {
    expect(initialTutorialInputMode({ coarsePrimaryPointer: true, maxTouchPoints: 5 })).toBe('touch')
    expect(initialTutorialInputMode({ coarsePrimaryPointer: true, maxTouchPoints: 0 })).toBe('keyboard')
    expect(initialTutorialInputMode({ coarsePrimaryPointer: false, maxTouchPoints: 10 })).toBe('keyboard')
  })

  it('真实指针来源可以覆盖首屏预判，未知来源保持原判', () => {
    expect(tutorialInputModeFromPointerType('touch')).toBe('touch')
    expect(tutorialInputModeFromPointerType('pen')).toBe('touch')
    expect(tutorialInputModeFromPointerType('mouse')).toBe('keyboard')
    expect(tutorialInputModeFromPointerType('')).toBeNull()
  })

  it('第二关撞错面后解释开口方向，且不伪报成普通移动', () => {
    const state = initial(level02Json)
    const guide = getChemTutorial(1, state, { kind: 'blocked', dir: 'W' })
    expect(guide?.feedbackTone).toBe('warning')
    expect(guide?.feedback).toContain('进不去')
    expect(guide?.feedback).toContain('白箭头')
  })

  it('第二关开场指向提示一步按钮，再聚焦中心教走到背面，就位后才提示位置正确', () => {
    const state = initial(level02Json)
    const hint = getChemTutorial(1, state, null, 'touch', 0)
    expect(hint?.title).toContain('提示一步')
    expect(hint?.body).toContain('不会替你行动')
    expect(hint?.controlTarget).toBe('hint')
    expect(hint?.advanceOnTap).toBe(true)
    expect(hint?.focusDirs).toEqual([])

    const spotlight = getChemTutorial(1, state, null, 'touch', 1)
    expect(spotlight?.title).toContain('白箭头')
    expect(spotlight?.body).toContain('反面')
    expect(spotlight?.advanceOnTap).toBe(true)
    expect(spotlight?.spotlight?.pos).toEqual([1, 1])
    expect(spotlight?.focusDirs).toEqual([])

    const walking = getChemTutorial(1, state, null, 'touch', 2)
    expect(walking?.controlTarget).toBeUndefined()
    expect(walking?.advanceOnTap).toBeUndefined()
    expect(walking?.spotlight).toBeUndefined()
    expect(walking?.gesture).toBeUndefined()
    expect(walking?.title).toContain('白箭头')

    let positioned = chemGame.step(state, 'S')
    positioned = chemGame.step(positioned, 'W')
    positioned = chemGame.step(positioned, 'W')
    positioned = chemGame.step(positioned, 'N')
    expect(positioned.player).toEqual([0, 1])
    const ready = getChemTutorial(1, positioned, null, 'touch', 2)
    expect(ready?.title).toContain('位置对了')
    expect(ready?.body).toContain('进攻位')
    expect(ready?.spotlight?.pos).toEqual([1, 1])
    expect(ready?.gesture).toMatchObject({ dir: 'E' })
    expect(ready?.advanceOnTap).toBeUndefined()
  })

  it('第三关依次建立游离珠、目标、手持、开口与落点，最后才教按住预演', () => {
    const beforePickup = initial(level03Json)
    const group = getChemTutorial(2, beforePickup, null, 'touch', 0)
    expect(group?.title).toContain('场上的紫珠')
    expect(group?.spotlight?.pos).toEqual([1, 0])
    expect(group?.advanceOnTap).toBe(true)

    const goal = getChemTutorial(2, beforePickup, null, 'touch', 1)
    expect(goal?.title).toContain('紫色虚线圈')
    expect(goal?.spotlight?.pos).toEqual([1, 0.54])

    const pickup = getChemTutorial(2, beforePickup, null, 'touch', 2)
    expect(pickup?.focusDirs).toEqual(['E'])
    expect(pickup?.gesture?.dir).toBe('E')
    expect(pickup?.kicker).toContain('03 / 07')

    const carrying = chemGame.step(beforePickup, 'E')
    expect(carrying.holding).toBe('purple')

    const hand = getChemTutorial(2, carrying, null, 'keyboard', 2)
    expect(hand?.title).toContain('拿在手中')
    expect(hand?.spotlight?.pos).toEqual([1.3, -0.3])
    expect(hand?.advanceOnTap).toBe(true)

    const opening = getChemTutorial(2, carrying, null, 'keyboard', 3)
    expect(opening?.title).toContain('白箭头开口')
    expect(opening?.spotlight?.pos).toEqual([1, 1])

    const landing = getChemTutorial(2, carrying, null, 'keyboard', 4)
    expect(landing?.body).toContain('就叫染色')
    expect(landing?.spotlight?.pos).toEqual([1, 0.54])

    const guide = getChemTutorial(2, carrying, null, 'keyboard', 5)
    expect(guide?.focusDirs).toEqual(['S'])
    expect(guide?.title).toContain('按住 S')
    expect(guide?.gesture).toMatchObject({ dir: 'S', hold: true })
    expect(guide?.forecast).toBeNull()
    expect(guide?.kicker).toContain('07 / 07')
    expect(guide?.spotlight?.pos).toEqual(carrying.player)

    const preview = getChemTutorial(2, carrying, { kind: 'preview', dir: 'S' }, 'keyboard', 5)
    expect(preview?.title).toContain('虚线')
    expect(preview?.body).toContain('落进目标圈')
    expect(preview?.feedback).toContain('预演中')
    // 键盘松开 = 取消（2026-08-29 输入模型决策）；触屏仍提示回到原位取消
    expect(preview?.feedback).toContain('松开即取消')
    expect(preview?.tip).toContain('轻点执行，松开取消')
    expect(preview?.forecast).toMatchObject({
      center: 0,
      dir: 'S',
      injected: 'purple',
      landingArm: 'N',
      showExtraction: false,
    })
    expect(preview?.spotlight?.pos).toEqual([1, 1])

    const touchGuide = getChemTutorial(2, carrying, null, 'touch', 5)
    expect(touchGuide?.title).toContain('向下拖住')
    expect(touchGuide?.tip).toContain('保持手指不动')
    const touchPreview = getChemTutorial(2, carrying, { kind: 'preview', dir: 'S' }, 'touch', 5)
    expect(touchPreview?.feedback).toContain('回到原位或按 Esc')
    expect(touchPreview?.tip).toContain('松手执行')
  })

  it('第四关把放入和换出作为两条结果并排说明', () => {
    const start = initial(level04Json)
    const pickup = getChemTutorial(3, start, null)
    expect(pickup?.kicker).toContain('01 / 04')
    expect(pickup?.gesture?.dir).toBe('E')
    const carrying = chemGame.step(start, 'E')
    const extraction = getChemTutorial(3, carrying, null, 'touch', 0)
    expect(extraction?.title).toContain('蓝珠')
    expect(extraction?.spotlight?.pos).toEqual([1, 1.46])
    expect(extraction?.advanceOnTap).toBe(true)

    const injection = getChemTutorial(3, carrying, null, 'touch', 1)
    expect(injection?.title).toContain('紫珠')
    expect(injection?.spotlight?.pos).toEqual([1.3, -0.3])

    const exchange = getChemTutorial(3, carrying, null, 'touch', 2)
    const forecast = exchange?.forecast
    expect(exchange?.gesture?.hold).toBe(true)
    expect(forecast).toMatchObject({
      injected: 'purple',
      extracted: 'blue',
      landingArm: 'N',
      showExtraction: true,
    })
  })

  it('第五关起撤掉状态驱动解题引导，让跨中心物流由玩家独立完成', () => {
    const state = initial(level05Json)
    expect(getChemTutorial(4, state, null, 'touch', 0)).toBeNull()

    let progressed = state
    progressed = chemGame.step(progressed, 'E')
    progressed = chemGame.step(progressed, 'S')
    expect(getChemTutorial(4, progressed, null)).toBeNull()
  })

  it('第六关不宣布空手不变式；第七关只教共振规则；第九关不预解唯一通路', () => {
    const state = initial(level06Json)
    expect(getChemTutorial(5, state, null, 'touch', 0)).toBeNull()
    expect(level06Json.name).toBe('先碰哪一座')
    expect(level06Json.hint).not.toMatch(/空手只有一次|不会再空|只能趁空手/)

    const resonance = initial(level07Json)
    const bond = getChemTutorial(6, resonance, null, 'touch', 0)
    expect(bond?.title).toContain('共振键')
    expect(bond?.spotlight?.pos).toEqual([4.5, 1])
    expect(getChemTutorial(6, resonance, null, 'touch', 1)?.title).toContain('亮键')
    expect(getChemTutorial(6, resonance, null, 'touch', 2)).toBeNull()
    expect(getChemTutorial(6, { ...resonance, moves: 1 }, null)).toBeNull()

    const unreachable = initial(level09Json)
    expect(getChemTutorial(8, unreachable, null, 'touch', 0)).toBeNull()
    expect(level09Json.hint).not.toContain('共振却传得进去')
  })

  it.each([
    [12, level13Json, ['光格', '白箭头', '臂上的珠'], [[1, 0], [2, 1], [2, 0.54]], '走向光格', 'N'],
    [13, level14Json, ['当前阶段', '下一阶段', '按顺序推进'], [[2, 1.54], [2.46, 2], [2, 2]], '完成当前的亮圈', 'E'],
    [17, level18Json, ['三臂中心', '空穴', '空穴方向', '蓝臂'], [[2, 2], [1.54, 2], [1.54, 2], [2.46, 2]], '撞动三臂中心', 'S'],
    [29, level30Json, ['阶段护罩', '第二阶段', '下一阶段', '结算后'], [[2, 1], [2, 2.54], [1.54, 1], [2, 1]], '完成第 1 阶段', 'W'],
    [36, level37Json, ['撞动另一座中心', '要撞动的中心', '远端进攻位', '仍留在落点'], [[3, 1], [0, 1], [1, 1], [1, 1]], '拿起紫珠', 'E'],
    [37, level38Json, ['触发光格', '白箭头', '继续撞中心'], [[1, 1], [0, 1], [1, 1]], '拿起紫珠', 'E'],
    [38, level39Json, ['再生护罩', '红臂', '虚线', '危险共振'], [[3, 1], [1, 0.54], [2, 0.77], [3, 1.5]], '改变控制臂', 'S'],
  ] as const)(
    '第 %i 关按对象、条件、结果逐拍揭示，最后才开放操作',
    (index, json, phrases, positions, actionPhrase, actionDir) => {
    const state = initial(json)
    phrases.forEach((phrase, beat) => {
      const reveal = getChemTutorial(index, state, null, 'touch', beat)
      expect(reveal?.title).toContain(phrase)
      expect(reveal?.spotlight?.pos).toEqual(positions[beat])
      expect(reveal?.advanceOnTap).toBe(true)
      expect(reveal?.focusDirs).toEqual([])
    })
    const action = getChemTutorial(index, state, null, 'touch', phrases.length)
    expect(action?.title).toContain(actionPhrase)
    expect(action?.gesture?.dir).toBe(actionDir)
    expect(action?.advanceOnTap).toBeUndefined()
    expect(getChemTutorial(index, { ...state, moves: 1 }, null)).toBeNull()
  })

  it('第 24 关先认弹射核与喷口，持珠就位后再解释离去珠和落点', () => {
    const state = initial(level24Json)
    expect(getChemTutorial(23, state, null, 'touch', 0)?.title).toContain('弹射中心')
    expect(getChemTutorial(23, state, null, 'touch', 1)?.title).toContain('喷口')
    const pickup = getChemTutorial(23, state, null, 'touch', 2)
    expect(pickup?.title).toContain('拾取紫珠')
    expect(pickup?.gesture?.dir).toBe('E')

    const carrying = chemGame.step(state, 'E')
    const positioning = getChemTutorial(23, carrying, null, 'touch', 2)
    expect(positioning?.title).toContain('进攻位')
    expect(positioning?.gesture?.dir).toBe('S')

    const ready = chemGame.step(carrying, 'S')
    const leaving = getChemTutorial(23, ready, null, 'touch', 2)
    expect(leaving?.title).toContain('开口原珠')
    expect(leaving?.spotlight?.pos).toEqual([2.46, 1])
    expect(leaving?.advanceOnTap).toBe(true)

    const landing = getChemTutorial(23, ready, null, 'touch', 3)
    expect(landing?.title).toContain('落点')
    expect(landing?.spotlight?.pos).toEqual([0, 1])

    const action = getChemTutorial(23, ready, null, 'touch', 4)
    expect(action?.title).toContain('长按')
    expect(action?.gesture).toMatchObject({ dir: 'E', hold: true })
    expect(action?.kicker).toContain('06 / 06')
  })
})
