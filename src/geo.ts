// Map projection, elevation and geography. Local metres: x east, z south, y up; origin near Thiepval-Pozières.
import geoJson from '../web/geography.json';
import { DEM_B64 } from './demdata';
import { FINE } from './finedem';

export type LL = [number, number];
export const LAT0 = 50.06, LON0 = 2.72;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KZ = 110574;
export const toXZ = (ll: LL) => ({ x: (ll[1] - LON0) * KX, z: -(ll[0] - LAT0) * KZ });
export const toLL = (x: number, z: number): LL => [LAT0 - z / KZ, LON0 + x / KX];

export interface Geo {
  britishFront: LL[]; germanFront: LL[]; germanSecond: LL[]; frenchSector: LL[]; ancre: LL[];
  roads: { name: string; pts: LL[] }[];
  places: { name: string; ll: LL; side: string }[];
  features: { name: string; ll: LL }[];
  woods: { name: string; poly: LL[] }[];
  mines: { name: string; ll: LL; time: string; charge_lb: number; crater_m: number; note?: string }[];
  germanUnits: { name: string; ll: LL }[];
  divisions: { div: string; from: LL; to: LL; lead: string[]; support: string[]; attached?: string[]; supportDepth?: number; note?: string }[];
  anchors: { name: string; ll: LL; src: string }[];
  dem: { north: number; west: number; cell_deg: number; rows: number; cols: number; scale: number };
}
export const GEO = geoJson as unknown as Geo;

export class Dem {
  rows: number; cols: number; north: number; west: number; cell: number;
  h: Float32Array;
  minX: number; maxX: number; minZ: number; maxZ: number;
  /** 5 m grids (IGN RGE ALTI) in 1 km blocks along the front, loaded from terrain.bin; key 'i,j' */
  fine = { ...FINE, h: new Map<string, Float32Array>() };
  /** take the fine terrain from terrain.png's pixels (RGBA, as from getImageData); false if they don't check out */
  loadFine(px: Uint8ClampedArray, width: number) {
    const N = FINE.n + 1; let sum = 0; const out = new Map<string, Float32Array>();
    FINE.blocks.forEach(([i, j], k) => {
      const h = new Float32Array(N * N), r0 = Math.floor(k / FINE.cols) * N, c0 = (k % FINE.cols) * N;
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { const o = ((r0 + r) * width + c0 + c) * 4, d = px[o] * 256 + px[o + 1]; sum += d; h[r * N + c] = d * FINE.scale; }
      out.set(i + ',' + j, h);
    });
    if (sum !== FINE.checksum) { console.warn('terrain.png did not decode exactly; using the coarse terrain'); return false; }
    this.fine.h = out; return true;
  }
  constructor() {
    const d = GEO.dem;
    this.rows = d.rows; this.cols = d.cols; this.north = d.north; this.west = d.west; this.cell = d.cell_deg;
    const bin = atob(DEM_B64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const u16 = new Uint16Array(u8.buffer);
    this.h = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) this.h[i] = u16[i] * d.scale;
    const a = toXZ(this.llOf(0, 0)), b = toXZ(this.llOf(this.rows - 1, this.cols - 1));
    this.minX = a.x; this.minZ = a.z; this.maxX = b.x; this.maxZ = b.z;
  }
  /** lat/lon of the centre of cell (row, col) */
  llOf(r: number, c: number): LL { return [this.north - (r + 0.5) * this.cell, this.west + (c + 0.5) * this.cell]; }
  heightLL(lat: number, lon: number) {
    let r = (this.north - lat) / this.cell - 0.5, c = (lon - this.west) / this.cell - 0.5;
    r = Math.min(Math.max(r, 0), this.rows - 1.001); c = Math.min(Math.max(c, 0), this.cols - 1.001);
    const i = Math.floor(r), j = Math.floor(c), fr = r - i, fc = c - j, n = this.cols, h = this.h, k = i * n + j;
    return h[k] * (1 - fr) * (1 - fc) + h[k + 1] * (1 - fr) * fc + h[k + n] * fr * (1 - fc) + h[k + n + 1] * fr * fc;
  }
  height(x: number, z: number) {
    const F = this.fine;
    if (F.h.size) {
      const bi = Math.floor((x - F.x0) / F.block), bj = Math.floor((z - F.z0) / F.block), h = F.h.get(bi + ',' + bj);
      if (h) {
        const c = Math.min(F.n - 1e-6, (x - F.x0 - bi * F.block) / F.step), r = Math.min(F.n - 1e-6, (z - F.z0 - bj * F.block) / F.step), n = F.n + 1;
        const i = Math.floor(r), j = Math.floor(c), fr = r - i, fc = c - j, k = i * n + j;
        return h[k] * (1 - fr) * (1 - fc) + h[k + 1] * (1 - fr) * fc + h[k + n] * fr * (1 - fc) + h[k + n + 1] * fr * fc;
      }
    }
    const ll = toLL(x, z); return this.heightLL(ll[0], ll[1]);
  }
  inside(x: number, z: number) { return x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ; }
}

// ---------- polyline helpers (in local metres) ----------
export interface P { x: number; z: number }
export const pts = (ll: LL[]) => ll.map(toXZ);

/** resample a polyline every `step` metres */
export function resample(p: P[], step: number): P[] {
  const out: P[] = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n });
  }
  return out;
}

/** nearest point on a polyline: arc-length parameter s, position and unit tangent */
export function project(p: P[], q: P) {
  let best = { d: Infinity, s: 0, x: 0, z: 0, tx: 1, tz: 0 }, acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.z - a.z) * dz) / (L * L)));
    const x = a.x + dx * t, z = a.z + dz * t, d = Math.hypot(q.x - x, q.z - z);
    if (d < best.d) best = { d, s: acc + t * L, x, z, tx: dx / L, tz: dz / L };
    acc += L;
  }
  return best;
}

/** point and unit tangent at arc length s */
export function at(p: P[], s: number) {
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], L = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + L >= s || i === p.length - 1) {
      const t = L ? Math.max(0, Math.min(1, (s - acc) / L)) : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx: (b.x - a.x) / (L || 1), tz: (b.z - a.z) / (L || 1) };
    }
    acc += L;
  }
  return { x: p[0].x, z: p[0].z, tx: 1, tz: 0 };
}

/** offset a polyline sideways by d metres, on the side away from `away` */
export function offsetAway(p: P[], d: number, away: P[]): P[] {
  return p.map((q, i) => {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
    let nx = -(b.z - a.z), nz = b.x - a.x; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
    const near = project(away, q);
    if ((q.x - near.x) * nx + (q.z - near.z) * nz < 0) { nx = -nx; nz = -nz; }
    return { x: q.x + nx * d, z: q.z + nz * d };
  });
}

export function hhmm(min: number) {
  const h = Math.floor(min / 60), m = Math.floor(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
export function parseTime(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(s.replace(/^about\s+/, ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
