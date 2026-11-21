// Battalions placed on their start positions from the order of battle and the division frontages.
import oob from '../data/oob_british.json';
import results from '../data/results.json';
import { GEO, pts, project, at, resample, type P } from './geo';

export interface Battalion {
  id: number; name: string; nick?: string; brigade: string; division: string; corps: string; army: string; type: string;
  involved: boolean; wave: 1 | 2 | 3;
  x: number; z: number; tx: number; tz: number; nx: number; nz: number; w: number; d: number;
  cas?: { officers: number; men: number; total: number };
}
export interface DivInfo { name: string; corps: string; commander: string; type: string; cas?: { casualties: number; killed: number; nightLine: string }; x: number; z: number; note?: string }
export interface CorpsInfo { name: string; commander: string; army: string; x: number; z: number; divisions: string[] }

const ABBR: Record<string, string> = { RIR: 'Royal Irish Rifles', NF: 'Northumberland Fusiliers', Innisk: 'Royal Inniskilling Fusiliers', RIrF: 'Royal Irish Fusiliers', 'Y&L': 'York and Lancaster', HLI: 'Highland Light Infantry' };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim();
function resultKey(name: string) {
  const m = /\(([^)]+)\)/.exec(name);
  let k = m && /^\d/.test(m[1]) ? m[1] : name.replace(/\s*\(.*\)/, '');
  for (const [a, b] of Object.entries(ABBR)) k = k.replace(new RegExp(`\\b${a.replace(/[&]/g, '\\&')}$`), b);
  return norm(k);
}

export function buildUnits() {
  const front = resample(pts(GEO.britishFront), 25), german = resample(pts(GEO.germanFront), 25);
  const casMap = new Map<string, { officers: number; men: number; total: number }>();
  for (const r of results.battalionsOver500) casMap.set(resultKey(r.battalion), { officers: r.officers, men: r.men, total: r.total });
  const divRes = new Map(results.divisions.map(d => [d.division.replace(/ \(.*/, ''), d]));

  // index the order of battle
  type Bde = { name: string; battalions: { name: string; nick?: string; involved: boolean }[]; division: string; corps: string; army: string; type: string };
  const brigades = new Map<string, Bde>();
  const divMeta = new Map<string, { corps: string; commander: string; type: string; army: string }>();
  const corpsMeta = new Map<string, { commander: string; army: string }>();
  for (const a of oob.armies) for (const c of a.corps) {
    corpsMeta.set(c.name, { commander: c.commander, army: a.name });
    for (const d of c.divisions as any[]) {
      divMeta.set(d.name, { corps: c.name, commander: d.commander, type: d.type, army: a.name });
      for (const b of d.brigades) brigades.set(b.name, { ...b, division: d.name, corps: c.name, army: a.name, type: d.type });
    }
  }

  const units: Battalion[] = [];
  const divs: DivInfo[] = [];
  const add = (bn: { name: string; nick?: string; involved: boolean }, bde: Bde, wave: 1 | 2 | 3, s: number, w: number, back: number) => {
    const p = at(front, s);
    // direction from a smoothed tangent, so blocks set back from a curving front do not cross
    const sm = Math.min(300, 60 + back * 0.6), pa = at(front, s - sm), pb = at(front, s + sm);
    let tx = pb.x - pa.x, tz = pb.z - pa.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    let nx = -tz, nz = tx;   // perpendicular; make it point away from the Germans
    const g = project(german, p);
    if ((g.x - p.x) * nx + (g.z - p.z) * nz > 0) { nx = -nx; nz = -nz; }
    units.push({
      id: units.length, name: bn.name, nick: bn.nick, brigade: bde.name, division: bde.division, corps: bde.corps, army: bde.army, type: bde.type,
      involved: bn.involved, wave, x: p.x + nx * back, z: p.z + nz * back, tx, tz, nx, nz, w, d: 70,
      cas: casMap.get(norm(bn.name)),
    });
  };

  for (const D of GEO.divisions) {
    const s0 = project(front, pts([D.from])[0]).s, s1 = project(front, pts([D.to])[0]).s;
    const a = Math.min(s0, s1), b = Math.max(s0, s1), span = b - a;
    const lead = D.lead.map(n => brigades.get(n)).filter(Boolean) as Bde[];
    const per = span / Math.max(1, lead.length);
    lead.forEach((bde, i) => {
      const bns = [...bde.battalions];
      const half = per / 2;
      bns.slice(0, 2).forEach((bn, k) => add(bn, bde, 1, a + i * per + half * (k + 0.5), half * 0.86, 45));
      bns.slice(2).forEach((bn, k) => add(bn, bde, 2, a + i * per + half * (k + 0.5), half * 0.86, 230));
      if (i === 0 && D.attached) for (const nm of D.attached) {
        for (const other of brigades.values()) {
          const f = other.battalions.find(x => x.name === nm);
          if (f) add(f, bde, 2, a + i * per + half * 0.5, half * 0.6, 420);
        }
      }
    });
    (D.support ?? []).forEach((n, j) => {
      const bde = brigades.get(n); if (!bde) return;
      const q = span / bde.battalions.length;
      bde.battalions.forEach((bn, k) => add(bn, bde, 3, a + q * (k + 0.5), q * 0.62, (D.supportDepth ?? 700) + j * 300));
    });
    const mid = at(front, (a + b) / 2), meta = divMeta.get(D.div)!;
    const short = D.div.replace(/ \(.*/, '').replace(' Division', '');
    const r = D.div.startsWith('17th') ? divRes.get('50th Brigade') : divRes.get(short);
    divs.push({ name: D.div, corps: meta.corps, commander: meta.commander, type: meta.type, x: mid.x, z: mid.z, note: D.note,
      cas: r ? { casualties: r.casualties, killed: r.killed, nightLine: r.nightLine } : undefined });
  }

  const corps: CorpsInfo[] = [];
  for (const [name, m] of corpsMeta) {
    const ds = divs.filter(d => d.corps === name);
    if (!ds.length) continue;
    corps.push({ name, commander: m.commander, army: m.army, divisions: ds.map(d => d.name),
      x: ds.reduce((s, d) => s + d.x, 0) / ds.length, z: ds.reduce((s, d) => s + d.z, 0) / ds.length });
  }
  return { units, divs, corps };
}
export type { P };
