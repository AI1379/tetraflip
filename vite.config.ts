/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

// base './' 让产物用相对路径引用资源，方便静态托管（itch.io / GitHub Pages）
export default defineConfig({
  base: './',
  test: {
    include: ['src/**/*.test.ts'],
  },
})
