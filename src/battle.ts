// Company-level simulation of 1 July 1916 across the whole British front.
//
// The front is cut into 100 m cells along the British front line. Each cell has an attack axis
// (towards the German front line) and German trench sections at increasing depth: front, support,
// reserve, intermediate lines and the second position. Each British company is split into strips,
// one per cell of its frontage, which move along the cell's axis. German fire (rifles and machine
// guns, with long-range enfilade from strongpoints) falls on men in the open; German guns fall on
// no man's land and the British trenches. The barrage keeps the defenders below ground until it
// lifts; then they race to the parapet. Sections are taken by assault; dugouts left uncleared can
// come back to life behind the attackers; lodgements are bombed from the flanks and counter-attacked
// by German reserves; bombs run out unless no man's land can be crossed to bring more.
//
// The whole day is computed once and recorded every minute, so playback can run at any speed and
// be scrubbed back and forth.
import plan from '../data/plan.json';
import record from '../data/record.json';
import steer from '../data/steer.json';
import thiepval from '../data/thiepval.json';
import { GEO, pts, resample, project, at, toXZ, type P } from './geo';
import type { Battalion, DivInfo } from './units';

export const T0 = 360, ZERO = 450, T1 = 1350;
export const CELL = 100;
const DT = 1 / 3;

export const ST = { wait: 0, advance: 1, halted: 2, assault: 3, hold: 4, pinned: 5, retire: 6, spent: 7, home: 8, mop: 9 } as const;
export const ST_NAME = ['waiting in the trenches', 'advancing', 'waiting for the barrage to lift', 'assaulting a trench', 'holding a captured trench', 'pinned down in no man\'s land', 'falling back', 'broken up', 'back in the British lines', 'clearing dugouts'];

export interface Cell { /** German trench depths from a georeferenced 1:5000 sheet, where one covers this stretch */ traced?: number[]; i: number; s: number; bx: number; bz: number; ax: number; az: number; w: number; d2: number | null; corps: string; div: string | null; reg: number; secs: number[]; lastRevert: number; push: number }
export interface Section { id: number; cell: number; line: number; depth: number; kind: string; gar: number; gar0: number; mg: number; owner: 0 | 1; lift: number; tau: number; hidden: number; capturedAt: number; sp: string | null }
/** one company's strip in one cell */
export interface Strip {
  id: number; bn: number; co: number; div: string; s: number; len: number; cell: number; depth: number; men: number; men0: number;
  start: number | null; creepAt: number | null; creepDepth: number; state: number; bombs: number; mop: boolean; obj: number; sec: number;
  /** recent loss rate (fraction of men per minute) */
  rate: number;
  /** crawling forward from shell holes towards a captured trench */
  crawling: boolean;
  /** factor applied to this strip's losses when recorded, so totals match the record (data/steer.json) */
  k: number;
}
export interface BattleEvent { t: number; text: string; x: number; z: number; div?: string }
export interface Recording {
  minutes: number; nStrip: number; nSec: number;
  depth: Int16Array;   // ×4
  /** German men in each section per minute: manning the parapet, and in all */
  gm: Uint8Array; gar: Uint8Array;
  men: Uint8Array; state: Uint8Array; owner: Uint8Array;
  cas: Float32Array;   // per minute: British casualties, killed, German casualties, prisoners
  divCas: Float32Array; // per minute × division
}

type DivPlan = { wire: number; dugoutMin: number; firstLift?: number; finalLift: number; objective: number; smoke?: number[]; smokeSlows?: boolean; creepOut?: { at: number; toGap?: number; toNml?: number; brigades?: string[]; battalions?: string[] }; creeping?: number; brigades: Record<string, number | null>; battalions?: Record<string, number> };

// ---- tuning constants: global, the same everywhere on the front ----
export const K = {
  rifle: 0.3,       // hits per manned rifle per minute against standing men at point-blank
  mg: 17,           // hits per manned machine gun per minute at point-blank
  rifleRange: 200, mgRange: 650,
  satR: 40, satM: 400, // exposed men a rifle section / a machine gun can engage before fire is target-limited
  art: 0.006,       // fraction of men in no man's land hit per minute by German shellfire at full intensity
  artTrench: 0.0006,
  assaultB: 0.25,   // British hit per manning German per minute at the parapet
  assaultG: 0.25,   // Germans hit per attacker per minute
  clear: 0.04, counter: 0.006, bombUse: 0.01, resupply: 0.02,
  artHeld: 0.35,    // German shellfire on captured trenches, relative to no man's land
  speed: 50, retireSpeed: 40, pinnedExp: 0.0003,
  counterG: 4,    // German losses per British defender relative to K.counter
  rcap: 20,         // most German reserves that can press one 100 m stretch at once
  push: 30,         // minutes × superiority needed to retake a stretch
  crawl: 0.008,     // loss rate below which pinned men move forward into a captured trench
  rush: 1.8,        // men who crept out rush the last stretch
  supp: 0.08,       // a strip losing this fraction of its men per minute in the open goes to ground
};

export class Battle {
  cells: Cell[] = []; secs: Section[] = []; strips: Strip[] = []; events: BattleEvent[] = [];
  divNames: string[] = [];
  divPlan = new Map<string, DivPlan>();
  t = T0;
  cas = { b: 0, bk: 0, g: 0, gp: 0 };
  divCas: Record<string, number> = {};
  /** losses by cause, per division (diagnostics) */
  why: Record<string, Record<string, number>> = {};
  private cause = 'fire';
  private pool: { used: number; extra: number }[] = [];
  private regNames: string[];
  private mines: { t: number; x: number; z: number; r: number; done: boolean; name: string }[] = [];
  private milestones = new Set<string>();
  /** per cell: ground the record says is held, as keyframes {t, d} (d = deepest section depth held, -1 none); null = not steered */
  sched: ({ t: number; d: number }[] | null)[] = [];
  /** killed as a share of casualties, per division, from the record */
  private killedShare: Record<string, number> = {};
  private prevMen = new Map<number, number>();
  trace?: (t: number) => void;
  stripWhy?: Record<number, Record<string, number>>;
  private lossLog: Record<string, number[]> = {};
  private front = resample(pts(GEO.britishFront), 25);
  private german = resample(pts(GEO.germanFront), 25);
  private second = resample(pts(GEO.germanSecond), 25);

