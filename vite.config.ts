/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const faviconPath = fileURLToPath(new URL('./public/favicon.svg', import.meta.url))

function assetText(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : Buffer.from(source).toString('utf8')
}

function normalizeAssetHref(href: string): string {
  return href.replace(/^(?:\.\/|\/)+/, '').split(/[?#]/, 1)[0]
}

function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
}

function escapeInlineStyle(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style')
}

/**
 * Vite/Rollup keeps doing the transform and minification; this final build hook
 * only packages the already-built entry, stylesheet and favicon into index.html.
 */
function singleFileBuild(): Plugin {
  const faviconDataUri = `data:image/svg+xml;base64,${readFileSync(faviconPath).toString('base64')}`

  return {
    name: 'tetraflip-single-file-build',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        let inlined = false
        const result = html.replace(/<link\b[^>]*>/gi, (tag) => {
          const rel = tag.match(/\brel=(['"])(.*?)\1/i)?.[2]
          const href = tag.match(/\bhref=(['"])(.*?)\1/i)?.[2]
          if (!rel?.split(/\s+/).includes('icon') || normalizeAssetHref(href ?? '') !== 'favicon.svg') {
            return tag
          }

          inlined = true
          return tag.replace(/\bhref=(['"])(.*?)\1/i, `href="${faviconDataUri}"`)
        })

        if (!inlined) throw new Error('single-file build could not find the favicon link')
        return result
      },
    },
    generateBundle(_options, bundle) {
      const htmlAsset = Object.values(bundle).find(
        (item) => item.type === 'asset' && item.fileName === 'index.html',
      )
      if (!htmlAsset || htmlAsset.type !== 'asset') {
        throw new Error('single-file build could not find index.html')
      }

      const chunks = Object.values(bundle).filter((item) => item.type === 'chunk')
      if (chunks.length !== 1 || !chunks[0].isEntry) {
        throw new Error(`single-file build requires one entry chunk, received ${chunks.length}`)
      }

      let html = assetText(htmlAsset.source)
      const entry = chunks[0]
      let scriptInlined = false
      html = html.replace(/<script\b[^>]*>\s*<\/script>/gi, (tag) => {
        const src = tag.match(/\bsrc=(['"])(.*?)\1/i)?.[2]
        if (normalizeAssetHref(src ?? '') !== entry.fileName) return tag
        scriptInlined = true
        return `<script type="module">${escapeInlineScript(entry.code)}</script>`
      })
      if (!scriptInlined) {
        throw new Error(`single-file build could not inline ${entry.fileName}`)
      }
      delete bundle[entry.fileName]

      const styles = Object.values(bundle).filter(
        (item) => item.type === 'asset' && item.fileName.endsWith('.css'),
      )
      for (const style of styles) {
        if (style.type !== 'asset') {
          throw new Error(`single-file build expected ${style.fileName} to be an asset`)
        }
        let styleInlined = false
        html = html.replace(/<link\b[^>]*>/gi, (tag) => {
          const rel = tag.match(/\brel=(['"])(.*?)\1/i)?.[2]
          const href = tag.match(/\bhref=(['"])(.*?)\1/i)?.[2]
          if (rel !== 'stylesheet' || normalizeAssetHref(href ?? '') !== style.fileName) return tag
          styleInlined = true
          return `<style>${escapeInlineStyle(assetText(style.source))}</style>`
        })
        if (!styleInlined) {
          throw new Error(`single-file build could not inline ${style.fileName}`)
        }
        delete bundle[style.fileName]
      }

      const documentShell = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
      if (/\b(?:src|href)=(['"])(?!data:|#)[^'"]+\1/i.test(documentShell)) {
        throw new Error('single-file build left an external src or href in index.html')
      }

      const leftoverFiles = Object.values(bundle)
        .filter((item) => item.fileName !== 'index.html')
        .map((item) => item.fileName)
      if (leftoverFiles.length > 0) {
        throw new Error(`single-file build left output files: ${leftoverFiles.join(', ')}`)
      }
      htmlAsset.source = html
    },
  }
}

export default defineConfig(({ command }) => ({
  // dev 继续从 public/ 提供 favicon；build 时由插件将它内联进唯一的 HTML。
  publicDir: command === 'build' ? false : 'public',
  base: './',
  plugins: [singleFileBuild()],
  test: {
    include: ['src/**/*.test.ts'],
  },
}))
