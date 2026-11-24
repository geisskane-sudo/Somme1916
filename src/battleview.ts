// Draws the recorded battle at any moment: company strips, captured German trenches, the line of
// furthest advance, and live figures for the panels.
import { Battle, ST, ST_NAME, CELL, T0 } from './battle';
import type { Renderer, Camera } from './render';
import type { Battalion } from './units';
import type { P } from './geo';

const COL: Record<number, [number, number, number, number]> = {
  [ST.wait]: [0.6, 0.16, 0.13, 0.85],
  [ST.advance]: [0.95, 0.22, 0.15, 0.97],
  [ST.halted]: [0.9, 0.4, 0.22, 0.95],
  [ST.assault]: [1.0, 0.62, 0.2, 1],
  [ST.hold]: [0.72, 0.07, 0.08, 0.97],
  [ST.mop]: [0.78, 0.1, 0.32, 0.97],
  [ST.pinned]: [0.58, 0.46, 0.38, 0.9],
  [ST.retire]: [0.98, 0.66, 0.36, 0.92],
  [ST.spent]: [0.45, 0.4, 0.36, 0.35],
  [ST.home]: [0.5, 0.22, 0.19, 0.6],
};
export const COMPANY = ['A', 'B', 'C', 'D'];

export class BattleView {
  private lastMinute = -1;
  /** per battalion: live centre (for labels), updated each minute */
  bnPos: { x: number; z: number; men: number }[];
  constructor(public b: Battle, private r: Renderer, private units: Battalion[]) {
    this.bnPos = units.map(u => ({ x: u.x, z: u.z, men: 0 }));
  }
  /** latest moment that has been simulated */
  get available() { return T0 + Math.max(0, this.b.done); }
  private idx(t: number) {
    const m = Math.max(0, Math.min(this.b.done, t - T0)), m0 = Math.floor(m), m1 = Math.min(this.b.done, m0 + 1);
    return { m0, m1, f: m - m0 };
  }
  stripAt(i: number, t: number) {
    const R = this.b.rec, n = R.nStrip, { m0, m1, f } = this.idx(t);
    const depth = (R.depth[m0 * n + i] * (1 - f) + R.depth[m1 * n + i] * f) / 4;
    const men = R.men[m0 * n + i] * (1 - f) + R.men[m1 * n + i] * f;
    return { depth, men, state: R.state[m0 * n + i] };
  }
  /** is there a British-held trench in this stretch within 35 m of depth? */
  heldNear(cell: number, depth: number, t: number) { for (const id of this.b.cells[cell].secs) if (Math.abs(this.b.secs[id].depth - depth) < 35 && this.owner(id, t)) return true; return false; }
  /** strips drawn as individual men instead of blocks */
  hide: Set<number> | null = null;
  owner(sec: number, t: number) { const { m0 } = this.idx(t); return this.b.rec.owner[m0 * this.b.rec.nSec + sec]; }
  totals(t: number) { const { m0, m1, f } = this.idx(t), c = this.b.rec.cas; const v = (k: number) => c[m0 * 4 + k] * (1 - f) + c[m1 * 4 + k] * f; return { b: v(0), bk: v(1), g: v(2), gp: v(3) }; }
  divCas(name: string, t: number) { const k = this.b.divNames.indexOf(name); if (k < 0) return null; const { m0, m1, f } = this.idx(t), n = this.b.divNames.length, d = this.b.rec.divCas; return d[m0 * n + k] * (1 - f) + d[m1 * n + k] * f; }

