import { describe, expect, it } from 'vitest'
import {
  KONAMI_KEYBOARD_PATTERN,
  KONAMI_TOUCH_PATTERN,
  createKeyboardKonamiMatcher,
  createTouchKonamiMatcher,
  isKonamiAlphabetKey,
  konamiKeyFromDir,
} from './konami'

describe('LV.999 秘籍匹配器', () => {
  it('键盘模式为 10 拍经典序列，方向拍接受方向键或 WASD，末两拍为字面 B / A', () => {
    expect(KONAMI_KEYBOARD_PATTERN).toHaveLength(10)
    expect(KONAMI_KEYBOARD_PATTERN[0]).toContain('ArrowUp')
    expect(KONAMI_KEYBOARD_PATTERN[0]).toContain('w')
    expect(KONAMI_KEYBOARD_PATTERN[4]).toContain('ArrowLeft')
    expect(KONAMI_KEYBOARD_PATTERN[4]).toContain('a')
    expect(KONAMI_KEYBOARD_PATTERN[8]).toEqual(['b', 'B'])
    expect(KONAMI_KEYBOARD_PATTERN[9]).toEqual(['a', 'A'])
  })

  it('触屏模式为 8 滑前缀', () => {
    expect(KONAMI_TOUCH_PATTERN).toEqual(['U', 'U', 'D', 'D', 'L', 'R', 'L', 'R'])
  })

  it('字母表判定：方向键 / WASD / B 在表内，其余键不在', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'b', 'B', 'W', 'A']) {
      expect(isKonamiAlphabetKey(key)).toBe(true)
    }
    for (const key of ['z', 'r', 'h', 'g', 'm', 'Escape', 'Enter', ' ']) {
      expect(isKonamiAlphabetKey(key)).toBe(false)
    }
  })

  it('引擎方向映射到滑动序列符号', () => {
    expect(konamiKeyFromDir('N')).toBe('U')
    expect(konamiKeyFromDir('S')).toBe('D')
    expect(konamiKeyFromDir('W')).toBe('L')
    expect(konamiKeyFromDir('E')).toBe('R')
  })

  it('纯方向键可以完整命中', () => {
    const m = createKeyboardKonamiMatcher()
    const seq = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']
    seq.slice(0, 9).forEach((k) => expect(m.push(k)).toBe(false))
    expect(m.push('a')).toBe(true)
  })

  it('纯 WASD 也可以完整命中（a 在左位是左、在末位是 A）', () => {
    const m = createKeyboardKonamiMatcher()
    const seq = ['w', 'w', 's', 's', 'a', 'd', 'a', 'd', 'b', 'a']
    seq.slice(0, 9).forEach((k) => expect(m.push(k)).toBe(false))
    expect(m.push('a')).toBe(true)
  })

  it('混合输入（方向键 + WASD）同样可命中', () => {
    const m = createKeyboardKonamiMatcher()
    const seq = ['ArrowUp', 'w', 'ArrowDown', 's', 'ArrowLeft', 'd', 'a', 'ArrowRight', 'B', 'A']
    let hit = false
    for (const k of seq) hit = m.push(k) || hit
    expect(hit).toBe(true)
  })

  it('尾部窗口支持部分重叠续配：开头多按一次 ↑ 后仍可命中', () => {
    const m = createKeyboardKonamiMatcher()
    const seq = ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']
    let hit = false
    for (const k of seq) hit = m.push(k) || hit
    expect(hit).toBe(true)
  })

  it('reset 清空缓冲：中断后必须从头再输', () => {
    const m = createKeyboardKonamiMatcher()
    for (const k of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown']) m.push(k)
    m.reset()
    // 只剩 6 键不足以命中 10 拍序列
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) {
      expect(m.push(k)).toBe(false)
    }
  })

  it('触屏匹配器在第八滑命中', () => {
    const m = createTouchKonamiMatcher()
    for (const k of ['U', 'U', 'D', 'D', 'L', 'R', 'L']) {
      expect(m.push(k)).toBe(false)
    }
    expect(m.push('R')).toBe(true)
  })

  it('普通走棋不会误触触屏序列：窗口只保留最近 8 滑且要求逐位吻合', () => {
    const m = createTouchKonamiMatcher()
    for (const k of ['U', 'D', 'U', 'D', 'L', 'R', 'L', 'R', 'U', 'D']) {
      m.push(k)
    }
    // 最后 8 滑 = U D U D L R L R ≠ 目标
    expect(m.push('U')).toBe(false)
    expect(m.push('D')).toBe(false)
  })
})
