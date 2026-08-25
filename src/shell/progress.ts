/**
 * 浏览器本地进度持久化（纯静态页，无后端）。
 *
 * 只存两样轻量数据：
 * - completed：已通关关卡，元素形如 `game:levelId`（缺省 id 时回退到关卡序号）；
 * - current：每个游戏最近打开的关卡（0 基索引）。
 *
 * 不使用 IndexedDB / 云端，因为数据量很小、同步读写足够，localStorage 可覆盖大多数
 * 纯静态 H5 存档需求；所有访问都做 try/catch，隐私模式 / 存储满 / 被禁用时静默降级，
 * 不影响游戏运行。
 */

export const PROGRESS_STORAGE_KEY = 'lexin.progress.v1'

export interface ProgressData {
  completed: string[]
  current: Record<string, number>
}

export function emptyProgress(): ProgressData {
  return { completed: [], current: {} }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function normalizeCompleted(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.includes(':') && !out.includes(item)) out.push(item)
  }
  return out
}

function normalizeCurrent(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value
  }
  return out
}

export function loadProgress(storage: Pick<Storage, 'getItem'>): ProgressData {
  try {
    const raw = storage.getItem(PROGRESS_STORAGE_KEY)
    if (!raw) return emptyProgress()
    const data: unknown = JSON.parse(raw)
    if (!isRecord(data)) return emptyProgress()
    return {
      completed: normalizeCompleted(data.completed),
      current: normalizeCurrent(data.current),
    }
  } catch {
    return emptyProgress()
  }
}

export function saveProgress(storage: Pick<Storage, 'setItem'>, data: ProgressData): void {
  try {
    storage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* 隐私模式 / 配额满等场景静默降级 */
  }
}

export function addCompleted(data: ProgressData, key: string): ProgressData {
  if (data.completed.includes(key)) return data
  return { ...data, completed: [...data.completed, key] }
}

export function setCurrentLevel(data: ProgressData, game: string, index: number): ProgressData {
  return { ...data, current: { ...data.current, [game]: index } }
}