  /** queue this moment's shapes with the renderer */
  draw(t: number, cam: Camera) {
    const b = this.b, r = this.r;
    r.clearFlat();
    if (b.done < 0) return;
    const scale = Math.max(1, cam.dist / 3000);
    // companies
    for (const c of b.strips) {
      if (this.hide?.has(c.id)) continue;
      const { depth, men, state } = this.stripAt(c.id, t);
      if (men < 1 || state === ST.spent && cam.dist > 4000) continue;
      const w = b.world(c.s, depth), tx = w.az, tz = -w.ax;
      // thick blocks from afar, thin lines along the frontage up close so the ground shows
      const f = Math.min(1, Math.max(0, (cam.dist - 1200) / 4000)), sm = f * f * (3 - 2 * f);
      const half = c.len / 2 * 0.9, thick = (2 + 3 * Math.sqrt(men / 180)) * (1 - sm) + (5 + 14 * Math.sqrt(men / 180)) * scale * sm;
      const col = COL[state] ?? COL[ST.wait];
      r.flatQuad(w.x, w.z, tx * half, tz * half, w.ax * thick, w.az * thick, col[0], col[1], col[2], col[3], 4);
    }
    // stretches no division attacked were still held: a company in the front trench every 100 m
    for (const c of this.holding) {
      const w = b.world(c.s, -25), tx = w.az, tz = -w.ax;
      const f = Math.min(1, Math.max(0, (cam.dist - 1200) / 4000)), sm = f * f * (3 - 2 * f), thick = 3 * (1 - sm) + 9 * scale * sm;
      r.flatQuad(w.x, w.z, tx * 42, tz * 42, w.ax * thick, w.az * thick, 0.62, 0.3, 0.27, 0.85, 4);
    }
    // once a minute: the line of furthest advance and battalion label positions
    const { m0 } = this.idx(t);
    if (m0 !== this.lastMinute) { this.lastMinute = m0; this.minute(t); }
  }
  /** stretches of the British front with no attacking company: held by troops who stayed in the line */
  get holding() { return this._hold ??= this.b.cells.filter((c, i) => !this.b.strips.some(s => s.cell === i)); }
  private _hold: Battle['cells'] | undefined;
  private minute(t: number) {
    const b = this.b, n = b.cells.length, rec = b.rec, { m0 } = this.idx(t);
    // captured trenches: the traced trench lengths each held section stands for
    const paths = b.sectionPaths(), held: P[][] = [];
    for (const s of b.secs) if (this.owner(s.id, t)) held.push(...paths[s.id]);
    this.r.setCaptured(held);
    // the line of furthest advance: loosely joins the foremost British parties (companies beyond their own
    // front line, and trenches still held), smoothed so a single deep party doesn't make a spike
    const FWD = new Set<number>([ST.advance, ST.halted, ST.assault, ST.hold, ST.mop, ST.pinned]);
    const D = new Float32Array(n).fill(-1);
    const holds = new Uint8Array(n); for (const s of b.secs) if (this.owner(s.id, t)) holds[s.cell] = 1;
    for (const c of b.strips) {
      const { depth, men, state } = this.stripAt(c.id, t);
      // parties beyond the German front line count only where some trench there is in British hands
      if (men >= 4 && depth > 15 && FWD.has(state) && (depth < b.cells[c.cell].w - 10 || holds[c.cell])) D[c.cell] = Math.max(D[c.cell], depth);
    }
    for (const s of b.secs) if (this.owner(s.id, t)) D[s.cell] = Math.max(D[s.cell], s.depth + 10);
    for (let i = 1; i < n - 1; i++) if (D[i] < 0 && D[i - 1] >= 0 && D[i + 1] >= 0) D[i] = (D[i - 1] + D[i + 1]) / 2;   // bridge a one-stretch gap
    const runs: P[][] = [], front = new Float32Array(n).fill(-1);
    for (let i = 0; i < n;) {
      if (D[i] < 0) { i++; continue; }
      let j = i; while (j < n && D[j] >= 0) j++;
      // median of five, then a gentle smoothing of the ground positions
      const d: number[] = [];
      for (let k = i; k < j; k++) { const v: number[] = []; for (let q = Math.max(i, k - 2); q <= Math.min(j - 1, k + 2); q++) v.push(D[q]); v.sort((x, y) => x - y); d.push(v[v.length >> 1]); }
      const pts = d.map((dd, k) => b.world(b.cells[i + k].s, dd));
      const sm = pts.map((_, k) => { let x = 0, z = 0, w = 0; for (let q = -2; q <= 2; q++) { const p = pts[k + q]; if (!p) continue; const g = Math.exp(-q * q / 2.5); x += p.x * g; z += p.z * g; w += g; } return { x: x / w, z: z / w }; });
      d.forEach((dd, k) => (front[i + k] = dd));
      const a = b.world(b.cells[i].s - CELL * 0.6, 0), e = b.world(b.cells[j - 1].s + CELL * 0.6, 0);
      runs.push([{ x: a.x, z: a.z }, ...sm, { x: e.x, z: e.z }]);
      i = j;
    }
    this.r.setLive(0, runs, [0.95, 0.16, 0.1, 1], 4.5, 6);
    // Germans still holding trenches behind that line
    const pockets: P[][] = [];
    for (const s of b.secs) {
      const c = b.cells[s.cell];
      if (this.owner(s.id, t) || front[s.cell] < 0 || s.depth > front[s.cell] - 25 || s.depth < c.w - 5) continue;
      // only where the British are actually into the German position close by, not just lying out in front of it
      let near = false; for (let q = Math.max(0, s.cell - 2); q <= Math.min(n - 1, s.cell + 2); q++) if (holds[q]) near = true;
      if (!near) continue;
      if (rec.gar[m0 * rec.nSec + s.id] >= 2) pockets.push(...paths[s.id]);
    }
    this.r.setPockets(pockets);
    // German garrisons: every section still in German hands with men in it
    const gar: { p: P[]; men: number }[] = [];
    for (const s of b.secs) {
      if (this.owner(s.id, t)) continue;
      const men = rec.gar[m0 * rec.nSec + s.id]; if (men < 2) continue;
      for (const q of paths[s.id]) gar.push({ p: q, men });
    }
    this.r.setGarrison(gar);
    // battalion centres
    for (const p of this.bnPos) { p.x = 0; p.z = 0; p.men = 0; }
    for (const c of b.strips) {
      const { depth, men } = this.stripAt(c.id, t); if (men < 1) continue;
      const w = b.world(c.s, depth), p = this.bnPos[c.bn]; p.x += w.x * men; p.z += w.z * men; p.men += men;
    }
    this.bnPos.forEach((p, i) => { if (p.men > 0) { p.x /= p.men; p.z /= p.men; } else { p.x = this.units[i].x; p.z = this.units[i].z; } });
  }

