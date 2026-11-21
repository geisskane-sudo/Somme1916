// Computes data/steer.json: factors applied to recorded losses so that each division's casualties,
// and each battalion's where the record gives one, match the record exactly. The simulation's own
// behaviour is unchanged; only the numbers shown are scaled. Run after any change to the simulation.
import { writeFileSync } from 'node:fs';
import { buildUnits } from '../src/units';
import { Battle } from '../src/battle';

const { units, divs } = buildUnits();
const b = new Battle(units, divs);
for (const c of b.strips) c.k = 1;
b.runAll();
const loss = (c: typeof b.strips[0]) => c.men0 - c.men;
/** factor k so that sum(min(loss_i * k, cap_i)) = target; returns [k, achieved] */
function solve(group: typeof b.strips, target: number): [number, number] {
  const f = (k: number) => group.reduce((a, c) => a + Math.min(loss(c) * k, 0.97 * c.men0), 0);
  if (target <= 0 || !group.length || f(1e6) <= 0) return [0, 0];
  let lo = 0, hi = 1; while (f(hi) < target && hi < 1e6) hi *= 2;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) < target) lo = m; else hi = m; }
  return [hi, f(hi)];
}
const out = { bn: {} as Record<string, number>, div: {} as Record<string, number> }, report: string[] = [];
for (const d of divs) {
  if (!d.cas || !b.divNames.includes(d.name)) continue;
  const ds = b.strips.filter(c => c.div === d.name);
  let rest = d.cas.casualties; const named = new Set<number>();
  for (const [bi, u] of units.entries()) {
    if (u.division !== d.name || !u.cas) continue;
    const g = ds.filter(c => c.bn === bi); if (!g.length) continue;
    const [k, got] = solve(g, u.cas.total); out.bn[u.name] = +k.toFixed(5); rest -= got; named.add(bi);
    if (Math.abs(got - u.cas.total) > 1) report.push(`  ${u.name}: record ${u.cas.total}, can reach ${Math.round(got)}`);
  }
  const g = ds.filter(c => !named.has(c.bn)), [k, got] = solve(g, rest); out.div[d.name] = +k.toFixed(5);
  const sim = ds.reduce((a, c) => a + loss(c), 0);
  report.push(`${d.name}: simulated ${Math.round(sim)} -> ${Math.round(d.cas.casualties - rest + got)} (record ${d.cas.casualties}), others ×${k.toFixed(2)}`);
}
writeFileSync(process.cwd() + '/data/steer.json', JSON.stringify(out, null, 1) + '\n');
console.log(report.join('\n'));