  constructor(units: Battalion[], divs: DivInfo[]) {
    for (const [k, v] of Object.entries(plan.divisions)) this.divPlan.set(k, v as DivPlan);
    this.divNames = divs.map(d => d.name).filter(n => this.divPlan.has(n));
    this.regNames = GEO.germanUnits.map(g => g.name);
    for (const n of this.divNames) { this.divCas[n] = 0; this.why[n] = {}; }
    this.buildCells(divs);
    this.buildSections();
    this.buildStrips(units);
    this.buildSchedule();
    for (const d of divs) this.killedShare[d.name] = d.cas && d.cas.casualties ? d.cas.killed / d.cas.casualties : 0.34;
    for (const m of GEO.mines) {
      const p = toXZ(m.ll), r = (plan.mineEffects as Record<string, number>)[m.name] ?? 40;
      this.mines.push({ t: Number(m.time.slice(0, 2)) * 60 + Number(m.time.slice(3, 5)), x: p.x, z: p.z, r, done: false, name: m.name });
    }
    this.pool = GEO.germanUnits.map((_, i) => ({ used: 0, extra: (plan.germanReserves.extra as Record<string, number>)[this.regNames[i]] ?? 0 }));
  }

  // ---------------- geometry ----------------
  private buildCells(divs: DivInfo[]) {
    let L = 0; for (let i = 1; i < this.front.length; i++) L += Math.hypot(this.front[i].x - this.front[i - 1].x, this.front[i].z - this.front[i - 1].z);
    const n = Math.round(L / CELL);
    const raw: { b: P; a: P; w: number }[] = [];
    for (let i = 0; i < n; i++) {
      const p = at(this.front, (i + 0.5) * CELL), g = project(this.german, p);
      const dx = g.x - p.x, dz = g.z - p.z, w = Math.hypot(dx, dz) || 1;
      raw.push({ b: { x: p.x, z: p.z }, a: { x: dx / w, z: dz / w }, w });
    }
    const ranges = GEO.divisions.map(D => {
      const a = project(this.front, toXZ(D.from)).s, b = project(this.front, toXZ(D.to)).s;
      return { div: D.div, a: Math.min(a, b), b: Math.max(a, b) };
    });
    const corpsOf = new Map(divs.map(d => [d.name, d.corps]));
    const regPts = GEO.germanUnits.map(g => toXZ(g.ll));
    for (let i = 0; i < n; i++) {
      let ax = 0, az = 0;
      for (let k = -3; k <= 3; k++) { const r = raw[Math.max(0, Math.min(n - 1, i + k))]; ax += r.a.x; az += r.a.z; }
      const l = Math.hypot(ax, az) || 1; ax /= l; az /= l;
      const { b, w } = raw[i], s = (i + 0.5) * CELL;
      const inDiv = ranges.find(r => s >= r.a && s <= r.b);
      const dist = (r: { a: number; b: number }) => (s < r.a ? r.a - s : s > r.b ? s - r.b : 0);
      const nearest = ranges.reduce((best, r) => (dist(r) < dist(best) ? r : best));
      const g = { x: b.x + ax * w, z: b.z + az * w };
      let reg = 0, rd = Infinity; regPts.forEach((q, k) => { const d = Math.hypot(q.x - g.x, q.z - g.z); if (d < rd) { rd = d; reg = k; } });
      let d2: number | null = null;
      for (let k = 1; k < this.second.length; k++) {
        const p1 = this.second[k - 1], p2 = this.second[k];
        const ex = p2.x - p1.x, ez = p2.z - p1.z, den = ax * ez - az * ex; if (Math.abs(den) < 1e-9) continue;
        const tt = ((p1.x - b.x) * ez - (p1.z - b.z) * ex) / den, u = ((p1.x - b.x) * az - (p1.z - b.z) * ax) / den;
        if (u >= 0 && u <= 1 && tt > w + 400 && tt < 5000 && (d2 === null || tt < d2)) d2 = tt;
      }
      const tr = tracedDepths(b.x, b.z, ax, az, w);
      this.cells.push({ traced: tr ?? undefined, i, s, bx: b.x, bz: b.z, ax, az, w: tr ? tr[0] : w, d2, corps: corpsOf.get(nearest.div) ?? 'X Corps', div: inDiv ? inDiv.div : null, reg, secs: [], lastRevert: -99, push: 0 });
    }
  }
  /** world position of a point at `depth` along the attack axis at arc length s */
  world(s: number, depth: number) {
    const f = Math.max(0, Math.min(this.cells.length - 1.001, s / CELL - 0.5)), i = Math.floor(f), u = f - i;
    const a = this.cells[i], b = this.cells[i + 1] ?? a;
    const bx = a.bx + (b.bx - a.bx) * u, bz = a.bz + (b.bz - a.bz) * u, ax = a.ax + (b.ax - a.ax) * u, az = a.az + (b.az - a.az) * u;
    const l = Math.hypot(ax, az) || 1;
    return { x: bx + ax / l * depth, z: bz + az / l * depth, ax: ax / l, az: az / l };
  }
  private planOf(c: Cell) {
    if (c.div) return this.divPlan.get(c.div)!;
    let best: DivPlan | null = null, bd = Infinity;
    for (const o of this.cells) if (o.div && Math.abs(o.i - c.i) < bd) { bd = Math.abs(o.i - c.i); best = this.divPlan.get(o.div)!; }
    return best!;
  }

