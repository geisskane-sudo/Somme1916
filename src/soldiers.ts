// Individual soldiers acting out the recorded battle near the camera. Nothing here changes the
// outcome: every man belongs to a recorded company or German trench garrison, and the number standing
// is always the recorded number. Each man has a fixed place in his company's order of loss, so he
// falls at the moment the recorded strength drops past him and lies where he fell; scrubbing the
// timeline always shows the same picture.
import { Battle, ST, CELL, T0 } from './battle';
import type { BattleView } from './battleview';
import { Renderer, FIG, type Camera } from './render';
import type { Dem } from './geo';

const KHAKI = [0.47, 0.42, 0.29], FELDGRAU = [0.42, 0.45, 0.4];
const hash = (a: number, b: number) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const IN_TRENCH = new Set<number>([ST.wait, ST.hold, ST.mop, ST.home]);

interface Losses { done: number; n0: number; rank: Int16Array; death: Float32Array }

export class Soldiers {
  private loss = new Map<number, Losses>();
  private gerLoss = new Map<number, { done: number; cum: Float32Array }>();
  /** strips currently drawn as men (their blocks are hidden) */
  shown = new Set<number>();
  count = 0;
  constructor(private b: Battle, private bv: BattleView, private r: Renderer, private dem: Dem) {}

  /** recorded men of a strip at minute m */
  private men(i: number, m: number) { return this.b.rec.men[m * this.b.rec.nStrip + i]; }
  private losses(i: number): Losses {
    let L = this.loss.get(i);
    const done = this.b.done;
    if (L && (L.done === done || L.done >= this.b.rec.minutes - 1)) return L;
    const n0 = this.men(i, 0), rank = new Int16Array(n0), death = new Float32Array(n0).fill(Infinity);
    for (let j = 0; j < n0; j++) rank[j] = j;
    for (let j = n0 - 1; j > 0; j--) { const k = Math.floor(hash(i, j) * (j + 1)); const t = rank[j]; rank[j] = rank[k]; rank[k] = t; }
    let level = n0 - 1, prev = n0;
    for (let m = 0; m <= done && level >= 0; m++) {
      const v = this.men(i, m);
      while (level >= 0 && v <= level) { death[level] = m > 0 ? m - 1 + (prev - level) / Math.max(1e-6, prev - v) : 0; level--; }
      prev = v;
    }
    L = { done, n0, rank, death }; this.loss.set(i, L); return L;
  }
  /** cumulative Germans killed in a section while it was German (and some at its capture), by minute */
  private gerDead(sid: number) {
    let G = this.gerLoss.get(sid); const done = this.b.done, R = this.b.rec, nS = R.nSec;
    if (G && G.done === done) return G.cum;
    const cum = new Float32Array(R.minutes); let c = 0;
    for (let m = 1; m <= done; m++) {
      const o0 = R.owner[(m - 1) * nS + sid], o1 = R.owner[m * nS + sid], g0 = R.gar[(m - 1) * nS + sid], g1 = R.gar[m * nS + sid];
      if (!o0 && !o1) c += Math.max(0, g0 - g1); else if (!o0 && o1) c += g0 * 0.3;
      cum[m] = c;
    }
    G = { done, cum }; this.gerLoss.set(sid, G); return cum;
  }

  /** where man j of strip c stands (or lay) at time t */
  private place(c: Battle['strips'][0], j: number, n0: number, t: number) {
    const st = this.bv.stripAt(c.id, t), h1 = hash(c.id, j * 3 + 1), h2 = hash(c.id, j * 3 + 2);
    let along = ((j + 0.5) / n0 - 0.5) * c.len * 0.92 + (h1 - 0.5) * 2.5, across = (h2 - 0.5) * 2, pose: number = FIG.walk, back = false, y = 0;
    const row = j % 3;
    switch (st.state) {
      case ST.wait: case ST.home: pose = FIG.stand; y = -1.25; across = (h2 - 0.5) * 1.2 - (st.state === ST.wait ? (j % 2) * 3 : 0); break;
      case ST.hold: case ST.mop: pose = FIG.kneel; y = -0.85; across = (h2 - 0.5) * 1.2; break;
      case ST.advance: across = -row * 18 + (h2 - 0.5) * 4; if (st.depth <= 0) { pose = FIG.walk; } break;
      case ST.assault: pose = FIG.run; across = -row * 5 + (h2 - 0.5) * 3; break;
      case ST.halted: pose = FIG.prone; across = -row * 10 + (h2 - 0.5) * 4; break;
      case ST.pinned: case ST.spent: pose = FIG.prone; across = (h2 - 0.5) * 40; along += (h1 - 0.5) * 8; break;
      case ST.retire: pose = FIG.walk; back = true; across = (h2 - 0.5) * 30; break;
    }
    if (IN_TRENCH.has(st.state) && st.depth > 0 && !this.bv.heldNear(c.cell, st.depth, t)) y = 0;
    const w = this.b.world(c.s + along, st.depth + across);
    let yaw = Math.atan2(w.ax, w.az); if (back) yaw += Math.PI;
    return { x: w.x, z: w.z, y: this.dem.height(w.x, w.z) + y, yaw, pose, state: st.state };
  }

