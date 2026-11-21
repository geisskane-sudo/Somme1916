// The Thiepval close-up ground: a detailed painting (about 1 m per pixel) of the trenches traced from
// the 1:5000 Schwaben Redoubt sheet, the British trenches, German wire and the shell-torn ground,
// plus the sheet itself as an optional overlay.
import thiepval from '../data/thiepval.json';
import { GEO, pts, project, type P } from './geo';
import type { Renderer } from './render';

type XZ = [number, number];
const SIZE = 2048;

export const SHEET = {
  corners: thiepval.corners as XZ[],
  trenches: thiepval.trenches as XZ[][],
  front: thiepval.front as XZ[],
};
/** axis-aligned box around the sheet, with a margin, in local metres */
export const BOX = (() => {
  const xs = SHEET.corners.map(c => c[0]), zs = SHEET.corners.map(c => c[1]), m = 150;
  return [Math.min(...xs) - m, Math.min(...zs) - m, Math.max(...xs) + m, Math.max(...zs) + m];
})();
export const inBox = (x: number, z: number, pad = 0) => x > BOX[0] - pad && x < BOX[2] + pad && z > BOX[1] - pad && z < BOX[3] + pad;

function rng(seed: number) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

export function paintGround(r: Renderer) {
  const [x0, z0, x1, z1] = BOX, kx = SIZE / (x1 - x0), kz = SIZE / (z1 - z0);
  const px = (x: number) => (x - x0) * kx, pz = (z: number) => (z - z0) * kz, m = kx; // pixels per metre
  const cv = document.createElement('canvas'); cv.width = cv.height = SIZE;
  const g = cv.getContext('2d')!;
  const line = (P: XZ[] | P[], w: number, col: string, dash?: number[]) => {
    g.beginPath(); P.forEach((p, i) => { const [x, z] = Array.isArray(p) ? p : [p.x, p.z]; i ? g.lineTo(px(x), pz(z)) : g.moveTo(px(x), pz(z)); });
    g.lineWidth = w * m; g.strokeStyle = col; g.setLineDash(dash ? dash.map(d => d * m) : []); g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke();
  };
  // where the shells fell: a density field from the German trench system and no man's land
  const dens = document.createElement('canvas'); dens.width = dens.height = 256;
  const d = dens.getContext('2d')!, dk = 256 / SIZE;
  d.filter = 'blur(6px)'; d.lineCap = 'round';
  d.beginPath(); for (const T of SHEET.trenches) T.forEach(([x, z], i) => (i ? d.lineTo(px(x) * dk, pz(z) * dk) : d.moveTo(px(x) * dk, pz(z) * dk)));
  d.lineWidth = 120 * m * dk; d.strokeStyle = 'rgba(255,255,255,0.5)'; d.stroke();
  const brit = pts(GEO.britishFront).filter(p => inBox(p.x, p.z, 600)), ger = pts(GEO.germanFront).filter(p => inBox(p.x, p.z, 600));
  d.beginPath(); brit.forEach((p, i) => (i ? d.lineTo(px(p.x) * dk, pz(p.z) * dk) : d.moveTo(px(p.x) * dk, pz(p.z) * dk)));
  d.lineWidth = 160 * m * dk; d.strokeStyle = 'rgba(255,255,255,0.35)'; d.stroke();
  const dd = d.getImageData(0, 0, 256, 256).data;
  const density = (x: number, z: number) => { const i = Math.floor(pz(z) * dk), j = Math.floor(px(x) * dk); return i < 0 || j < 0 || i > 255 || j > 255 ? 0 : dd[(i * 256 + j) * 4] / 255; };

  // churned ground wash
  g.globalCompositeOperation = 'source-over';
  const wash = g.createImageData(SIZE, SIZE), W = wash.data;
  for (let i = 0; i < SIZE; i += 2) for (let j = 0; j < SIZE; j += 2) {
    const v = Math.min(1, dd[(Math.floor(i * dk) * 256 + Math.floor(j * dk)) * 4] / 255 * 1.6);
    for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) { const o = ((i + a) * SIZE + j + b) * 4; W[o] = 122; W[o + 1] = 112; W[o + 2] = 92; W[o + 3] = v * 150; }
  }
  g.putImageData(wash, 0, 0);
  // shell holes
  const R = rng(1916);
  for (let n = 0; n < 90000; n++) {
    const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0), p = density(x, z);
    if (R() > p * 0.9 + 0.02) continue;
    const big = R() < 0.06, rr = (big ? 3 + R() * 3 : 0.8 + R() * R() * 2.2) * m, X = px(x), Z = pz(z);
    const gr = g.createRadialGradient(X, Z, 0, X, Z, rr * 1.6);
    gr.addColorStop(0, 'rgba(78,66,50,0.7)'); gr.addColorStop(0.5, 'rgba(105,92,72,0.45)'); gr.addColorStop(0.68, 'rgba(206,198,178,0.45)'); gr.addColorStop(1, 'rgba(206,198,178,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(X, Z, rr * 1.6, 0, 7); g.fill();
  }
  // German wire: belts in front of the front line on the sheet
  const front = SHEET.front;
  const offset = (P: XZ[], dist: number) => P.map((p, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    let nx = -(b[1] - a[1]), nz = b[0] - a[0]; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
    // face the British side
    const q = project(brit.length ? brit : pts(GEO.britishFront), { x: p[0], z: p[1] });
    if ((q.x - p[0]) * nx + (q.z - p[1]) * nz < 0) { nx = -nx; nz = -nz; }
    return [p[0] + nx * dist, p[1] + nz * dist] as XZ;
  });
  for (const dist of [18, 26, 34]) line(offset(front, dist), 5, 'rgba(60,58,54,0.55)', [1.2, 1.0]);
  // trenches: chalk spoil, then the dark cut
  for (const T of SHEET.trenches) line(T, 5, 'rgba(222,215,198,0.9)');
  for (const T of SHEET.trenches) line(T, 1.8, 'rgba(45,39,31,1)');
  // British trenches from the 1:20000 tracing, with support lines behind
  const B = brit;
  const back = (dist: number) => B.map((p, i) => { const a = B[Math.max(0, i - 1)], b = B[Math.min(B.length - 1, i + 1)]; let nx = -(b.z - a.z), nz = b.x - a.x; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L; const g2 = project(ger, p); if ((g2.x - p.x) * nx + (g2.z - p.z) * nz > 0) { nx = -nx; nz = -nz; } return { x: p.x + nx * dist, z: p.z + nz * dist }; });
  for (const L of [B, back(70), back(180)]) { line(L, 6, 'rgba(218,212,196,0.9)'); line(L, 2.2, 'rgba(38,33,27,1)'); }
  r.setDetail(cv, BOX);
}

/** load the 1916 sheet and drape it with the fitted transform */
export function loadSheet(r: Renderer, url = 'thiepval_map.jpg') {
  return new Promise<void>((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const F = thiepval.fit, [W, H] = thiepval.size_px, c = Math.cos(F.th), s = Math.sin(F.th);
      // inverse of x = X0 + s*(c du - s dv), z = Z0 + s*(s du + c dv)
      const a = [c / F.s / W, s / F.s / W, (-(c * F.X0 + s * F.Z0) / F.s + F.uc) / W];
      const b = [-s / F.s / H, c / F.s / H, ((s * F.X0 - c * F.Z0) / F.s + F.vc) / H];
      const fr = thiepval.frame_px;
      r.setMap(img, a, b, [fr[0] / W, fr[1] / H, fr[2] / W, fr[3] / H]);
      res();
    };
    img.onerror = () => rej(new Error('Could not load the 1916 map'));
    img.src = url;
  });
}
