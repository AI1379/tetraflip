/**
 * 匿名试玩遥测。这里只记录解题过程的计数与时长，不记录按键序列、设备指纹或任何个人信息。
 * 纯状态转移与浏览器存储/上报分离，前者可在 Node 中测试。
 */

export const TELEMETRY_SCHEMA_VERSION = 1
export const TELEMETRY_STORE_KEY = 'lexin.telemetry.attempts.v1'
export const PARTICIPANT_STORE_KEY = 'lexin.telemetry.participant.v1'
export const SESSION_STORE_KEY = 'lexin.telemetry.session.v1'

export type AttemptOutcome = 'completed' | 'restart' | 'level_exit' | 'page_exit'
export type AttemptEvent =
  | 'valid_move'
  | 'invalid_input'
  | 'undo'
  | 'solver_hint'
  | 'preview'
  | 'inspect'
  | 'mark'
  | 'rules_open'
  | 'budget_exhausted'

export interface AttemptCounters {
  validMoves: number
  invalidInputs: number
  undos: number
  solverHints: number
  previews: number
  inspects: number
  marks: number
  rulesOpened: number
  budgetExhausted: boolean
}

export interface AttemptInfo {
  attemptId: string
  participantId: string
  sessionId: string
  game: string
  level: number
  levelId: string
  sessionAttemptIndex: number
  condition: {
    tutorialEnabled: boolean
    animationMode: 'clear' | 'fast'
    inputMode: 'keyboard' | 'touch'
    visualBlindMode: boolean
    /** 量化试玩可用 ?study=natural|mastery 标记；普通游玩省略。 */
    cohort?: string
    assignment?: string
  }
  par?: number
  moveLimit?: number
  stageCount?: number
}

export interface AttemptDraft extends AttemptInfo {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  startedAt: string
  startedAtMs: number
  activeMs: number
  activeSinceMs: number | null
  maxStage: number
  counters: AttemptCounters
  finished: boolean
}

export interface AttemptRecord extends AttemptInfo {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  startedAt: string
  endedAt: string
  durationMs: number
  activeMs: number
  outcome: AttemptOutcome
  completed: boolean
  assisted: boolean
  finalMoves: number
  finalStage: number
  maxStage: number
  counters: AttemptCounters
}

export interface AttemptFinishState {
  moves: number
  stage?: number
}

const emptyCounters = (): AttemptCounters => ({
  validMoves: 0,
  invalidInputs: 0,
  undos: 0,
  solverHints: 0,
  previews: 0,
  inspects: 0,
  marks: 0,
  rulesOpened: 0,
  budgetExhausted: false,
})

export function createAttempt(info: AttemptInfo, nowMs: number, active = true): AttemptDraft {
  return {
    ...info,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    startedAt: new Date(nowMs).toISOString(),
    startedAtMs: nowMs,
    activeMs: 0,
    activeSinceMs: active ? nowMs : null,
    maxStage: 0,
    counters: emptyCounters(),
    finished: false,
  }
}

function accrueActive(draft: AttemptDraft, nowMs: number): void {
  if (draft.activeSinceMs === null) return
  draft.activeMs += Math.max(0, nowMs - draft.activeSinceMs)
  draft.activeSinceMs = nowMs
}

export function setAttemptActive(draft: AttemptDraft, active: boolean, nowMs: number): void {
  if (draft.finished) return
  if (active) {
    if (draft.activeSinceMs === null) draft.activeSinceMs = nowMs
  } else if (draft.activeSinceMs !== null) {
    accrueActive(draft, nowMs)
    draft.activeSinceMs = null
  }
}

export function observeAttemptStage(draft: AttemptDraft, stage: number): void {
  if (!draft.finished) draft.maxStage = Math.max(draft.maxStage, stage)
}

export function recordAttemptEvent(draft: AttemptDraft, event: AttemptEvent): void {
  if (draft.finished) return
  switch (event) {
    case 'valid_move': draft.counters.validMoves++; break
    case 'invalid_input': draft.counters.invalidInputs++; break
    case 'undo': draft.counters.undos++; break
    case 'solver_hint': draft.counters.solverHints++; break
    case 'preview': draft.counters.previews++; break
    case 'inspect': draft.counters.inspects++; break
    case 'mark': draft.counters.marks++; break
    case 'rules_open': draft.counters.rulesOpened++; break
    case 'budget_exhausted': draft.counters.budgetExhausted = true; break
  }
}

export function finishAttempt(
  draft: AttemptDraft,
  outcome: AttemptOutcome,
  state: AttemptFinishState,
  nowMs: number,
): AttemptRecord | null {
  if (draft.finished) return null
  accrueActive(draft, nowMs)
  draft.activeSinceMs = null
  draft.finished = true
  const finalStage = state.stage ?? 0
  draft.maxStage = Math.max(draft.maxStage, finalStage)
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    attemptId: draft.attemptId,
    participantId: draft.participantId,
    sessionId: draft.sessionId,
    game: draft.game,
    level: draft.level,
    levelId: draft.levelId,
    sessionAttemptIndex: draft.sessionAttemptIndex,
    condition: { ...draft.condition },
    ...(draft.par === undefined ? {} : { par: draft.par }),
    ...(draft.moveLimit === undefined ? {} : { moveLimit: draft.moveLimit }),
    ...(draft.stageCount === undefined ? {} : { stageCount: draft.stageCount }),
    startedAt: draft.startedAt,
    endedAt: new Date(nowMs).toISOString(),
    durationMs: Math.max(0, nowMs - draft.startedAtMs),
    activeMs: draft.activeMs,
    outcome,
    completed: outcome === 'completed',
    assisted: draft.counters.solverHints > 0,
    finalMoves: state.moves,
    finalStage,
    maxStage: draft.maxStage,
    counters: { ...draft.counters },
  }
}

export function anonymousId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function persistentAnonymousId(store: Storage | null, key: string): string {
  try {
    const existing = store?.getItem(key)
    if (existing) return existing
    const created = anonymousId()
    store?.setItem(key, created)
    return created
  } catch {
    return anonymousId()
  }
}

/** 本地最多保留最近 500 次完整尝试；生产静态包即使不配置端点也可由试玩者导出。 */
export function appendLocalAttempt(
  store: Storage | null,
  record: AttemptRecord,
  limit = 500,
): void {
  if (!store) return
  try {
    const raw = store.getItem(TELEMETRY_STORE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    const rows = Array.isArray(parsed) ? parsed : []
    rows.push(record)
    store.setItem(TELEMETRY_STORE_KEY, JSON.stringify(rows.slice(-limit)))
  } catch {
    // 存储配额或隐私模式不影响游戏。
  }
}

export async function postAttempt(endpoint: string, record: AttemptRecord): Promise<boolean> {
  if (!endpoint) return false
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/api/attempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
      keepalive: true,
    })
    return response.ok
  } catch {
    return false
  }
}

export function beaconAttempt(endpoint: string, record: AttemptRecord): boolean {
  if (!endpoint || typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
    return false
  }
  // 字符串使用 CORS safelisted text/plain；服务端按原始 JSON body 校验，避免页面卸载时预检失败。
  return navigator.sendBeacon(
    `${endpoint.replace(/\/+$/, '')}/api/attempt`,
    JSON.stringify(record),
  )
}