  /** fill the renderer with this moment's men; anim is a clock in seconds for leg movement */
  update(t: number, cam: Camera, anim: number, playing: boolean) {
    const r = this.r, b = this.b; r.clearFigs(); this.shown.clear(); this.count = 0;
    if (b.done < 0 || cam.dist > 2200) return;
    const R = Math.max(250, Math.min(1300, cam.dist * 0.95)), cx = cam.tx, cz = cam.tz, R2 = R * R;
    const sc = Math.max(1, Math.min(5, cam.dist / 115)), budget = 14000;
    const near = (x: number, z: number) => (x - cx) * (x - cx) + (z - cz) * (z - cz) < R2;
    const tm = t - T0;
    const flashes: number[] = [];
    // British companies
    for (const c of b.strips) {
      const p0 = b.world(c.s, this.bv.stripAt(c.id, t).depth); if (!near(p0.x, p0.z)) continue;
      const L = this.losses(c.id); if (!L.n0) continue;
      this.shown.add(c.id);
      const alive = this.bv.stripAt(c.id, t).men;
      for (let j = 0; j < L.n0 && this.count < budget; j++) {
        const rk = L.rank[j], dt = L.death[rk];
        if (rk < alive - 0.5 || dt > tm) {
          const P = this.place(c, j, L.n0, t);
          r.fig(P.pose, P.x, P.y, P.z, P.yaw, anim * (P.pose === FIG.run ? 9 : 6) + hash(c.id, j) * 6.3, sc, KHAKI[0] + (hash(j, 7) - 0.5) * 0.05, KHAKI[1], KHAKI[2]);
          this.count++;
          if (playing && (P.state === ST.hold || P.state === ST.assault) && Math.random() < 0.004) flashes.push(P.x, P.y + 1.4 * sc, P.z);
        } else {
          const P = this.place(c, j, L.n0, T0 + dt);
          r.fig(FIG.dead, P.x, this.dem.height(P.x, P.z) + (P.y < this.dem.height(P.x, P.z) - 0.3 ? -1.1 : 0), P.z, P.yaw + hash(j, 3) * 2, 0, sc, KHAKI[0] * 0.85, KHAKI[1] * 0.85, KHAKI[2] * 0.85);
          this.count++;
        }
      }
    }
    // German garrisons
    const m0 = Math.max(0, Math.min(b.done, Math.floor(tm))), Rr = b.rec, nS = Rr.nSec;
    const britishNear = (cell: number) => { for (let k = Math.max(0, cell - 6); k <= Math.min(b.cells.length - 1, cell + 6); k++) for (const id of this.cellStrips(k)) { const s = this.bv.stripAt(id, t).state; if (s === ST.advance || s === ST.assault || s === ST.halted) return true; } return false; };
    for (const s of b.secs) {
      const c = b.cells[s.cell], w = b.world(c.s, s.depth); if (!near(w.x, w.z)) continue;
      const own = Rr.owner[m0 * nS + s.id], gm = Rr.gm[m0 * nS + s.id];
      const tx = w.az, tz = -w.ax, yaw = Math.atan2(-w.ax, -w.az);
      if (!own) {
        const firing = playing && gm > 0 && britishNear(s.cell);
        for (let k = 0; k < gm && this.count < budget; k++) {
          const u = ((k + 0.5) / Math.max(gm, 6) - 0.5) * CELL * 0.92 + (hash(s.id, k) - 0.5) * 3;
          const x = w.x + tx * u + w.ax * (hash(k, s.id) - 0.5), z = w.z + tz * u + w.az * (hash(k, s.id) - 0.5);
          r.fig(FIG.kneel, x, this.dem.height(x, z) - 0.85, z, yaw, 0, sc, FELDGRAU[0], FELDGRAU[1], FELDGRAU[2]); this.count++;
          if (firing && Math.random() < 0.006) flashes.push(x, this.dem.height(x, z) + 0.6 * sc, z);
        }
        const guns = Math.round(s.mg);
        if (gm > 2) for (let k = 0; k < guns; k++) {
          const u = (k - (guns - 1) / 2) * 25, x = w.x + tx * u - w.ax * 1.5, z = w.z + tz * u - w.az * 1.5, y = this.dem.height(x, z) - 0.6;
          r.fig(FIG.gun, x, y, z, yaw, 0, sc, 0.2, 0.2, 0.2);
          r.fig(FIG.prone, x - w.ax * 1.2 + tx * 0.6, y, z - w.az * 1.2 + tz * 0.6, yaw, 0, sc, FELDGRAU[0], FELDGRAU[1], FELDGRAU[2]);
          this.count += 2;
          if (firing && Math.random() < 0.35) flashes.push(x + w.ax * 0.8, y + 0.5 * sc, z + w.az * 0.8);
        }
      }
      const cum = this.gerDead(s.id), dead = Math.min(40, Math.floor(cum[m0]));
      for (let k = 0; k < dead && this.count < budget; k++) {
        const u = (hash(s.id, k + 99) - 0.5) * CELL * 0.92, x = w.x + tx * u + w.ax * (hash(k, 5) - 0.5) * 3, z = w.z + tz * u + w.az * (hash(k, 5) - 0.5) * 3;
        r.fig(FIG.dead, x, this.dem.height(x, z) - 1.0, z, hash(k, s.id) * 6.3, 0, sc, FELDGRAU[0] * 0.85, FELDGRAU[1] * 0.85, FELDGRAU[2] * 0.85); this.count++;
      }
    }
    // muzzle flashes
    for (let k = 0; k < flashes.length; k += 3) r.bursts.push({ x: flashes[k], y: flashes[k + 1], z: flashes[k + 2], size: 2.2 * sc, r: 1, g: 0.85, b: 0.5, a: 1, vy: 0, grow: 0, life: 0.07, age: 0, glow: true });
  }
  private byCell: number[][] | null = null;
  private cellStrips(k: number) {
    if (!this.byCell) { this.byCell = this.b.cells.map(() => []); for (const c of this.b.strips) this.byCell[c.cell].push(c.id); }
    return this.byCell[k];
  }
}
