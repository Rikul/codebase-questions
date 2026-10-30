import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@cq/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
  // ES-module workers keep code splitting, so shiki grammars load per language instead of all at once.
  worker: { format: 'es' },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
