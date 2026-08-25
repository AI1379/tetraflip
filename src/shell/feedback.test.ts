import { describe, expect, it } from 'vitest'
import { DEFAULT_DEV_ENDPOINT, buildPayload, isRating, resolveEndpoint } from './feedback'

describe('resolveEndpoint（构建期开关解析）', () => {
  it('dev 默认指向本地回环收集器', () => {
    expect(resolveEndpoint({ dev: true })).toBe(DEFAULT_DEV_ENDPOINT)
    expect(DEFAULT_DEV_ENDPOINT.startsWith('http://127.0.0.1:')).toBe(true)
  })

  it('环境变量优先于 dev 默认值', () => {
    expect(resolveEndpoint({ dev: true, endpoint: 'https://fb.example.com' })).toBe('https://fb.example.com')
  })

  it('生产构建未设置端点时关闭（默认产物零联网）', () => {
    expect(resolveEndpoint({ dev: false })).toBe('')
  })

  it('`?fb=` 查询参数覆盖优先级最高（cloudflared 隧道免重建调试）', () => {
    expect(resolveEndpoint({ dev: false, endpoint: 'https://a.example.com' }, '  https://b.example.com  ')).toBe(
      'https://b.example.com',
    )
  })
})

describe('isRating', () => {
  it('只接受 1–5 整数', () => {
    for (let v = 1; v <= 5; v++) expect(isRating(v)).toBe(true)
    expect(isRating(0)).toBe(false)
    expect(isRating(6)).toBe(false)
    expect(isRating(2.5)).toBe(false)
    expect(isRating('3')).toBe(false)
    expect(isRating(null)).toBe(false)
  })
})

describe('buildPayload', () => {
  it('原样携带关卡信息与两条评分', () => {
    const p = buildPayload({ game: 'chem', level: 12, levelId: 'level-12', moves: 8, par: 7 }, 3, 5)
    expect(p).toEqual({ game: 'chem', level: 12, levelId: 'level-12', moves: 8, par: 7, difficulty: 3, fun: 5 })
  })

  it('par 缺失时载荷不携带该字段', () => {
    const p = buildPayload({ game: 'chem', level: 1, levelId: 'level-01', moves: 4 }, 2, 4)
    expect(p).toEqual({ game: 'chem', level: 1, levelId: 'level-01', moves: 4, difficulty: 2, fun: 4 })
    expect('par' in p).toBe(false)
  })
})