  private buildSections() {
    const corps = plan.corps as Record<string, { gerArt: number; garrison: number }>;
    for (const c of this.cells) {
      const P = this.planOf(c), gf = corps[c.corps]?.garrison ?? 1;
      const T = c.traced, sup = T?.[1] ?? c.w + 140, res = T?.[2] ?? Math.max(sup + 120, c.w + 300);
      const lines: { d: number; kind: string; gar: number; mg: number }[] = [
        { d: c.w, kind: 'front', gar: 22, mg: 0.3 }, { d: sup, kind: 'support', gar: 14, mg: 0.1 }, { d: res, kind: 'reserve', gar: 12, mg: 0.1 },
      ];
      const end = c.d2 ?? c.w + 1800;
      for (let d = c.w + 800; d < end - 250; d += 500) lines.push({ d, kind: 'intermediate', gar: 6, mg: 0.05 });
      lines.push({ d: end, kind: 'second', gar: 14, mg: 0.15 }, { d: end + 150, kind: 'second support', gar: 8, mg: 0.05 });
      lines.forEach((L, k) => {
        let lift: number;
        const sched = (L.d - c.w) / Math.max(200, P.objective - c.w) * P.finalLift;
        if (P.creeping) lift = ZERO + Math.max(Math.max(0, L.d) / P.creeping, sched);
        else lift = k === 0 ? ZERO + (P.firstLift ?? 0) : ZERO + Math.max(3 * k, (L.d - c.w) / Math.max(200, P.objective - c.w) * P.finalLift);
        if (!c.div) lift = ZERO + (P.firstLift ?? 0);
        const id = this.secs.length;
        this.secs.push({ id, cell: c.i, line: k, depth: L.d, kind: L.kind, gar: L.gar * gf, gar0: L.gar * gf, mg: L.mg, owner: 0, lift, tau: k < 3 ? P.dugoutMin : 2, hidden: 0, capturedAt: -1, sp: null });
        c.secs.push(id);
      });
    }
    for (const sp of plan.strongpoints) {
      const p = toXZ(sp.ll as [number, number]);
      const near = this.secs.map(s => { const w = this.world(this.cells[s.cell].s, s.depth); return { s, d: Math.hypot(w.x - p.x, w.z - p.z) }; })
        .sort((a, b) => a.d - b.d).filter((o, k, arr) => o.d < 260 || o.d < arr[0].d + 150).slice(0, 4);
      for (const o of near) { o.s.mg += sp.mg / near.length; o.s.gar += 10; o.s.gar0 = o.s.gar; o.s.sp = sp.name; }
    }
  }

  // ---------------- the record: ground held through the day ----------------
  private buildSchedule() {
    const R = record.divisions as Record<string, { t: string; held: { from?: number; to?: number; near?: string; m?: number; line?: string; into?: number }[] }[]>;
    const spS = new Map(plan.strongpoints.map(sp => [sp.name, project(this.front, toXZ(sp.ll as [number, number])).s]));
    this.sched = this.cells.map(c => (c.div ? (R[c.div] ? [] : null) : []));
    for (const [div, kfs] of Object.entries(R)) {
      const cs = this.cells.filter(c => c.div === div); if (!cs.length) continue;
      const obj = this.divPlan.get(div)?.objective ?? 2000;
      for (const kf of kfs) {
        const t = Number(kf.t.slice(0, 2)) * 60 + Number(kf.t.slice(3, 5));
        cs.forEach((c, k) => {
          const f = cs.length > 1 ? k / (cs.length - 1) : 0.5;
          let d = -1;
          for (const h of kf.held) {
            const inside = h.near ? Math.abs(c.s - (spS.get(h.near) ?? -1e9)) <= (h.m ?? 300) / 2 + CELL / 2 : f >= (h.from ?? 0) - 1e-6 && f <= (h.to ?? 1) + 1e-6;
            if (!inside) continue;
            const secs = c.secs.map(id => this.secs[id]);
            const firstOf = (kind: string) => Math.min(Infinity, ...secs.filter(x => x.kind === kind).map(x => x.depth));
            const lim = h.into !== undefined ? c.w + h.into + 10 : h.line === 'front' ? c.w + 10 : h.line === 'support' ? c.w + 150 : h.line === 'reserve' ? c.w + 310
              : h.line === 'int' ? (isFinite(firstOf('intermediate')) ? firstOf('intermediate') : c.w + 310) + 10 : h.line === 'second' ? (c.d2 ?? c.w + 1800) + 160 : obj + 60;
            d = Math.max(d, ...secs.filter(x => x.depth <= lim).map(x => x.depth));
          }
          this.sched[c.i]!.push({ t, d });
        });
      }
    }
  }
  /** deepest section the record has held now (-1 none), the time that keyframe began, and the next keyframe */
  private schedAt(ci: number, t: number) {
    const S = this.sched[ci]; if (!S) return null;
    let now = -1, since = -Infinity, next: { t: number; d: number } | null = null;
    for (const k of S) { if (k.t <= t) { now = k.d; since = k.t; } else { next = k; break; } }
    return { now, since, next };
  }
  /** may this section be captured now? (steered cells: only up to what the record reaches by the next keyframe) */
  allowed(s: Section, t = this.t) { const L = this.limit(s.cell, t); return L === null || s.depth <= L; }
  /** deepest depth that may be held in a steered cell now: up to the next keyframe's gains, and shrinking ahead of a recorded loss */
  limit(ci: number, t: number) {
    const a = this.schedAt(ci, t); if (!a) return null;
    let lim = Math.max(a.now, a.next?.d ?? -1);
    if (a.next && a.next.d < a.now && t >= a.next.t - 20) lim = a.next.d + (a.now - a.next.d) * Math.max(0, (a.next.t - 2 - t) / 18);
    return lim;
  }
  /** is this section held in the record at this moment (so it cannot be lost)? */
  private locked(s: Section, t = this.t) { const a = this.schedAt(s.cell, t); return !!a && s.depth <= a.now; }

