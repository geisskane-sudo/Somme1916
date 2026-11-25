// Single-file download: dist/ folded into one HTML file (scripts, map, terrain and sounds inlined as data URLs),
// so it opens by double-click with no server and no internet.  node scripts/offline.mjs → download/Somme1916.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), dist = resolve(root, 'dist');
const types = { png: 'image/png', jpg: 'image/jpeg', mp3: 'audio/mpeg' };
const files = ['map1916.jpg', 'terrain.png', ...['boom1', 'boom2', 'boom3', 'guns_loop', 'incoming', 'mg_burst', 'smallarms'].map(f => `snd/${f}.mp3`)];
const assets = Object.fromEntries(files.map(f => [f, `data:${types[f.split('.').pop()]};base64,${readFileSync(resolve(dist, f)).toString('base64')}`]));
const js = readFileSync(resolve(dist, 'main.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
let html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const tag = '<script type="module" src="./main.js"></script>';
if (!html.includes(tag)) throw new Error('script tag not found');
html = html.replace(tag, () => `<script>window.__ASSETS = ${JSON.stringify(assets)};</script>\n<script type="module">${js}</script>`);
mkdirSync(resolve(root, 'download'), { recursive: true });
writeFileSync(resolve(root, 'download/Somme1916.html'), html);
console.log('download/Somme1916.html', (html.length / 1e6).toFixed(1), 'MB');
