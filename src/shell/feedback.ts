/**
 * 通关反馈（可选收集）：难度 / 趣味性两条 1–5 评分 + 可选快捷标签，POST 到自建 FastAPI 收集器。
 *
 * 构建期开关（design §8）：
 * - dev（vite dev）：默认开启，端点 `http://127.0.0.1:8787`，可用 `VITE_FEEDBACK_ENDPOINT` 覆盖；
 * - 生产构建：仅当 `VITE_FEEDBACK_ENDPOINT` 显式设置时开启；
 * - 任意环境可用 `?fb=<url>` 查询参数临时覆盖（cloudflared 快速隧道地址每次重启都变，免重建调试）。
 *
 * 关闭时完全不渲染 UI、不发任何请求：比赛提交的默认构建产物保持纯静态、零联网。
 * 本模块是壳层胶合（允许 any），但端点解析 / 载荷构建 / 评分校验抽成纯函数以便 vitest。
 */

export const DEFAULT_DEV_ENDPOINT = 'http://127.0.0.1:8787'

export interface FeedbackEnv {
  dev: boolean
  endpoint?: string
}

/** 端点解析优先级：`?fb=` 查询参数 > `VITE_FEEDBACK_ENDPOINT` > dev 默认回环 > 关闭（''） */
export function resolveEndpoint(env: FeedbackEnv, queryOverride?: string): string {
  const q = queryOverride?.trim()
  if (q) return q
  const e = env.endpoint?.trim()
  if (e) return e
  if (env.dev) return DEFAULT_DEV_ENDPOINT
  return ''
}

export type Rating = 1 | 2 | 3 | 4 | 5

export const FEEDBACK_TAGS = [
  { id: 'rules_unclear', label: '规则没看懂' },
  { id: 'stuck_reasoning', label: '卡在推理' },
  { id: 'controls_awkward', label: '操作不顺' },
  { id: 'too_much_walking', label: '走路太多' },
  { id: 'too_easy', label: '太简单' },
  { id: 'very_fun', label: '很有意思' },
] as const

export type FeedbackTag = (typeof FEEDBACK_TAGS)[number]['id']
const FEEDBACK_TAG_IDS = new Set<string>(FEEDBACK_TAGS.map((tag) => tag.id))

export function isRating(v: unknown): v is Rating {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5
}

export function isFeedbackTag(v: unknown): v is FeedbackTag {
  return typeof v === 'string' && FEEDBACK_TAG_IDS.has(v)
}

/** 忽略未知值并去重，保证会话旧数据与载荷始终落在后端白名单内。 */
export function normalizeFeedbackTags(values: readonly unknown[]): FeedbackTag[] {
  return [...new Set(values.filter(isFeedbackTag))]
}

export interface FeedbackInfo {
  game: string
  /** 1-based 关卡序号（人类可读） */
  level: number
  /** 关卡 JSON 的 id 字段 */
  levelId: string
  moves: number
  par?: number
  /** 与匿名完整尝试表连接；旧反馈和关闭遥测存储时均可省略。 */
  participantId?: string
  sessionId?: string
  attemptId?: string
}

export interface FeedbackPayload extends FeedbackInfo {
  difficulty: Rating
  fun: Rating
  tags?: FeedbackTag[]
}

export function buildPayload(
  info: FeedbackInfo,
  difficulty: Rating,
  fun: Rating,
  tags: readonly FeedbackTag[] = [],
): FeedbackPayload {
  const normalized = normalizeFeedbackTags(tags)
  return normalized.length > 0
    ? { ...info, difficulty, fun, tags: normalized }
    : { ...info, difficulty, fun }
}

/** 提交评分；8 秒超时，失败返回 false（不抛错，不影响游戏流程） */
export async function postFeedback(endpoint: string, payload: FeedbackPayload): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 端点解析（惰性 + 记忆化；顶层不访问 window，保证 Node 下可 import 测试） ----------

let cachedEndpoint: string | null = null

export function getEndpoint(): string {
  if (cachedEndpoint !== null) return cachedEndpoint
  const query =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('fb') ?? undefined : undefined
  cachedEndpoint = resolveEndpoint(
    { dev: import.meta.env.DEV, endpoint: import.meta.env.VITE_FEEDBACK_ENDPOINT as string | undefined },
    query,
  )
  return cachedEndpoint
}

export function isFeedbackEnabled(): boolean {
  return getEndpoint() !== ''
}

// ---------- 会话记忆：同关卡上次评分，重开可一键复评 ----------

const STORE_PREFIX = 'lexin.feedback.v1:'

function storeKey(info: FeedbackInfo): string {
  return `${STORE_PREFIX}${info.game}:${info.levelId || info.level}`
}

interface SavedFeedback {
  difficulty: Rating
  fun: Rating
  tags: FeedbackTag[]
}

function loadSaved(key: string): SavedFeedback | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as { difficulty?: unknown; fun?: unknown; tags?: unknown }
    if (!isRating(v.difficulty) || !isRating(v.fun)) return null
    const tags = Array.isArray(v.tags) ? normalizeFeedbackTags(v.tags) : []
    return { difficulty: v.difficulty, fun: v.fun, tags }
  } catch {
    return null
  }
}

function saveSaved(key: string, difficulty: Rating, fun: Rating, tags: readonly FeedbackTag[]): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ difficulty, fun, tags: normalizeFeedbackTags(tags) }))
  } catch {
    /* 隐私模式等存储不可用时忽略 */
  }
}