  private buildStrips(units: Battalion[]) {
    const n = this.cells.length;
    units.forEach((u, bi) => {
      const P = this.divPlan.get(u.division); if (!P) return;
      let st = P.brigades[u.brigade];
      if (P.battalions && u.name in P.battalions) st = P.battalions[u.name];
      const start = st === null || st === undefined || !u.involved ? null : ZERO + st + (u.wave === 2 ? 3 : 0);
      const co = P.creepOut, creeps = !!co && u.wave === 1 && ((co.brigades ?? []).includes(u.brigade) || (co.battalions ?? []).includes(u.name));
      const half = u.w / 2;
      for (let k = 0; k < 4; k++) {
        const s0 = u.s - half + (k % 2) * half, s1 = s0 + half;
        const c0 = Math.max(0, Math.floor(s0 / CELL)), c1 = Math.min(n - 1, Math.floor((s1 - 1e-6) / CELL));
        for (let ci = c0; ci <= c1; ci++) {
          const a = Math.max(s0, ci * CELL), b = Math.min(s1, (ci + 1) * CELL), len = b - a;
          if (len < 15) continue;
          const c = this.cells[ci], men = 180 * len / half;
          const depth = -u.back - (k >= 2 ? 45 : 0);
          const creepDepth = creeps ? (co!.toGap !== undefined ? c.w - co!.toGap : c.w * (co!.toNml ?? 0.3)) - (k >= 2 ? 40 : 0) : depth;
          this.strips.push({ id: this.strips.length, bn: bi, co: k, div: u.division, s: (a + b) / 2, len, cell: ci, depth, men, men0: men,
            start: start === null ? null : start + (k >= 2 ? 2 : 0), creepAt: creeps ? ZERO + co!.at : null, creepDepth,
            state: ST.wait, bombs: 1, mop: k >= 2, obj: P.objective, sec: -1, rate: 0, crawling: false, k: (steer.bn as Record<string, number>)[u.name] ?? (steer.div as Record<string, number>)[u.division] ?? 1 });
        }
      }
    });
  }

  // ---------------- helpers ----------------
  manning(s: Section, t = this.t) { if (s.owner) return 0; if (t < s.lift) return 0.05; const u = Math.min(1, (t - s.lift) / (s.tau * 1.2)); return 0.05 + 0.95 * u * u; }
  private vis(c: Cell, t: number) {
    let v = 1;
    const P = c.div ? this.divPlan.get(c.div) : null;
    if (P?.smoke && t >= ZERO + P.smoke[0] && t <= ZERO + P.smoke[1]) v = 0.35;
    if (t > 21 * 60 + 10) v *= Math.max(0.15, 1 - (t - (21 * 60 + 10)) / 30);
    return v;
  }
  gerArt(c: Cell, t: number) {
    const C = (plan.corps as Record<string, { gerArt: number; late?: number }>)[c.corps], A = C?.gerArt ?? 0.8, late = C?.late ?? 0.3;
    let f: number;
    if (t < ZERO - 6) f = 0.05; else if (t < ZERO + 4) f = 0.05 + 0.95 * (t - (ZERO - 6)) / 10; else if (t < ZERO + 120) f = 1;
    else if (t < ZERO + 300) f = Math.max(0.5, late); else f = late;
    return A * f;
  }
  private exposure(c: Strip, w: number) {
    switch (c.state) {
      case ST.advance: return c.crawling ? 0.1 : c.depth <= 0 ? 0.25 : c.depth > w + 20 ? 0.5 : c.depth > w - 45 ? 1.4 : 1;
      case ST.halted: return c.depth <= 0 ? 0 : c.sec >= 0 && this.secs[c.sec].owner && Math.abs(this.secs[c.sec].depth - c.depth) < 35 ? 0.012 : 0.2;
      case ST.assault: return 0.3;
      case ST.pinned: return K.pinnedExp;
      case ST.retire: return c.depth <= 0 ? 0.1 : this.t > 21 * 60 + 15 ? 0.08 : 0.8;
      case ST.hold: case ST.mop: return 0.012;
      case ST.wait: return c.creepAt !== null && this.t >= c.creepAt && c.depth > 0 ? 0.25 : 0;
      default: return 0;
    }
  }
  private alive(c: Strip) { return c.men > 0.5 && c.state !== ST.spent && c.state !== ST.home; }
  private inGerman(c: Strip) { return c.depth >= this.cells[c.cell].w - 20; }
  private target(c: Strip) {
    for (const id of this.cells[c.cell].secs) { const s = this.secs[id]; if (s.owner === 0 && s.depth > c.depth - 10) return s.depth <= c.obj + 200 ? s : null; }
    return null;
  }
  private heldAt(c: Strip) {
    for (const id of this.cells[c.cell].secs) { const s = this.secs[id]; if (s.owner && Math.abs(s.depth - c.depth) < 35) return s; }
    return null;
  }
  private heldBehind(cell: Cell, depth: number) {
    let best: Section | null = null;
    for (const id of cell.secs) { const s = this.secs[id]; if (s.depth >= depth - 5) break; if (s.owner) best = s; }
    return best;
  }
  private say(text: string, cell: Cell, depth: number, div?: string) { const w = this.world(cell.s, depth); this.events.push({ t: this.t, text, x: w.x, z: w.z, div }); }
  private hurt(c: Strip, h: number) { if (h <= 0) return; h = Math.min(c.men, h); c.men -= h; this.cas.b += h; this.cas.bk += h * 0.34; this.divCas[c.div] += h; const w = this.why[c.div]; w[this.cause] = (w[this.cause] ?? 0) + h; const kh = `${this.cause}@${Math.floor(this.t / 60)}${this.inGerman(c) ? 'G' : this.t > 0 && c.depth > 0 ? 'N' : 'B'}`; w[kh] = (w[kh] ?? 0) + h; if (this.stripWhy) { const o = (this.stripWhy[c.id] ??= {}); o[this.cause] = (o[this.cause] ?? 0) + h; } }

