// Headless run of the day: simulated vs recorded casualties and night positions per division.
import { buildUnits } from '../src/units';
import { Battle, K, ST, T1, short } from '../src/battle';
import results from '../data/results.json';

const args = process.argv.slice(2);
for (const a of args) { const [k, v] = a.split('='); if (k in K && v) (K as Record<string, number>)[k] = Number(v); }

const t0 = Date.now();
const { units, divs } = buildUnits();
const b = new Battle(units, divs);
const bombLog: string[] = [];
b.trace = tm => { if (tm % 60 !== 0 || tm < 480) return; const dv = process.env.DIV ?? ''; let m = 0, bs = 0; for (const c of b.strips) if (c.div === dv && (c.state === ST.hold || c.state === ST.mop)) { m += c.men; bs += c.bombs * c.men; } const cs = b.cells.filter(c => c.div === dv); bombLog.push(`${tm / 60}h bombs ${(bs / Math.max(1, m)).toFixed(2)} push ${(cs.reduce((a, c) => a + c.push, 0) / cs.length).toFixed(1)}`); };
const rec = b.runAll();
const ms = Date.now() - t0;

const hist = new Map<string, { casualties: number; nightLine: string }>();
for (const d of results.divisions as { division: string; casualties: number; nightLine: string }[]) hist.set(d.division, d);
const find = (name: string) => { const key = name.split(' ')[0]; for (const [k, v] of hist) if (k.split(' ')[0] === key || k.includes(`(${key} Div)`)) return v; return null; };

console.log(`cells ${b.cells.length}  sections ${b.secs.length}  strips ${b.strips.length}  ${ms} ms\n`);
console.log('division'.padEnd(18), 'sim'.padStart(6), 'hist'.padStart(6), ' ratio', ' held at night (m into German lines / frontage %)   historical');
let sumS = 0, sumH = 0, err = 0, n = 0;
for (const d of b.divNames) {
  const sim = Math.round(rec.divCas[(rec.minutes - 1) * b.divNames.length + b.divNames.indexOf(d)]); const h = find(d);
  const cells = b.cells.filter(c => c.div === d);
  if (!cells.length) continue;
  const held = cells.map(c => b.heldDepth(c.i, id => b.secs[id].owner));
  const share = held.filter(x => x >= 0).length / cells.length;
  const deep = Math.max(-1, ...held);
  const comps = b.strips.filter(c => c.div === d), inG = Math.round(comps.filter(c => c.state === ST.hold || c.state === ST.mop).reduce((a, c) => a + c.men, 0));
  const hc = h?.casualties ?? 0; sumS += sim; sumH += hc;
  if (hc) { err += Math.abs(Math.log(Math.max(1, sim) / hc)); n++; }
  console.log(short(d).padEnd(18), String(sim).padStart(6), String(hc).padStart(6), (hc ? (sim / hc).toFixed(2) : ' -  ').padStart(6),
    `  ${(share * 100).toFixed(0).padStart(3)}% held, deepest ${deep >= 0 ? Math.round(deep) + ' m' : '—'}, ${inG} men in`.padEnd(48), (h?.nightLine ?? '').slice(0, 70));
}
const fin = (T1 - 360) * 4;
console.log(`\nBritish ${Math.round(rec.cas[fin])} (hist 57,470), killed ${Math.round(rec.cas[fin + 1])} (hist 19,240); German ${Math.round(rec.cas[fin + 2])}, prisoners ${Math.round(rec.cas[fin + 3])}`);
console.log(`sum of listed divisions sim ${sumS} hist ${sumH}; mean |log ratio| ${(err / n).toFixed(2)}`);
console.log('\nevents:'); for (const e of b.events.slice(0, 60)) console.log(' ', `${String(Math.floor(e.t / 60)).padStart(2, '0')}:${String(Math.floor(e.t % 60)).padStart(2, '0')}`, e.text);
console.log('\nlosses by cause:'); for (const d of b.divNames) console.log(' ', short(d).padEnd(14), Object.entries(b.why[d]).filter(([k]) => !k.includes('@')).map(([k, v]) => `${k} ${Math.round(v)}`).join('  '));
// hourly casualties for a few divisions
const nD = b.divNames.length;
console.log('\nhourly cumulative:'); for (const d of b.divNames) { const k = b.divNames.indexOf(d); const row = [] as number[]; for (let h = 7; h <= 22; h += 1) row.push(Math.round(rec.divCas[((h * 60) - 360) * nD + k] ?? 0)); console.log(' ', short(d).padEnd(14), row.join(' ')); }
// state census at 08:30 for one division
const dd = process.env.DIV ?? '4th Division';
for (const tm of (process.env.TM ?? "460,480,510,600").split(",").map(Number)) { const m = tm - 360, cnt: Record<string, number> = {}; b.strips.forEach((c, i) => { if (c.div !== dd) return; const st = rec.state[m * rec.nStrip + i], d = rec.depth[m * rec.nStrip + i] / 4, w = b.cells[c.cell].w; const where = d <= 0 ? 'Brit' : d < w ? 'NML' : 'Ger'; const k = `${st}@${where}`; cnt[k] = (cnt[k] ?? 0) + rec.men[m * rec.nStrip + i]; }); console.log(tm, JSON.stringify(cnt)); }
{
  const cellsD = b.cells.filter(c => c.div === dd);
  console.log(`\n${dd}: cells holding each line, by hour (front/support/reserve/inter.../second)`);
  for (let h = 7.5; h <= 22.5; h += 0.5) {
    const m = Math.round(h * 60) - 360; const counts: number[] = [];
    for (const c of cellsD) c.secs.forEach((id, k) => { if (rec.owner[m * rec.nSec + id]) counts[k] = (counts[k] ?? 0) + 1; });
    let men = 0; b.strips.forEach((s, i) => { if (s.div === dd) { const st = rec.state[m * rec.nStrip + i]; if (st === ST.hold || st === ST.mop || st === ST.halted) men += rec.men[m * rec.nStrip + i]; } });
    console.log(`  ${String(Math.floor(h)).padStart(2)}:${h % 1 ? '30' : '00'}  ${Array.from(counts, x => String(x ?? 0).padStart(3)).join('')}   men ${men}`);
  }
}

console.log(`\n${dd} by cause/hour/place:`, Object.entries(b.why[dd]).filter(([k, v]) => k.includes('@') && v > 20).sort().map(([k, v]) => `${k} ${Math.round(v)}`).join('  '));

console.log(bombLog.join(' | '));
