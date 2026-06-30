import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/study-reader/',
  build: {
    outDir: '../study-reader',
    emptyOutDir: true,
  },
})