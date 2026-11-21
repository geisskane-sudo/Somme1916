// Procedural low-poly meshes. Figure meshes carry a "part" id and a pivot per vertex so the vertex
// shader can animate legs, arms and weapons. Prop meshes carry baked vertex colours.
import { MeshBuilder } from './gl';

// figure vertex: pos(3) normal(3) part(1) pivot(3) = 10 floats
export const FIG_STRIDE = 10;
// prop vertex: pos(3) normal(3) colour(3) = 9 floats
export const PROP_STRIDE = 9;

export const PART = { BODY: 0, LLEG: 1, RLEG: 2, SKIN: 3, HEAD: 4, WEAPON: 5, ARMS: 6, BELT: 7, METAL: 8, DARK: 9 };

type Vec3 = [number, number, number];

function boxFaces(cb: (p: Vec3[], n: Vec3) => void, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
  cb([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
  cb([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]);
  cb([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]);
  cb([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
  cb([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0]);
  cb([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
}

export function figBox(mb: MeshBuilder, part: number, pivot: Vec3, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rotX = 0) {
  const c = Math.cos(rotX), s = Math.sin(rotX);
  boxFaces((p, n) => {
    const base = mb.count;
    for (const v of p) {
      // optional rotation about x through the box centre
      const y = v[1] - cy, z = v[2] - cz;
      const ry = y * c - z * s + cy, rz = y * s + z * c + cz;
      const ny = n[1] * c - n[2] * s, nz = n[1] * s + n[2] * c;
      mb.vertex(v[0], ry, rz, n[0], ny, nz, part, pivot[0], pivot[1], pivot[2]);
    }
    mb.tri(base, base + 1, base + 2); mb.tri(base, base + 2, base + 3);
  }, cx, cy, cz, sx, sy, sz);
}

function figCylX(mb: MeshBuilder, part: number, cx: number, cy: number, cz: number, r: number, w: number, seg = 10) {
  const base = mb.count;
  for (const side of [-1, 1]) {
    const x = cx + side * w / 2;
    const c0 = mb.vertex(x, cy, cz, side, 0, 0, part, 0, 0, 0);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      mb.vertex(x, cy + Math.cos(a) * r, cz + Math.sin(a) * r, side, 0, 0, part, 0, 0, 0);
    }
    for (let i = 0; i < seg; i++) side < 0 ? mb.tri(c0, c0 + 2 + i, c0 + 1 + i) : mb.tri(c0, c0 + 1 + i, c0 + 2 + i);
  }
  // rim
  const rb = mb.count;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, ny = Math.cos(a), nz = Math.sin(a);
    mb.vertex(cx - w / 2, cy + ny * r, cz + nz * r, 0, ny, nz, part, 0, 0, 0);
    mb.vertex(cx + w / 2, cy + ny * r, cz + nz * r, 0, ny, nz, part, 0, 0, 0);
  }
  for (let i = 0; i < seg; i++) { const a = rb + i * 2; mb.tri(a, a + 2, a + 1); mb.tri(a + 1, a + 2, a + 3); }
  void base;
}

/** infantryman holding a rifle (modelled in the aiming position; shader rotates to rest) */
export function buildMan(officer = false): MeshBuilder {
  const mb = new MeshBuilder(FIG_STRIDE);
  const hipY = 0.9;
  figBox(mb, PART.LLEG, [-0.11, hipY, 0], -0.11, 0.46, 0, 0.14, 0.9, 0.17);
  figBox(mb, PART.RLEG, [0.11, hipY, 0], 0.11, 0.46, 0, 0.14, 0.9, 0.17);
  figBox(mb, PART.DARK, [-0.11, hipY, 0], -0.11, 0.05, 0.04, 0.15, 0.1, 0.26);
  figBox(mb, PART.DARK, [0.11, hipY, 0], 0.11, 0.05, 0.04, 0.15, 0.1, 0.26);
  figBox(mb, PART.BODY, [0, 0, 0], 0, 1.2, 0, 0.44, 0.62, 0.26);
  figBox(mb, PART.BELT, [0, 0, 0], 0, 0.93, 0, 0.46, 0.07, 0.28);
  if (!officer) figBox(mb, PART.BELT, [0, 0, 0], 0.02, 1.22, 0.135, 0.07, 0.6, 0.02, 0);
  figBox(mb, PART.SKIN, [0, 0, 0], 0, 1.63, 0, 0.2, 0.23, 0.22);
  figBox(mb, PART.HEAD, [0, 0, 0], 0, 1.79, -0.01, 0.27, 0.13, 0.29);
  figBox(mb, PART.HEAD, [0, 0, 0], 0, 1.73, 0, 0.36, 0.03, 0.38);
  const shY = 1.45;
  figBox(mb, PART.ARMS, [-0.27, shY, 0], -0.27, 1.2, 0, 0.11, 0.56, 0.13);
  figBox(mb, PART.ARMS, [0.27, shY, 0], 0.27, 1.2, 0, 0.11, 0.56, 0.13);
  if (officer) {
    figBox(mb, PART.METAL, [0.27, shY, 0], 0.27, 0.93, 0.35, 0.03, 0.04, 0.8);
  } else {
    figBox(mb, PART.WEAPON, [0.14, shY, 0], 0.14, shY - 0.03, 0.35, 0.06, 0.08, 1.05);
    figBox(mb, PART.METAL, [0.14, shY, 0], 0.14, shY - 0.01, 1.02, 0.025, 0.025, 0.42);
  }
  return mb;
}

export function buildHorse(pack = false): MeshBuilder {
  const mb = new MeshBuilder(FIG_STRIDE);
  const legY = 1.0;
  figBox(mb, PART.BODY, [0, 0, 0], 0, 1.3, 0, 0.52, 0.58, 1.75);
  figBox(mb, PART.SKIN, [0, 0, 0], 0, 1.72, 0.92, 0.28, 0.62, 0.36, -0.55);
  figBox(mb, PART.SKIN, [0, 0, 0], 0, 1.98, 1.22, 0.22, 0.26, 0.55, 0.35);
  figBox(mb, PART.HEAD, [0, 0, 0], 0, 1.62, -0.95, 0.12, 0.5, 0.14, 0.4);
  figBox(mb, PART.HEAD, [0, 0, 0], 0, 1.85, 0.8, 0.08, 0.5, 0.4, -0.55);
  const legs: [number, number, number][] = [[-0.17, 0.72, PART.LLEG], [0.17, 0.72, PART.RLEG], [-0.17, -0.7, PART.RLEG], [0.17, -0.7, PART.LLEG]];
  for (const [x, z, p] of legs) {
    figBox(mb, p, [x, legY, z], x, 0.5, z, 0.13, 1.0, 0.15);
    figBox(mb, PART.DARK, [x, legY, z], x, 0.04, z, 0.15, 0.08, 0.18);
  }
  if (pack) {
    figBox(mb, PART.BELT, [0, 0, 0], 0, 1.72, 0, 0.9, 0.35, 0.8);
    figBox(mb, PART.METAL, [0, 0, 0], 0.32, 1.95, 0, 0.18, 0.18, 1.1);
  } else {
    figBox(mb, PART.BELT, [0, 0, 0], 0, 1.6, -0.05, 0.56, 0.06, 0.6);
  }
  return mb;
}

export function buildGun(): MeshBuilder {
  const mb = new MeshBuilder(FIG_STRIDE);
  figBox(mb, PART.METAL, [0, 0, 0], 0, 0.78, 0.25, 0.17, 0.17, 1.15);
  figBox(mb, PART.METAL, [0, 0, 0], 0, 0.78, -0.25, 0.22, 0.22, 0.25);
  figBox(mb, PART.BODY, [0, 0, 0], -0.15, 0.58, -0.3, 0.07, 0.25, 1.1, 0.25);
  figBox(mb, PART.BODY, [0, 0, 0], 0.15, 0.58, -0.3, 0.07, 0.25, 1.1, 0.25);
  figBox(mb, PART.BODY, [0, 0, 0], 0, 0.2, -1.0, 0.3, 0.1, 0.4);
  figBox(mb, PART.DARK, [0, 0, 0], 0, 0.45, 0, 0.6, 0.06, 0.06);
  figCylX(mb, PART.DARK, -0.36, 0.45, 0, 0.45, 0.07);
  figCylX(mb, PART.DARK, 0.36, 0.45, 0, 0.45, 0.07);
  return mb;
}

// ---------------- props ----------------
export function propBox(mb: MeshBuilder, col: Vec3, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, topCol?: Vec3) {
  boxFaces((p, n) => {
    const base = mb.count;
    const c = n[1] > 0.5 && topCol ? topCol : n[1] < -0.5 ? [col[0] * 0.6, col[1] * 0.6, col[2] * 0.6] : col;
    for (const v of p) mb.vertex(v[0], v[1], v[2], n[0], n[1], n[2], c[0], c[1], c[2]);
    mb.tri(base, base + 1, base + 2); mb.tri(base, base + 2, base + 3);
  }, cx, cy, cz, sx, sy, sz);
}

function propSphere(mb: MeshBuilder, col: Vec3, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, seg = 7, ring = 5, jitter = 0) {
  const base = mb.count;
  for (let j = 0; j <= ring; j++) {
    const v = j / ring, phi = v * Math.PI;
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(th), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(th);
      const k = 1 + (jitter ? (Math.sin(i * 12.9 + j * 7.3) * 0.5) * jitter : 0);
      const shade = 0.85 + 0.15 * ny;
      mb.vertex(cx + nx * rx * k, cy + ny * ry * k, cz + nz * rz * k, nx, ny, nz, col[0] * shade, col[1] * shade, col[2] * shade);
    }
  }
  for (let j = 0; j < ring; j++) for (let i = 0; i < seg; i++) {
    const a = base + j * (seg + 1) + i, b = a + seg + 1;
    mb.tri(a, a + 1, b); mb.tri(a + 1, b + 1, b);
  }
}

/** unit house: 1×1×1 box (scaled per instance) with a flat parapet roof */
export function buildHouse(): MeshBuilder {
  const mb = new MeshBuilder(PROP_STRIDE);
  const mud: Vec3 = [0.68, 0.56, 0.42], roof: Vec3 = [0.6, 0.5, 0.38];
  propBox(mb, mud, 0, 0.5, 0, 1, 1, 1, roof);
  propBox(mb, [0.62, 0.5, 0.37], 0, 1.04, 0.48, 1, 0.08, 0.04);
  propBox(mb, [0.62, 0.5, 0.37], 0, 1.04, -0.48, 1, 0.08, 0.04);
  propBox(mb, [0.62, 0.5, 0.37], 0.48, 1.04, 0, 0.04, 0.08, 1);
  propBox(mb, [0.62, 0.5, 0.37], -0.48, 1.04, 0, 0.04, 0.08, 1);
  propBox(mb, [0.2, 0.15, 0.1], 0, 0.3, 0.505, 0.15, 0.45, 0.01);
  return mb;
}
export function buildWall(col: Vec3 = [0.66, 0.55, 0.42]): MeshBuilder {
  const mb = new MeshBuilder(PROP_STRIDE);
  propBox(mb, col, 0, 0.5, 0, 1, 1, 1, [col[0] * 1.05, col[1] * 1.05, col[2] * 1.05]);
  return mb;
}
export function buildSangar(): MeshBuilder {
  const mb = new MeshBuilder(PROP_STRIDE);
  // stacked stones
  for (let i = 0; i < 9; i++) {
    const x = -0.45 + i * 0.112, h = 0.75 + Math.sin(i * 3.1) * 0.2;
    const g = 0.45 + Math.sin(i * 7.7) * 0.05;
    propBox(mb, [g + 0.05, g, g - 0.04], x, h / 2, Math.sin(i * 5.3) * 0.08, 0.13, h, 0.9);
  }
  return mb;
}
export function buildRock(): MeshBuilder {
  const mb = new MeshBuilder(PROP_STRIDE);
  propSphere(mb, [0.5, 0.46, 0.41], 0, 0.3, 0, 0.6, 0.45, 0.5, 6, 4, 0.5);
  return mb;
}
export function buildTree(): MeshBuilder {
  const mb = new MeshBuilder(PROP_STRIDE);
  propBox(mb, [0.33, 0.24, 0.16], 0, 0.3, 0, 0.12, 0.6, 0.12);
  propSphere(mb, [0.32, 0.4, 0.2], 0, 0.68, 0, 0.42, 0.34, 0.42, 7, 5, 0.35);
  return mb;
}
export function buildScrub(): MeshBuilder {
  const mb = new MeshBuilder(PROP_STRIDE);
  propSphere(mb, [0.42, 0.42, 0.26], 0, 0.35, 0, 0.5, 0.4, 0.5, 6, 4, 0.5);
  return mb;
}
export function buildFlag(): MeshBuilder {
  const mb = new MeshBuilder(PROP_STRIDE);
  propBox(mb, [0.35, 0.28, 0.2], 0, 4, 0, 0.1, 8, 0.1);
  propBox(mb, [1, 1, 1], 0.9, 7.2, 0, 1.7, 1.1, 0.05);
  return mb;
}
