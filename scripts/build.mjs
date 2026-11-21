// Offline build: node scripts/build.mjs -> dist/index.html + dist/main.js
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), out = resolve(root, 'dist');
mkdirSync(out, { recursive: true });
await build({ entryPoints: [resolve(root, 'src/main.ts')], bundle: true, format: 'esm', target: 'es2020', minify: true, outfile: resolve(out, 'main.js'), logLevel: 'warning' });
writeFileSync(resolve(out, 'index.html'), readFileSync(resolve(root, 'index.html'), 'utf8').replace('/src/main.ts', './main.js'));
console.log('Built to dist/');
