import { defineConfig } from 'vite'

declare const process: { env: Record<string, string | undefined> }

export default defineConfig({
  server: {
    proxy: {
      '/api': process.env.API_PROXY_TARGET || 'http://127.0.0.1:8080',
    },
  },
})
