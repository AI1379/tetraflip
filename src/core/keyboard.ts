import type { Dir } from './protocol'

/** 方向键 / WASD → 方向；非方向键返回 null */
export function dirFromKey(e: KeyboardEvent): Dir | null {
  switch (e.key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return 'N'
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'E'
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'S'
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return 'W'
    default:
      return null
  }
}

export const isUndoKey = (e: KeyboardEvent): boolean =>
  e.key === 'z' || e.key === 'Z' || e.key === 'Backspace'

export const isRestartKey = (e: KeyboardEvent): boolean => e.key === 'r' || e.key === 'R'