// ---------- DOM 挂载 ----------

const RATINGS: readonly Rating[] = [1, 2, 3, 4, 5]

function makeEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}

interface StarGroup {
  set: (v: Rating) => void
}

/** 一组 1–5 的 radio 星标按钮；支持方向键 / Home / End 键盘操作 */
function buildStarGroup(container: HTMLElement, label: string, onPick: (v: Rating) => void): StarGroup {
  const buttons: HTMLButtonElement[] = []
  for (const v of RATINGS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'feedback-star'
    b.textContent = '★'
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', 'false')
    b.setAttribute('aria-label', `${label} ${v} 分`)
    b.addEventListener('click', () => onPick(v))
    b.addEventListener('keydown', (e) => {
      const i = RATINGS.indexOf(v)
      let next = -1
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(i + 1, RATINGS.length - 1)
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(i - 1, 0)
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = RATINGS.length - 1
      if (next !== -1) {
        e.preventDefault()
        onPick(RATINGS[next])
        buttons[next].focus()
      }
    })
    container.appendChild(b)
    buttons.push(b)
  }
  return {
    set(v: Rating) {
      buttons.forEach((b, i) => b.setAttribute('aria-checked', String(RATINGS[i] === v)))
    },
  }
}

/**
 * 把反馈面板挂到通关卡片（overlay）里；未启用时保持隐藏。
 * 每次调用都会重建面板：主流程在每次 `showOverlay()` 时调用即可。
 */
export function mountFeedback(container: HTMLElement, info: FeedbackInfo): void {
  if (!isFeedbackEnabled()) {
    container.classList.add('hidden')
    container.replaceChildren()
    return
  }
  container.classList.remove('hidden')
  container.replaceChildren()

  const key = storeKey(info)
  const saved = loadSaved(key)
  const sel: { difficulty: Rating | null; fun: Rating | null } = {
    difficulty: saved?.difficulty ?? null,
    fun: saved?.fun ?? null,
  }

  const head = makeEl('div', 'feedback-head')
  head.append(
    makeEl('span', 'feedback-title', '通关反馈'),
    makeEl('small', 'feedback-sub', '可选'),
  )

  const groups = new Map<'difficulty' | 'fun', StarGroup>()
  const rowEls: HTMLElement[] = []
  const METRICS = [
    { metric: 'difficulty' as const, label: '难度', hint: '难度评分：1 最简单 – 5 最难' },
    { metric: 'fun' as const, label: '趣味', hint: '趣味评分：1 无聊 – 5 很好玩' },
  ]
  for (const def of METRICS) {
    const row = makeEl('div', 'feedback-row')
    row.append(makeEl('span', 'feedback-label', def.label))
    const stars = makeEl('div', 'feedback-stars')
    stars.setAttribute('role', 'radiogroup')
    stars.setAttribute('aria-label', def.hint)
    const group = buildStarGroup(stars, def.label, (v) => {
      sel[def.metric] = v
      group.set(v)
      syncSubmit()
    })
    groups.set(def.metric, group)
    row.append(stars)
    rowEls.push(row)
  }

  const selectedTags = new Set<FeedbackTag>(saved?.tags ?? [])
  const tagBlock = makeEl('div', 'feedback-tag-block')
  tagBlock.append(makeEl('span', 'feedback-tag-label', '快速标签 · 可多选'))
  const tagGroup = makeEl('div', 'feedback-tags')
  tagGroup.setAttribute('role', 'group')
  tagGroup.setAttribute('aria-label', '可选的反馈标签')
  for (const tag of FEEDBACK_TAGS) {
    const button = makeEl('button', 'feedback-tag', tag.label)
    button.type = 'button'
    button.setAttribute('aria-pressed', String(selectedTags.has(tag.id)))
    button.addEventListener('click', () => {
      if (selectedTags.has(tag.id)) selectedTags.delete(tag.id)
      else selectedTags.add(tag.id)
      button.setAttribute('aria-pressed', String(selectedTags.has(tag.id)))
    })
    tagGroup.append(button)
  }
  tagBlock.append(tagGroup)

  const actions = makeEl('div', 'feedback-actions')
  const submit = makeEl('button', 'feedback-submit', '提交')
  submit.type = 'button'
  const status = makeEl('span', 'feedback-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  actions.append(submit, status)

  const syncSubmit = (): void => {
    submit.disabled = !isRating(sel.difficulty) || !isRating(sel.fun)
  }

  // 预填上次评分（重开本关可一键复评）
  if (saved) {
    groups.get('difficulty')!.set(saved.difficulty)
    groups.get('fun')!.set(saved.fun)
  }
  syncSubmit()

  let submitted = false
  submit.addEventListener('click', async () => {
    if (submitted || !isRating(sel.difficulty) || !isRating(sel.fun)) return
    submit.disabled = true
    status.dataset.tone = 'pending'
    status.textContent = '发送中…'
    const tags = [...selectedTags]
    const ok = await postFeedback(getEndpoint(), buildPayload(info, sel.difficulty, sel.fun, tags))
    if (ok) {
      submitted = true
      status.dataset.tone = 'ok'
      status.textContent = '✓ 已提交，谢谢！'
      saveSaved(key, sel.difficulty, sel.fun, tags)
    } else {
      status.dataset.tone = 'error'
      status.textContent = '发送失败，可稍后重试或忽略'
      submit.disabled = false
    }
  })

  container.append(head, ...rowEls, tagBlock, actions)
}