  // ---------------- one step ----------------
  step() {
    const t = this.t, dt = DT, cells = this.cells, secs = this.secs, strips = this.strips, n = cells.length;
    for (const m of this.mines) if (!m.done && t >= m.t) {
      m.done = true;
      for (const s of secs) { const w = this.world(cells[s.cell].s, s.depth); if (!s.owner && Math.hypot(w.x - m.x, w.z - m.z) < m.r) { const k = s.gar * 0.8; s.gar -= k; this.cas.g += k; s.mg *= 0.1; } }
      const c = cells.reduce((b, c) => (Math.hypot(c.bx - m.x, c.bz - m.z) < Math.hypot(b.bx - m.x, b.bz - m.z) ? c : b));
      this.say(`${m.name} mine fired`, c, c.w, c.div ?? undefined);
    }
    const byCell: Strip[][] = cells.map(() => []);
    const exposed: { c: Strip; e: number; em: number }[][] = cells.map(() => []);
    const exCount = new Int32Array(n + 1);
    for (const c of strips) if (this.alive(c)) {
      byCell[c.cell].push(c);
      const e = this.exposure(c, cells[c.cell].w); if (e > 0) exposed[c.cell].push({ c, e, em: c.state === ST.hold || c.state === ST.mop || c.state === ST.pinned ? e * 0.1 : e });
    }
    for (let i = 0; i < n; i++) exCount[i + 1] = exCount[i] + exposed[i].length;
    const hits = new Float32Array(strips.length), arth = new Float32Array(strips.length), nmlFire = new Float32Array(n);

    // German small-arms fire
    for (const cell of cells) {
      const reach = 10;
      const k0 = Math.max(0, cell.i - reach), k1 = Math.min(n - 1, cell.i + reach);
      if (exCount[k1 + 1] - exCount[k0] === 0) continue;
      const v = this.vis(cell, t);
      let front = Infinity; for (const id of cell.secs) if (!secs[id].owner) { front = secs[id].depth; break; }
      for (const id of cell.secs) {
        const s = secs[id];
        if (s.owner || s.depth > front + 500) continue;
        const m = this.manning(s, t);
        const rifles = s.depth - front < 150 ? s.gar * m : 0, mgs = t < s.lift ? 0 : s.mg * Math.min(1, m * 1.5) * (s.gar > 1 ? 1 : 0);
        if (rifles < 0.3 && mgs < 0.02) continue;
        const r = s.sp ? reach : 8;
        let sr = 0, sm = 0; const tg: { c: Strip; gr: number; gm: number }[] = [];
        for (let k = Math.max(0, cell.i - r); k <= Math.min(n - 1, cell.i + r); k++) {
          const lat = (k - cell.i) * CELL;
          for (const o of exposed[k]) {
            const d = Math.hypot(lat, s.depth - o.c.depth);
            const gr = Math.abs(k - cell.i) <= 3 ? Math.exp(-d / K.rifleRange) * o.e * o.c.men : 0;
            const gm = Math.exp(-d / K.mgRange) * o.em * o.c.men;
            if (gr + gm < 1e-3) continue;
            tg.push({ c: o.c, gr, gm }); sr += gr; sm += gm;
          }
        }
        if (!tg.length) continue;
        const Fr = rifles * K.rifle * v * dt, Fm = mgs * K.mg * v * dt;
        const nr = Fr / (sr + K.satR), nm = Fm / (sm + K.satM);
        for (const o of tg) {
          const h = nr * o.gr + nm * o.gm; hits[o.c.id] += h;
          const w = cells[o.c.cell].w; if (o.c.depth > 0 && o.c.depth < w) nmlFire[o.c.cell] += h / dt;
        }
      }
    }
    // German artillery
    for (const c of strips) {
      if (c.men <= 0.5 || c.state === ST.spent) continue;
      const cell = cells[c.cell], A = this.gerArt(cell, t);
      let r: number;
      if (c.depth > 0 && c.depth < cell.w - 10) r = K.art * (c.state === ST.pinned ? 0.05 : 1);
      else if (c.depth <= 0) r = K.artTrench * (c.depth > -300 ? 1 : 0.4);
      else r = t > ZERO + 60 ? K.art * K.artHeld : 0;
      arth[c.id] += c.men * r * A * dt;
    }
    this.cause = 'fire';
    for (const c of strips) if (hits[c.id] > 0) this.hurt(c, hits[c.id]);
    this.cause = 'art';
    for (const c of strips) if (arth[c.id] > 0) this.hurt(c, arth[c.id]);
    this.cause = 'assault';

    // assaults
    const atk = new Map<number, Strip[]>();
    for (const c of strips) if (c.state === ST.assault && c.sec >= 0 && this.alive(c)) { const a = atk.get(c.sec) ?? []; a.push(c); atk.set(c.sec, a); }
    for (const [sid, cs] of atk) {
      const s = secs[sid];
      if (s.owner) { for (const c of cs) c.state = ST.advance; continue; }
      const Nb = cs.reduce((a, c) => a + c.men, 0), m = this.manning(s, t);
      const Gm = s.gar * m, Gd = s.gar - Gm;
      const gl = Math.min(Gm, K.assaultG * Nb * dt);
      const bl = (K.assaultB * Gm + 4 * s.mg * Math.min(1, m * 1.5)) * dt;
      const cleared = Gm < 0.15 * Nb ? Math.min(Gd, K.clear * Nb * dt) : 0;
      s.gar -= gl + cleared; this.cas.g += gl + cleared; this.cas.gp += cleared * 0.6;
      for (const c of cs) { this.hurt(c, bl * c.men / Nb); c.bombs = Math.max(0, c.bombs - 0.004 * dt * (1 + Gm / 5)); }
      const Nb2 = cs.reduce((a, c) => a + c.men, 0), ok = this.allowed(s);
      if (!ok || (this.sched[s.cell] === null && Nb2 < 0.8 * s.gar * m)) { for (const c of cs) c.state = this.inGerman(c) ? ST.hold : ST.pinned; continue; }
      if (s.gar * m < Math.max(1.5, 0.06 * Nb)) {
        const left = s.gar * m; this.cas.g += left; this.cas.gp += left * 0.5;
        s.owner = 1; s.capturedAt = t; s.hidden = Math.max(0, s.gar - left); s.gar = 0;
        for (const c of cs) { c.state = ST.advance; c.sec = sid; c.rate = 0; }
        this.milestone(s);
      }
    }

    // loss rate (EMA over ~1 minute)
    for (const c of strips) { const l = (this.prevMen.get(c.id) ?? c.men) - c.men; const r = c.men > 0.5 ? l / (c.men + l) / dt : 0; c.rate += (r - c.rate) * Math.min(1, dt / 1); this.prevMen.set(c.id, c.men); }
    // strip decisions and movement
    const night = t > 21 * 60 + 20;
    for (const c of strips) {
      if (!this.alive(c)) continue;
      const cell = cells[c.cell], P = this.divPlan.get(c.div)!;
      if (c.men < 0.12 * c.men0 && !(c.men > 2 && ((this.inGerman(c) && (this.heldAt(c) || this.heldBehind(cell, c.depth))) || (this.sched[c.cell] !== null && this.limit(c.cell, t)! >= 0 && c.depth > -50)))) { c.state = this.inGerman(c) || c.depth > 0 ? ST.spent : ST.home; continue; }
      switch (c.state) {
        case ST.wait: {
          if (c.creepAt !== null && t >= c.creepAt && c.depth < c.creepDepth) c.depth = Math.min(c.creepDepth, c.depth + K.speed * 0.7 * dt);
          if (c.start !== null && t >= c.start) c.state = ST.advance;
          break;
        }
        case ST.advance: case ST.halted: {
          const tg0 = this.target(c), close = tg0 && t >= tg0.lift && tg0.depth - c.depth < 35;
          const pressOn = this.sched[c.cell] !== null && (tg0 ? this.allowed(tg0) : !!this.heldAt(c) || this.limit(c.cell, t)! >= 0);
          if (c.depth > 0 && !this.heldAt(c) && !close && !pressOn && (c.rate > 2 * K.supp || (c.rate > K.supp && c.men < 0.75 * c.men0))) {
            if (this.inGerman(c)) { const b = this.heldBehind(cell, c.depth); if (b) { c.depth = Math.max(b.depth, c.depth - K.retireSpeed * dt); if (c.depth - b.depth < 2) { c.state = ST.hold; c.sec = b.id; } else c.state = ST.advance; break; } }
            c.state = c.depth < 40 ? ST.retire : ST.pinned; break;
          }
          if (c.men < 0.4 * c.men0 && c.depth > 0) { const h = this.heldAt(c); if (h) { c.state = ST.hold; c.sec = h.id; } else if (!this.inGerman(c)) c.state = ST.pinned; else c.state = ST.hold; break; }
          if (c.mop) {
            const here = this.heldAt(c);
            if (here && here.hidden > 2) { c.state = ST.mop; c.sec = here.id; break; }
          }
          const tgt = this.target(c);
          let goal: number;
          if (!tgt) {
            const last = this.heldBehind(cell, c.obj + 400);
            goal = last ? last.depth : c.depth;
            if (Math.abs(c.depth - goal) < 6) { c.state = ST.hold; c.sec = last ? last.id : -1; c.crawling = false; break; }
          } else {
            goal = t < tgt.lift ? tgt.depth - 70 : tgt.depth;
            const here = this.heldAt(c);
            if (here && t < tgt.lift - Math.max(0, goal - c.depth) / K.speed - 0.5) { c.state = ST.halted; c.sec = here.id; break; }
            if (t >= tgt.lift && c.depth >= tgt.depth - 12) { c.state = ST.assault; c.sec = tgt.id; break; }
          }
          let v = K.speed;
          if (c.creepAt !== null && c.depth < cell.w) v *= K.rush;
          if (c.crawling) v *= 0.3;
          if (P.creeping && c.depth > 0) v = Math.min(v, P.creeping + 5);
          if (P.smokeSlows && P.smoke && t < ZERO + P.smoke[1]) v *= 0.6;
          if (c.depth > cell.w - 45 && c.depth < cell.w - 5) v *= 0.15 + 0.85 * P.wire;
          const d = goal - c.depth;
          if (Math.abs(d) < 2) { const h = this.heldAt(c); c.state = h ? ST.hold : ST.halted; if (h) c.sec = h.id; }
          else { c.depth += Math.sign(d) * Math.min(Math.abs(d), v * dt); c.state = ST.advance; }
          break;
        }
        case ST.assault: break;
        case ST.mop: {
          const s = secs[c.sec];
          if (!s.owner) { c.state = ST.advance; break; }
          const k = Math.min(s.hidden, K.clear * 1.5 * c.men * dt); s.hidden -= k; this.cas.g += k; this.cas.gp += k * 0.6;
          if (s.hidden < 1) { s.hidden = 0; c.state = ST.advance; }
          break;
        }
        case ST.hold: {
          const s = this.heldAt(c);
          if (!s) { const b = this.heldBehind(cell, c.depth); if (b) c.depth = Math.max(b.depth, c.depth - K.retireSpeed * dt); else c.state = ST.retire; }
          else c.sec = s.id;
          break;
        }
        case ST.pinned: {
          if (night) { c.state = ST.retire; break; }
          // men lying out work forward into a captured trench in their stretch when fire slackens
          const fr = secs[cell.secs[0]];
          if (fr.owner && c.rate < K.crawl && c.depth < fr.depth) {
            let deep = fr; for (const id of cell.secs) { const o = secs[id]; if (o.owner) deep = o; else break; }
            c.obj = deep.depth - 200; c.state = ST.advance; c.crawling = true;
          }
          break;
        }
        case ST.retire: {
          c.depth -= K.retireSpeed * dt;
          if (c.depth <= -40) { c.depth = -40; c.state = ST.home; }
          break;
        }
      }
    }

    // the record: trenches it says were taken by now are taken; ground it says was lost goes, deepest first
    for (const cell of cells) {
      const a = this.schedAt(cell.i, t); if (!a) continue;
      const lim = this.limit(cell.i, t)!;
      for (const id of cell.secs) {
        const s = secs[id];
        if (!s.owner && s.depth <= Math.min(a.now, lim) && t >= a.since + 8) {
          this.cas.g += s.gar * 0.3; this.cas.gp += s.gar * 0.1; s.owner = 1; s.capturedAt = t; s.gar = 0; s.hidden = 0; this.milestone(s);
          // men lying out or waiting in this stretch move up into it
          for (const c of strips) if (c.cell === cell.i && c.men > 1 && c.state !== ST.spent && c.depth < s.depth && (c.state === ST.pinned || c.state === ST.halted || (c.state === ST.home && c.men > 0.25 * c.men0) || (c.state === ST.wait && c.start !== null && t >= c.start))) { c.state = ST.advance; c.rate = 0; c.obj = a.now - 200; c.crawling = c.depth > 0; }
        }
      }
      // a stretch the record holds but nobody is in: men from this stretch go forward to it
      if (a.now >= 0 && t >= a.since + 8 && Math.floor(t / 10) !== Math.floor((t - dt) / 10) && !byCell[cell.i].some(c => this.inGerman(c))) {
        const held = cell.secs.map(id => secs[id]).filter(x => x.owner).pop();
        if (held) for (const c of strips) if (c.cell === cell.i && c.men > 2 && c.depth < held.depth && (c.state !== ST.wait || (c.start !== null && t >= c.start)) && c.state !== ST.advance) { c.state = ST.advance; c.rate = 0; c.obj = held.depth - 200; c.crawling = c.depth > 0; }
      }
      if (t - cell.lastRevert >= 0.5) {
        let deep: Section | null = null; for (const id of cell.secs) if (secs[id].owner && secs[id].depth > lim + 1) deep = secs[id];
        if (deep) { this.revert(deep, 6, 'record'); cell.lastRevert = t; }
      }
    }
    // lodgements: dugouts, bombing fights, counter-attacks, resupply
    this.cause = 'counter';
    const lodged: number[] = [];
    for (const cell of cells) if (cell.secs.some(id => secs[id].owner)) lodged.push(cell.i);
    const regLodged = new Map<number, number>();
    for (const i of lodged) regLodged.set(cells[i].reg, (regLodged.get(cells[i].reg) ?? 0) + 1);
    const Hcell = new Float32Array(n);
    for (const i of lodged) for (const c of byCell[i]) if (this.alive(c) && this.inGerman(c) && c.state !== ST.retire) Hcell[i] += c.men;
    for (const i of lodged) {
      const cell = cells[i];
      const B = byCell[i].filter(c => this.alive(c) && this.inGerman(c) && c.state !== ST.retire);
      const H = Hcell[i], Hn = H + 0.5 * ((Hcell[i - 1] ?? 0) + (Hcell[i + 1] ?? 0));
      const owned = cell.secs.map(id => secs[id]).filter(s => s.owner);
      const deepest = owned[owned.length - 1];
      // dugout garrisons left uncleared come up behind the attackers
      for (const s of owned) {
        if (s.hidden <= 3 || t - s.capturedAt < 6) continue;
        const near = B.filter(c => Math.abs(c.depth - s.depth) < 35).reduce((a, c) => a + c.men, 0);
        const mopping = B.some(c => c.state === ST.mop && c.sec === s.id);
        if (!mopping && near < 0.8 * s.hidden) { this.revert(s, s.hidden, 'dugouts'); }
      }
      if (!deepest.owner) continue;
      if (H < 1) { if (t - cell.lastRevert > 4) { this.revert(deepest, 3, 'abandoned'); cell.lastRevert = t; } continue; }
      if (t < ZERO + 20) continue;
      // pressure: neighbouring German-held trench at the same depth bombs along the trench; the next line counter-attacks
      let Pn = 0; const srcs: Section[] = [];
      for (const k of [i - 1, i + 1]) {
        const nc = cells[k]; if (!nc) continue;
        let best: Section | null = null;
        for (const id of nc.secs) { const o = secs[id]; if (!o.owner && Math.abs(o.depth - deepest.depth) < 120) { best = o; break; } }
        if (best) { Pn += best.gar * this.manning(best, t) * 0.3; srcs.push(best); }
      }
      const ahead = cell.secs.map(id => secs[id]).find(o => !o.owner && o.depth > deepest.depth);
      if (ahead && ahead.depth - deepest.depth < 400) { Pn += ahead.gar * this.manning(ahead, t) * 0.2; srcs.push(ahead); }
      const pool = this.reserveAvailable(cell.reg, t), R = Math.min(K.rcap, pool / Math.max(1, regLodged.get(cell.reg) ?? 1));
      const Pt = Pn + R;
      const bombs = B.reduce((a, c) => a + c.bombs * c.men, 0) / H;
      if (Pt > 0.3) {
        const armed = bombs > 0.08;
        const bl = K.counter * Pt * (armed ? 1 : 2.5) * dt * H / Math.max(1, Hn);
        const gl = Math.min(0.08 * Pt, K.counter * Hn * K.counterG * (armed ? 1 : 0.3)) * dt;
        for (const c of B) { this.hurt(c, bl * c.men / H); c.bombs = Math.max(0, c.bombs - K.bombUse * Math.min(3, Pt / 8) * dt); }
        const fromR = Math.min(R, gl * R / Pt); this.pool[cell.reg].used += fromR;
        for (const o of srcs) o.gar = Math.max(0, o.gar - (gl - fromR) / srcs.length);
        this.cas.g += gl;
        // the Germans retake a stretch only by sustained superiority (bombs gone: much sooner)
        const adv = Pt / Hn - (armed ? 1 : 0.3);
        cell.push = Math.max(0, cell.push + (adv > 0 ? adv : 0.5 * adv) * dt);
        if (Hn < 4 || cell.push > K.push) {
          if (t - cell.lastRevert > 3) {
            cell.push = 0;
            // the men who retake the trench come from the attackers: reserves first, then the neighbouring garrisons
            let want = Math.max(4, Pt * 0.5); const fromRes = Math.min(want * R / Pt, R); this.pool[cell.reg].used += fromRes; want -= fromRes;
            let got = fromRes;
            for (const o of srcs) { const k = Math.min(o.gar * 0.5, want / srcs.length); o.gar -= k; got += k; }
            this.revert(deepest, Math.max(2, got), 'counter'); cell.lastRevert = t;
          }
        }
      }
      // bombs and ammunition carried across no man's land
      const ga = this.gerArt(cell, t) * 6, pass = 1 / (1 + nmlFire[i] / 2 + ga * ga);
      for (const c of B) c.bombs = Math.min(1, c.bombs + K.resupply * pass * dt);
    }
    for (const c of strips) this.prevMen.set(c.id, c.men);
    this.t += dt;
  }

