import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    rollupOptions: {
      output: {
        // Naming only; chunking stays Rollup's. The shared recharts core chunk
        // is named after whichever module Rollup meets first —
        // `generateCategoricalChart` in the Phase 0 baseline, `chartTheme` once
        // every chart imported the palette — and the UI inventory matches
        // chunks by name, so a rename read as 100KB of growth. Pinning the
        // baseline's name keeps that chunk under its budget check.
        chunkFileNames: (chunk) => chunk.moduleIds.some((id) => id.includes('/recharts/es6/chart/generateCategoricalChart'))
          ? 'assets/generateCategoricalChart-[hash].js'
          : 'assets/[name]-[hash].js',
      },
    },
  },
})
