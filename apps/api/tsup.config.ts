import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server.ts', 'render-worker': 'src/modules/render/worker.ts' },
  format: ['esm'],
  target: 'node22',
  clean: true,
  noExternal: ['@carbone-reports/shared'],
});