  private reserveAvailable(reg: number, t: number) {
    const R = plan.germanReserves, p = this.pool[reg];
    let a = 0;
    if (t >= ZERO + R.localFrom) a += R.local * Math.min(1, (t - ZERO - R.localFrom) / 60);
    const f = Math.max(0, Math.min(1, (t - (ZERO + R.laterFrom)) / (R.laterTo - R.laterFrom)));
    a += (R.later + p.extra) * f;
    return Math.max(0, a - p.used);
  }
  private revert(s: Section, gar: number, why: string) {
    if (why !== 'record' && this.locked(s)) return;
    s.owner = 0; s.gar = gar; s.hidden = 0; s.lift = Math.min(s.lift, this.t - s.tau);
    const cell = this.cells[s.cell]; if (!cell.div) return;
    const wd = this.why[cell.div]; if (wd) { const kk = `revert-${why}@${Math.floor(this.t / 60)}`; wd[kk] = (wd[kk] ?? 0) + 1; }
    const key = `${cell.div}:${why}`, arr = (this.lossLog[key] ??= []);
    arr.push(this.t);
    const recent = arr.filter(x => this.t - x < 30).length;
    if (recent === 4 && !arr.some(x => this.t - x >= 30 && this.t - x < 90))
      this.say(`${short(cell.div)}: ${why === 'dugouts' ? 'Germans emerge from uncleared dugouts behind the attackers' : why === 'counter' || why === 'record' ? 'German bombing parties and counter-attacks retake captured trench' : 'captured trench given up'}${s.sp ? ` near ${s.sp}` : ''}`, cell, s.depth, cell.div);
  }
  private milestone(s: Section) {
    const cell = this.cells[s.cell]; if (!cell.div) return;
    const key = `${cell.div}:${s.kind}`; if (this.milestones.has(key)) return; this.milestones.add(key);
    const what: Record<string, string> = { front: 'breaks into the German front line', support: 'takes part of the German support trench', reserve: 'reaches the German reserve trench', intermediate: 'pushes on beyond the German front system', second: 'reaches the German second position' };
    if (what[s.kind]) this.say(`${short(cell.div)} ${what[s.kind]}${s.sp ? ` at ${s.sp}` : ''}`, cell, s.depth, cell.div);
  }

