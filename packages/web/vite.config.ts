import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:3006',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3006',
        ws: true,
      },
    },
  },
  preview: {
    port: 5175,
    host: '0.0.0.0',
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  },
})
