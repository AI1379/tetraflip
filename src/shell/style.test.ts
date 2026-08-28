import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')

describe('壳层主题 CSS 隔离', () => {
  it('浅色专用选择器在 LV.999 临时主题中全部停用', () => {
    const unguardedLightSelectors = css.match(
      /^:root\[data-theme="light"\](?!:not\(\[data-level-theme="lv999"\]\))/gm,
    )

    expect(unguardedLightSelectors).toBeNull()
    expect(css).toContain(':root[data-level-theme="lv999"]')
  })
})
