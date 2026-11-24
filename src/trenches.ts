// The traced German trench network (tools/trenches.py), split into fire trenches (running across the line of
// attack) and communication trenches (running back), plus centrelines styled for drawing: fire trenches with
// square fire bays, communication trenches narrower and zigzag.
import traced from '../data/trenches.json';
import { GEO, toXZ, resample, type P } from './geo';

export const FIRE = 0, COMM = 1;
export interface Run { kind: number; p: P[] }
type XZ = [number, number];

export const SHEETS: XZ[][] = Object.values(traced.sheets as unknown as Record<string, { corners: XZ[] }>).map(s => s.corners);
export function insideSheets(x: number, z: number) {
  for (const poly of SHEETS) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; }
    if (c) return true;
  }
  return false;
}

/** direction of the front (unit tangent along the British line) nearest a point */
const FRONT = resample(GEO.britishFront.map(toXZ), 100);
const TAN = FRONT.map((_, i) => {
  const a = FRONT[Math.max(0, i - 1)], b = FRONT[Math.min(FRONT.length - 1, i + 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / L, z: (b.z - a.z) / L };
});
export function frontTangent(x: number, z: number) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < FRONT.length; i++) { const d = (FRONT[i].x - x) ** 2 + (FRONT[i].z - z) ** 2; if (d < bd) { bd = d; best = i; } }
  return TAN[best];
}

let runs: Run[] | null = null;
/** the traced network as runs of one kind; a bend shorter than 15 m doesn't change the kind */
export function trenchRuns(): Run[] {
  if (runs) return runs;
  runs = [];
  for (const l of traced.lines as unknown as { p: XZ[] }[]) {
    const p = l.p.map(([x, z]) => ({ x, z }));
    if (p.length < 2) continue;
    const kinds: number[] = [], lens: number[] = [];
    for (let i = 1; i < p.length; i++) {
      const dx = p[i].x - p[i - 1].x, dz = p[i].z - p[i - 1].z, L = Math.hypot(dx, dz) || 1;
      const t = frontTangent((p[i].x + p[i - 1].x) / 2, (p[i].z + p[i - 1].z) / 2);
      kinds.push(Math.abs(dx * t.x + dz * t.z) / L > 0.72 ? FIRE : COMM); lens.push(L);
    }
    for (let i = 0; i < kinds.length; i++) if (lens[i] < 15) { const prev = kinds[i - 1], next = kinds[i + 1]; if (prev !== undefined && prev === next) kinds[i] = prev; }
    let cur: Run = { kind: kinds[0], p: [p[0]] };
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] !== cur.kind) { runs.push(cur); cur = { kind: kinds[i], p: [p[i]] }; }
      cur.p.push(p[i + 1]);
    }
    runs.push(cur);
  }
  return runs;
}

/** centreline to draw: fire trenches get 9 m fire bays behind 1.4 m traverses, communication trenches zigzag */
export function styled(r: Run): P[] {
  const fire = r.kind === FIRE, q = resample(r.p, fire ? 4.5 : 6);
  if (q.length < 3) return q;
  return q.map((s, i) => {
    if (i === 0 || i === q.length - 1) return s;
    const a = q[i - 1], b = q[i + 1], nx = -(b.z - a.z), nz = b.x - a.x, L = Math.hypot(nx, nz) || 1;
    const o = fire ? (Math.floor(i / 2) % 2 ? 1.4 : -1.4) : (i % 2 ? 1.5 : -1.5);
    return { x: s.x + nx / L * o, z: s.z + nz / L * o };
  });
}
