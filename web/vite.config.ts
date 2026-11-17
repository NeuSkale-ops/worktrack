import { defineConfig } from 'vite'

declare const process: { env: Record<string, string | undefined> }

// pnpm keeps packages outside this folder, so the dev server must be told it
// may serve the bundled font files. Without this they return 403 in `pnpm dev`.
const fontDir = (name: string) => new URL('.', import.meta.resolve(`@fontsource-variable/${name}/index.css`)).pathname

export default defineConfig({
  server: {
    fs: { allow: ['.', fontDir('bricolage-grotesque'), fontDir('instrument-sans')] },
    proxy: {
      '/api': process.env.API_PROXY_TARGET || 'http://127.0.0.1:8080',
    },
  },
})