  /** recording of the day, filled minute by minute by advance() */
  rec!: Recording;
  /** last minute recorded (minutes after T0) */
  done = -1;
  begin() {
    const minutes = T1 - T0 + 1, nC = this.strips.length, nS = this.secs.length, nD = this.divNames.length;
    this.rec = { minutes, nStrip: nC, nSec: nS, depth: new Int16Array(minutes * nC), men: new Uint8Array(minutes * nC), state: new Uint8Array(minutes * nC), owner: new Uint8Array(minutes * nS), gm: new Uint8Array(minutes * nS), gar: new Uint8Array(minutes * nS), cas: new Float32Array(minutes * 4), divCas: new Float32Array(minutes * nD) };
    this.done = -1;
    this.recordMinute();
  }
  private recordMinute() {
    const rec = this.rec, m = ++this.done, nC = rec.nStrip, nS = rec.nSec, nD = this.divNames.length;
    const dv: Record<string, number> = {}; let tot = 0, killed = 0;
    for (let i = 0; i < nC; i++) {
      const c = this.strips[i], loss = Math.min(0.97 * c.men0, (c.men0 - c.men) * c.k);
      rec.depth[m * nC + i] = Math.round(c.depth * 4); rec.men[m * nC + i] = Math.round(Math.min(255, c.men0 - loss)); rec.state[m * nC + i] = c.state;
      dv[c.div] = (dv[c.div] ?? 0) + loss; tot += loss; killed += loss * (this.killedShare[c.div] ?? 0.34);
    }
    for (let i = 0; i < nS; i++) { const x = this.secs[i]; rec.owner[m * nS + i] = x.owner; rec.gar[m * nS + i] = Math.min(255, Math.round(x.gar)); rec.gm[m * nS + i] = Math.min(255, Math.round(x.gar * this.manning(x, this.t))); }
    rec.cas.set([tot, killed, this.cas.g, this.cas.gp], m * 4);
    this.divNames.forEach((d, k) => (rec.divCas[m * nD + k] = dv[d] ?? 0));
  }
  /** simulate and record further minutes for up to `ms` milliseconds; returns true when the day is complete */
  advance(ms: number) {
    const end = performance.now() + ms;
    while (this.done < this.rec.minutes - 1) {
      if (this.trace) this.trace(this.done + T0);
      for (let k = 0; k < 3; k++) this.step();
      this.recordMinute();
      if (performance.now() > end) break;
    }
    return this.done >= this.rec.minutes - 1;
  }
  /** run the whole day at once */
  runAll() { this.begin(); while (!this.advance(1e9)); return this.rec; }

