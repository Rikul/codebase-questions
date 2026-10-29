import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@cq/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) } },
  test: { environment: 'node', testTimeout: 30000, include: ['test/**/*.test.ts'], exclude: ['test/fixtures/**', 'node_modules/**'] },
});
