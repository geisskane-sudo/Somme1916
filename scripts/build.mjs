// Offline build: node scripts/build.mjs -> dist/index.html + dist/main.js
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), out = resolve(root, 'dist');
mkdirSync(out, { recursive: true });
// loss factors so the simulated casualties match the record (runs the whole day once, ~15 s)
if (!process.argv.includes('--no-steer')) {
  await build({ entryPoints: [resolve(root, 'tests/steer.ts')], bundle: true, platform: 'node', format: 'esm', outfile: '/tmp/somme-steer.mjs', logLevel: 'warning' });
  const { execFileSync } = await import('node:child_process');
  console.log(execFileSync('node', ['/tmp/somme-steer.mjs'], { encoding: 'utf8' }));
}
await build({ entryPoints: [resolve(root, 'src/main.ts')], bundle: true, format: 'esm', target: 'es2020', minify: true, outfile: resolve(out, 'main.js'), logLevel: 'warning' });
writeFileSync(resolve(out, 'index.html'), readFileSync(resolve(root, 'index.html'), 'utf8').replace('/src/main.ts', './main.js'));
copyFileSync(resolve(root, 'web/map1916.jpg'), resolve(out, 'map1916.jpg'));
copyFileSync(resolve(root, 'web/terrain.png'), resolve(out, 'terrain.png'));
mkdirSync(resolve(out, 'snd'), { recursive: true });
for (const f of ['boom1', 'boom2', 'boom3', 'guns_loop', 'incoming', 'mg_burst', 'smallarms']) copyFileSync(resolve(root, `web/snd/${f}.mp3`), resolve(out, `snd/${f}.mp3`));
console.log('Built to dist/');
