import { buildUnits } from '../src/units';
import { Battle, ST_NAME, K } from '../src/battle';
for (const a of process.argv.slice(3)) { const [k, v] = a.split('='); (K as any)[k] = Number(v); }
import plan from '../data/plan.json';
if (process.env.NOLIFT) for (const d of Object.values(plan.divisions) as any[]) if (d.firstLift) d.firstLift = 0;
const { units, divs } = buildUnits(); const b = new Battle(units, divs);
const div = process.argv[2] ?? '4th Division';
const ids = b.strips.filter(c => c.div === div && c.start !== null).map(c => c.id);
const cellsWanted = (process.env.CELLS ?? "").split(",").filter(Boolean).map(Number);
const pick = cellsWanted.length ? cellsWanted.map(ci => ids.find(id => b.strips[id].cell === ci && b.strips[id].co === Number(process.env.CO ?? 0))).filter((x): x is number => x !== undefined) : [ids[0], ids[1], ids[Math.floor(ids.length / 2)]];
for (const id of pick) { const c = b.strips[id]; console.log('strip', id, units[c.bn].name, 'co', c.co, 'cell', c.cell, 'w', Math.round(b.cells[c.cell].w), 'start', c.start, 'men', c.men0.toFixed(0), 'depth', c.depth); }
b.stripWhy = {};
b.trace = t => { const hh = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; console.log(hh, pick.map(id => { const c = b.strips[id]; const s0 = b.secs[b.cells[c.cell].secs[0]]; return `${c.men.toFixed(0).padStart(4)} ${Math.round(c.depth).toString().padStart(5)} ${ST_NAME[c.state].slice(0, 12).padEnd(12)} r${c.rate.toFixed(3)} | F${s0.owner ? 'B' : (b.manning(s0) * s0.gar).toFixed(0)}`; }).join('   ')); };
const g = b.run(); let r = g.next(); while (!r.done) r = g.next();
for (const id of pick) console.log(id, JSON.stringify(b.stripWhy[id]));