  /** depth into the German position held at the given moment, per cell (-1 = nothing) */
  heldDepth(cellIndex: number, owner: (sid: number) => number) {
    const c = this.cells[cellIndex]; let d = -1;
    for (const id of c.secs) if (owner(id)) d = this.secs[id].depth - c.w;
    return d;
  }
}
export const short = (d: string) => d.replace(/ \(.*?\)/, '').replace(' Division', ' Div');

// ---------------- traced trenches (Thiepval sheet) ----------------
type XZ = [number, number];
const TF = thiepval.front as XZ[], TT = thiepval.trenches as XZ[][], TC = thiepval.corners as XZ[];
function inside(x: number, z: number, poly: XZ[]) {
  let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c;
}
/** distances along a ray to every crossing of a polyline */
function crossings(bx: number, bz: number, ax: number, az: number, P: XZ[], out: number[]) {
  for (let k = 1; k < P.length; k++) {
    const [x1, z1] = P[k - 1], [x2, z2] = P[k], ex = x2 - x1, ez = z2 - z1, den = ax * ez - az * ex; if (Math.abs(den) < 1e-9) continue;
    const t = ((x1 - bx) * ez - (z1 - bz) * ex) / den, u = ((x1 - bx) * az - (z1 - bz) * ax) / den;
    if (u >= 0 && u <= 1 && t > 0) out.push(t);
  }
}
/** [front, support?, reserve?] depths for a stretch whose German front lies on the sheet, else null */
function tracedDepths(bx: number, bz: number, ax: number, az: number, w: number): number[] | null {
  if (!inside(bx + ax * w, bz + az * w, TC)) return null;
  const f: number[] = []; crossings(bx, bz, ax, az, TF, f);
  const front = f.filter(d => Math.abs(d - w) < 180 && d > 150).sort((a, b) => Math.abs(a - w) - Math.abs(b - w))[0];
  if (front === undefined) return null;
  const all: number[] = []; for (const P of TT) crossings(bx, bz, ax, az, P, all);
  all.sort((a, b) => a - b);
  const out = [front];
  const sup = all.find(d => d > front + 50 && d < front + 260); if (sup !== undefined) out.push(sup);
  const res = all.find(d => d > (sup ?? front + 140) + 60 && d < (sup ?? front + 140) + 320); if (sup !== undefined && res !== undefined) out.push(res);
  return out;
}
