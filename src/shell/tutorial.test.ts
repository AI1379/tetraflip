import { describe, expect, it } from 'vitest'
import level01Json from '../games/chem/levels/level-01.json'
import level02Json from '../games/chem/levels/level-02.json'
import level03Json from '../games/chem/levels/level-03.json'
import level04Json from '../games/chem/levels/level-04.json'
import level05Json from '../games/chem/levels/level-05.json'
import level10Json from '../games/chem/levels/level-10.json'
import level16Json from '../games/chem/levels/level-16.json'
import level17Json from '../games/chem/levels/level-17.json'
import level21Json from '../games/chem/levels/level-21.json'
import level27Json from '../games/chem/levels/level-27.json'
import level33Json from '../games/chem/levels/level-33.json'
import level41Json from '../games/chem/levels/level-41.json'
import level43Json from '../games/chem/levels/level-43.json'
import { chemGame } from '../games/chem'
import type { ChemState } from '../games/chem'
import {
  getChemTutorial,
  initialTutorialInputMode,
  tutorialInputModeFromPointerType,
} from './tutorial'

const initial = (json: unknown): ChemState => chemGame.initialState(chemGame.parseLevel(json))

describe('01–05 状态驱动操作引导', () => {
  it('第一关先给滑动手势，到达站位后再聚光中心并提示撞入', () => {
    const state = initial(level01Json)
    const guide = getChemTutorial(0, state, null)
    expect(guide?.focusDirs).toEqual(['S'])
    expect(guide?.gesture?.dir).toBe('S')
    expect(guide?.title).toContain('向下滑动')

    const positioned = chemGame.step(state, 'S')
    const centerReveal = getChemTutorial(0, positioned, null)
    expect(centerReveal?.title).toContain('四元中心')
    expect(centerReveal?.focusDirs).toEqual(['E'])
    expect(centerReveal?.gesture?.dir).toBe('E')

    expect(getChemTutorial(0, chemGame.step(positioned, 'E'), null)).toBeNull()
  })

  it('第一关桌面版用 S / D 动态按键文案，但与触屏版共享同一语义手势', () => {
    const state = initial(level01Json)
    const guide = getChemTutorial(0, state, null, 'keyboard')
    expect(guide?.title).toContain('按 S')
    expect(guide?.body).toContain('WASD')
    expect(guide?.gesture?.dir).toBe('S')

    const positioned = chemGame.step(state, 'S')
    const centerReveal = getChemTutorial(0, positioned, null, 'keyboard')
    expect(centerReveal?.title).toContain('四元中心')
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
    expect(guide?.feedback).toContain('封闭面')
    expect(guide?.feedback).toContain('白箭头')
  })

  it('第三关拾珠后先教按住预演，预演出现时再揭示单向放入结果', () => {
    const beforePickup = initial(level03Json)
    expect(getChemTutorial(2, beforePickup, null)?.focusDirs).toEqual(['E'])

    const carrying = chemGame.step(beforePickup, 'E')
    const guide = getChemTutorial(2, carrying, null, 'keyboard')
    expect(carrying.holding).toBe('purple')
    expect(guide?.focusDirs).toEqual(['S'])
    expect(guide?.title).toContain('按住 S')
    expect(guide?.gesture).toMatchObject({ dir: 'S', hold: true })
    expect(guide?.forecast).toBeNull()

    const preview = getChemTutorial(2, carrying, { kind: 'preview', dir: 'S' }, 'keyboard')
    expect(preview?.title).toContain('这就是预演')
    expect(preview?.body).toContain('这就是染色')
    expect(preview?.feedback).toContain('预演中')
    expect(preview?.feedback).toContain('回到原位或按 Esc')
    expect(preview?.forecast).toMatchObject({
      center: 0,
      dir: 'S',
      injected: 'purple',
      landingArm: 'N',
      showExtraction: false,
    })

    const touchGuide = getChemTutorial(2, carrying, null, 'touch')
    expect(touchGuide?.title).toContain('向下拖住')
    expect(touchGuide?.tip).toContain('保持手指不动')
  })

  it('第四关把放入和换出作为两条结果并排说明', () => {
    const carrying = chemGame.step(initial(level04Json), 'E')
    const forecast = getChemTutorial(3, carrying, null)?.forecast
    expect(forecast).toMatchObject({
      injected: 'purple',
      extracted: 'blue',
      landingArm: 'N',
      showExtraction: true,
    })
  })

  it('第五关随物流状态从紫珠取货切换到蓝珠送货', () => {
    let state = initial(level05Json)
    state = chemGame.step(state, 'E')
    state = chemGame.step(state, 'S')
    const carryingBlue = getChemTutorial(4, state, null)
    expect(carryingBlue?.title).toContain('蓝珠到手')

    state = chemGame.step(state, 'E')
    state = chemGame.step(state, 'E')
    const atDelivery = getChemTutorial(4, state, null)
    expect(atDelivery?.forecast).toMatchObject({
      center: 1,
      dir: 'S',
      injected: 'blue',
      extracted: 'green',
      landingArm: 'N',
    })
  })

  it('第六关起不再常驻新手引导', () => {
    expect(getChemTutorial(5, initial(level05Json), null)).toBeNull()
  })

  it.each([
    [9, level10Json, '共振键'],
    [15, level16Json, '光照格'],
    [16, level17Json, '当前阶段'],
    [20, level21Json, '三臂中心'],
    [26, level27Json, '弹射中心'],
    [32, level33Json, '阶段护罩'],
    [40, level41Json, '撞动结构'],
    [42, level43Json, '带 R 的护罩'],
  ] as const)('第 %i 关首次行动前提供对象绑定机制揭示', (index, json, phrase) => {
    const state = initial(json)
    const reveal = getChemTutorial(index, state, null)
    expect(reveal?.title).toContain(phrase)
    expect(reveal?.spotlight).toBeDefined()
    expect(getChemTutorial(index, { ...state, moves: 1 }, null)).toBeNull()
  })
})
