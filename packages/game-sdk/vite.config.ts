import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Two separate library builds, selected by COUCH_SDK_FORMAT, so each format gets
// the exports shape it needs:
//
//   ESM  (dist/couch-sdk.js)      — entry src/index.ts, NAMED exports. This is the
//                                   package `import` entry; the host app does
//                                   `import type { CouchPlayer } from '@couch/game-sdk'`.
//
//   IIFE (dist/couch-sdk.iife.js) — entry src/iife.ts, DEFAULT export only, emitted
//                                   with rollup `exports: 'default'` so the browser
//                                   global `CouchSDK` IS the SDK object directly
//                                   (`CouchSDK.init(...)` works from a <script> tag).
//
// The IIFE build runs second and must NOT wipe the ESM output, so it does not
// empty the shared dist dir. Type declarations are emitted afterwards by
// `tsc --emitDeclarationOnly` into dist/types.
const format = process.env.COUCH_SDK_FORMAT === 'iife' ? 'iife' : 'es';

export default defineConfig(
  format === 'iife'
    ? {
        build: {
          emptyOutDir: false,
          lib: {
            entry: resolve(__dirname, 'src/iife.ts'),
            name: 'CouchSDK',
            formats: ['iife'],
            fileName: () => 'couch-sdk.iife.js'
          },
          rollupOptions: { output: { exports: 'default' } },
          sourcemap: true,
          target: 'es2019'
        }
      }
    : {
        build: {
          emptyOutDir: true,
          lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: () => 'couch-sdk.js'
          },
          sourcemap: true,
          target: 'es2019'
        }
      }
);
