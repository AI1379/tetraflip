/**
 * 秘籍序列匹配器（design §5 LV.999 四次决策：入口隐藏化）。
 * 纯逻辑零 DOM，供壳层接入 Konami 序列（桌面）与滑动序列（触屏）两条秘籍入口。
 *
 * 键盘采用「按位置的原生键集合」匹配而非先归一化再比对：WASD 的 a 既是「左」又是
 * 序列末键 A，单符号归一化会让纯 WASD 玩家永远输不完经典序列；按位置接受
 * 方向键或对应 WASD 键，两套输入各自完整可输。
 */

export type KonamiDirSymbol = 'U' | 'D' | 'L' | 'R'

/** 桌面 Konami：↑↑↓↓←→←→BA（每一拍接受方向键或对应 WASD 键；末两拍为字面 B / A 键） */
export const KONAMI_KEYBOARD_PATTERN: readonly (readonly string[])[] = [
  ['ArrowUp', 'w', 'W'],
  ['ArrowUp', 'w', 'W'],
  ['ArrowDown', 's', 'S'],
  ['ArrowDown', 's', 'S'],
  ['ArrowLeft', 'a', 'A'],
  ['ArrowRight', 'd', 'D'],
  ['ArrowLeft', 'a', 'A'],
  ['ArrowRight', 'd', 'D'],
  ['b', 'B'],
  ['a', 'A'],
] as const

/** 触屏前缀：棋盘滑动 ↑↑↓↓←→←→（双击由壳层单独判定） */
export const KONAMI_TOUCH_PATTERN: readonly KonamiDirSymbol[] = ['U', 'U', 'D', 'D', 'L', 'R', 'L', 'R']

/** 键是否属于秘籍字母表（不属于的键应让调用方 reset 进度） */
export function isKonamiAlphabetKey(key: string): boolean {
  return KONAMI_KEYBOARD_PATTERN.some((position) => position.includes(key))
}

/** 引擎方向 → 滑动序列符号（触屏滑动入口用） */
export function konamiKeyFromDir(dir: 'N' | 'E' | 'S' | 'W'): KonamiDirSymbol {
  if (dir === 'N') return 'U'
  if (dir === 'S') return 'D'
  if (dir === 'W') return 'L'
  return 'R'
}

export interface KonamiMatcher {
  /** 推入一个原始输入；恰好完整命中目标序列时返回 true（定长尾部窗口，支持部分重叠续配） */
  push(input: string): boolean
  /** 清空缓冲（字母表外的键、或换关 / 弹窗打断时） */
  reset(): void
}

function createWindowMatcher(accepts: readonly (readonly string[])[]): KonamiMatcher {
  const buf: string[] = []
  return {
    push(input) {
      buf.push(input)
      if (buf.length > accepts.length) buf.shift()
      if (buf.length < accepts.length) return false
      return accepts.every((position, i) => position.includes(buf[i]))
    },
    reset() {
      buf.length = 0
    },
  }
}

/** 键盘入口：按位置接受方向键 / WASD / 字面 B A */
export function createKeyboardKonamiMatcher(): KonamiMatcher {
  return createWindowMatcher(KONAMI_KEYBOARD_PATTERN)
}

/** 触屏滑动入口：方向符号序列 */
export function createTouchKonamiMatcher(): KonamiMatcher {
  return createWindowMatcher(KONAMI_TOUCH_PATTERN.map((symbol) => [symbol] as const))
}
