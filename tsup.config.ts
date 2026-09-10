import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', central: 'src/central/main.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: ['zod'],
  sourcemap: true,
  dts: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
