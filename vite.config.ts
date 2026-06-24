import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'path';
import { MOD_VERSION } from './src/version';

// Sync the single-source MOD_VERSION (src/version.ts) into the JSON files that can't
// import it. Runs at build start, BEFORE viteStaticCopy copies manifest.json into dist —
// so the deployed dist/manifest.json carries MOD_VERSION too. Targeted version-line
// rewrite (preserves formatting) + idempotent (only writes when it actually changed), so a
// normal build leaves the tree clean and bumping MOD_VERSION updates both JSONs.
function syncVersion() {
  return {
    name: 'sync-mod-version',
    buildStart() {
      for (const file of ['manifest.json', 'package.json']) {
        const p = path.resolve(__dirname, file);
        const content = readFileSync(p, 'utf-8');
        const updated = content.replace(/("version":\s*)"[^"]*"/, `$1"${MOD_VERSION}"`);
        if (updated !== content) {
          writeFileSync(p, updated);
          console.log(`[sync-mod-version] ${file} -> ${MOD_VERSION}`);
        }
      }
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      'react/jsx-runtime': path.resolve(__dirname, 'src/types/react.ts'),
      'react': path.resolve(__dirname, 'src/types/react.ts'),
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
    keepNames: true,
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      formats: ['iife'],
      name: 'SubwayMod',
      fileName: () => 'index.js',
    },
    outDir: 'dist',
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
      },
    },
  },
  plugins: [
    syncVersion(),
    viteStaticCopy({
      targets: [
        {
          src: 'manifest.json',
          dest: '.',
        },
      ],
    }),
  ],
});