  /** nearest company strip to a ground point, within slack metres */
  pick(x: number, z: number, t: number, slack: number) {
    let best = -1, bd = Infinity;
    for (const c of this.b.strips) {
      const { depth, men } = this.stripAt(c.id, t); if (men < 1) continue;
      const w = this.b.world(c.s, depth), dx = x - w.x, dz = z - w.z;
      const along = Math.abs(dx * w.az - dz * w.ax) - c.len / 2, across = Math.abs(dx * w.ax + dz * w.az) - 12;
      const d = Math.max(along, across); if (d < bd) { bd = d; best = c.id; }
    }
    return bd < slack ? best : -1;
  }
  /** the companies of a battalion at time t, merged across their strips */
  companies(bn: number, t: number) {
    const out = COMPANY.map((name, k) => ({ name, men: 0, men0: 0, states: new Map<number, number>(), depth: 0 }));
    for (const c of this.b.strips) {
      if (c.bn !== bn) continue;
      const s = this.stripAt(c.id, t), o = out[c.co];
      o.men += s.men; o.men0 += c.men0; o.states.set(s.state, (o.states.get(s.state) ?? 0) + s.men); o.depth = Math.max(o.depth, s.depth);
    }
    return out.filter(o => o.men0 > 0).map(o => {
      let st: number = ST.wait, best = -1; for (const [k, v] of o.states) if (v > best) { best = v; st = k; }
      return { ...o, state: st, stateName: ST_NAME[st] };
    });
  }
  stateName(st: number) { return ST_NAME[st]; }
}
