// A full 3D view of one sector, built with the Thiepval prototype's engine: the 36th (Ulster) Division's
// attack from Thiepval Wood on the Schwaben Redoubt. Trenches are real geometry along the lines traced
// from the 1:5000 sheet; the soldiers act out the recorded battle (the same companies, numbers and
// trench ownership as the map), so nothing seen here contradicts the record.
import thiepval from '../data/thiepval.json';
import { createProgram, uniforms, MeshBuilder, uploadMesh, InstanceData, drawInstanced, type GPUMesh } from './render/gl';
import * as S from './render/shaders3d';
import * as M from './render/meshes3d';
import { RTSCamera, type Terrain } from './render/camera3d';
import { fbm } from './core/rng';
import { GEO, pts, project, type Dem, type P } from './geo';
import { Battle, ST, CELL, T0, ZERO } from './battle';
import type { BattleView } from './battleview';

type XZ = [number, number];
type U = Record<string, WebGLUniformLocation | null>;
const LIT = ['uVP', 'uSun', 'uCam', 'uSunCol', 'uSkyCol', 'uGndCol', 'uFogSun', 'uFogAway', 'uFogDen', 'uHazeY', 'uLightVP', 'uShadow', 'uTexel', 'uShadowOn'];
const FIG_ATTR = [{ loc: 0, size: 3 }, { loc: 1, size: 3 }, { loc: 2, size: 1 }, { loc: 3, size: 3 }];
const FIG_INST = [{ loc: 4, size: 3 }, { loc: 5, size: 1 }, { loc: 6, size: 3 }, { loc: 7, size: 3 }, { loc: 8, size: 3 }, { loc: 9, size: 3 }, { loc: 10, size: 4 }];
const PROP_ATTR = [{ loc: 0, size: 3 }, { loc: 1, size: 3 }, { loc: 2, size: 3 }];
const PROP_INST = [{ loc: 4, size: 3 }, { loc: 5, size: 1 }, { loc: 6, size: 3 }, { loc: 7, size: 3 }];
const VCOL_ATTR = [{ loc: 0, size: 3 }, { loc: 1, size: 3 }, { loc: 2, size: 3 }, { loc: 3, size: 1 }];

/** the sector: world box (local metres of the main map) */
export const SECTOR = { name: 'Schwaben Redoubt', division: '36th (Ulster) Division', x0: -3350, x1: -2250, z0: -800, z1: 450 };
const CX = (SECTOR.x0 + SECTOR.x1) / 2, CZ = (SECTOR.z0 + SECTOR.z1) / 2, HW = (SECTOR.x1 - SECTOR.x0) / 2, HD = (SECTOR.z1 - SECTOR.z0) / 2;
const RES = 2.5, TEX = 2048, DEPTH = 1.9, FIRESTEP = 0.6, WIDTH = 2.0;
const UNIFORM = {
  british: { tunic: [0.47, 0.42, 0.27], legs: [0.42, 0.37, 0.24], helmet: [0.34, 0.34, 0.25], skin: [0.8, 0.62, 0.5] },
  german: { tunic: [0.45, 0.47, 0.42], legs: [0.36, 0.37, 0.34], helmet: [0.37, 0.39, 0.36], skin: [0.8, 0.62, 0.5] },
};
const POSE = { stand: 0, walk: 1, run: 2, aim: 3, kneel: 4, kneelAim: 5, down: 6 };
const hash = (a: number, b: number) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const inside = (x: number, z: number, poly: P[]) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) c = !c; } return c; };

// ---------------- shaders for the cut ground and the trench walls ----------------
const GROUND_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec2 aUV;
uniform mat4 uVP; out vec3 vNor; out vec3 vPos; out vec2 vUV;
void main(){ vNor = aNor; vPos = aPos; vUV = aUV; gl_Position = uVP * vec4(aPos, 1.0); }`;
const GROUND_FS = `#version 300 es
precision highp float;
in vec3 vNor; in vec3 vPos; in vec2 vUV; out vec4 o;
${S.LIGHT}
uniform sampler2D uCol, uMask;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main(){
  if (texture(uMask, vUV).r > 0.5) discard;
  vec3 c = texture(uCol, vUV).rgb;
  float grit = vn(vPos.xz * 0.9) * 0.55 + vn(vPos.xz * 3.1) * 0.45;
  c *= 0.88 + 0.2 * grit;
  o = vec4(light(c, normalize(vNor), vPos, 1.0), 1.0);
}`;
const VCOL_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec3 aCol; layout(location=3) in float aSh;
uniform mat4 uVP; out vec3 vNor; out vec3 vCol; out vec3 vPos; out float vSh;
void main(){ vNor = aNor; vCol = aCol; vPos = aPos; vSh = aSh; gl_Position = uVP * vec4(aPos, 1.0); }`;
const VCOL_FS = `#version 300 es
precision highp float;
in vec3 vNor; in vec3 vCol; in vec3 vPos; in float vSh; out vec4 o;
${S.LIGHT}
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){ vec3 n = normalize(vNor); vec3 c = vCol * (0.9 + 0.15 * h(floor(vPos.xz * 3.0 + vPos.y * 5.0))); o = vec4(light(c, n, vPos, vSh), 1.0); }`;

interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; size: number; grow: number; r: number; g: number; b: number; a: number; emissive: boolean; life: number; age: number; drag: number; grav: number }

export class Scene3D implements Terrain {
  minX = -HW; minZ = -HD;
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  cam: RTSCamera;
  private pG: WebGLProgram; private uG: U; private pV: WebGLProgram; private uV: U;
  private pP: WebGLProgram; private uP: U; private pF: WebGLProgram; private uF: U;
  private pPt: WebGLProgram; private uPt: U; private pL: WebGLProgram; private uL: U; private pS: WebGLProgram; private uS: U;
  private ground!: GPUMesh; private walls!: GPUMesh; private colTex!: WebGLTexture; private maskTex!: WebGLTexture; private dummyShadow: WebGLTexture;
  private man: GPUMesh; private dMan = new InstanceData(20, 4096);
  private tree: GPUMesh; private stump: GPUMesh; private trees = new InstanceData(10, 2048); private stumps = new InstanceData(10, 2048); private posts!: GPUMesh; private postData = new InstanceData(10, 4096);
  private wireLines: number[] = [];
  private lineVAO: WebGLVertexArrayObject; private lineBuf: WebGLBuffer;
  private pointVAO: WebGLVertexArrayObject; private pointBuf: WebGLBuffer; private pts = new Float32Array(8 * 12000);
  private particles: Particle[] = [];
  /** trench centre lines sampled every metre, in scene coordinates, with a coarse grid for lookups */
  private tl: { x: Float32Array; z: Float32Array; line: Int32Array; german: Uint8Array } = { x: new Float32Array(), z: new Float32Array(), line: new Int32Array(), german: new Uint8Array() };
  private grid = new Map<number, number[]>();
  private sectionSnap = new Map<number, number>();
  private loss = new Map<number, { done: number; n0: number; rank: Int16Array; death: Float32Array }>();
  count = 0;

  constructor(private b: Battle, private bv: BattleView, private dem: Dem) {
    this.canvas = document.createElement('canvas'); this.canvas.id = 'gl3d';
    const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.cam = new RTSCamera(this);
    this.pG = createProgram(gl, GROUND_VS, GROUND_FS); this.uG = uniforms(gl, this.pG, [...LIT, 'uCol', 'uMask']);
    this.pV = createProgram(gl, VCOL_VS, VCOL_FS); this.uV = uniforms(gl, this.pV, LIT);
    this.pP = createProgram(gl, S.PROP_VS, S.PROP_FS); this.uP = uniforms(gl, this.pP, [...LIT, 'uAlpha']);
    this.pF = createProgram(gl, S.FIG_VS, S.FIG_FS); this.uF = uniforms(gl, this.pF, LIT);
    this.pPt = createProgram(gl, S.POINT_VS, S.POINT_FS); this.uPt = uniforms(gl, this.pPt, [...LIT, 'uScale']);
    this.pL = createProgram(gl, S.LINE_VS, S.LINE_FS); this.uL = uniforms(gl, this.pL, ['uVP']);
    this.pS = createProgram(gl, S.SKY_VS, S.SKY_FS); this.uS = uniforms(gl, this.pS, [...LIT, 'uInvVP']);
    this.man = uploadMesh(gl, M.buildMan(false), FIG_ATTR, FIG_INST);
    this.tree = uploadMesh(gl, M.buildTree(), PROP_ATTR, PROP_INST);
    const sm = new MeshBuilder(9); M.propBox(sm, [0.3, 0.23, 0.16], 0, 0.5, 0, 0.1, 1, 0.1); M.propBox(sm, [0.28, 0.21, 0.14], 0.12, 0.8, 0, 0.05, 0.35, 0.05); this.stump = uploadMesh(gl, sm, PROP_ATTR, PROP_INST);
    const pm = new MeshBuilder(9); M.propBox(pm, [0.3, 0.24, 0.17], 0, 0.5, 0, 0.06, 1, 0.06); this.posts = uploadMesh(gl, pm, PROP_ATTR, PROP_INST);
    this.dummyShadow = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.dummyShadow);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT16, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    this.pointVAO = gl.createVertexArray()!; this.pointBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.pointVAO); gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    this.lineVAO = gl.createVertexArray()!; this.lineBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.lineVAO); gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
    this.build();
    this.cam.setTarget(-2900 - CX, -150 - CZ, true); this.cam.gdist = this.cam.dist = 420; this.cam.gyaw = this.cam.yaw = -2.0; this.cam.gpitch = this.cam.pitch = this.cam.autoPitch(420);
  }

  // ---------------- ground ----------------
  /** ground height in scene coordinates */
  heightAt(x: number, z: number) { const X = x + CX, Z = z + CZ; return this.dem.height(X, Z) + fbm(X * 0.02, Z * 0.02, 5, 3) * 0.8 - 0.4; }
  inBounds(x: number, z: number) { return Math.abs(x) < HW && Math.abs(z) < HD; }

  private trenchLines(): { p: XZ[]; german: boolean }[] {
    const out: { p: XZ[]; german: boolean }[] = [];
    const inWin = (x: number, z: number) => x > SECTOR.x0 - 50 && x < SECTOR.x1 + 50 && z > SECTOR.z0 - 50 && z < SECTOR.z1 + 50;
    for (const T of thiepval.trenches as XZ[][]) if (T.some(p => inWin(p[0], p[1]))) out.push({ p: T.map(p => [p[0] - CX, p[1] - CZ] as XZ), german: true });
    // British assembly trenches in Thiepval Wood: where the companies wait (0, 45, 90, 230, 275, 380, 425 m behind the front)
    const B = pts(GEO.britishFront).filter(p => inWin(p.x, p.z)), G = pts(GEO.germanFront);
    if (B.length > 1) {
      const fine: P[] = []; for (let i = 1; i < B.length; i++) { const a = B[i - 1], c = B[i], n = Math.ceil(Math.hypot(c.x - a.x, c.z - a.z) / 10); for (let k = 0; k < n; k++) fine.push({ x: a.x + (c.x - a.x) * k / n, z: a.z + (c.z - a.z) * k / n }); }
      const back = (d: number) => fine.map((p, i) => { const a = fine[Math.max(0, i - 3)], c = fine[Math.min(fine.length - 1, i + 3)]; let nx = -(c.z - a.z), nz = c.x - a.x; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L; const g = project(G, p); if ((g.x - p.x) * nx + (g.z - p.z) * nz > 0) { nx = -nx; nz = -nz; } return [p.x + nx * d - CX, p.z + nz * d - CZ] as XZ; });
      for (const d of [0, 45, 90, 230, 275, 380, 425]) out.push({ p: back(d), german: false });
      // communication trenches between them
      for (let i = 8; i < fine.length; i += 25) { const P0 = back(0)[i], P1 = back(425)[i]; const zz: XZ[] = []; for (let k = 0; k <= 20; k++) { const f = k / 20; zz.push([P0[0] + (P1[0] - P0[0]) * f + (k % 2 ? 3 : -3) * (P1[1] - P0[1]) / 425, P0[1] + (P1[1] - P0[1]) * f - (k % 2 ? 3 : -3) * (P1[0] - P0[0]) / 425]); } out.push({ p: zz, german: false }); }
    }
    return out;
  }

  private build() {
    const gl = this.gl, lines = this.trenchLines();
    // sample trench centre lines every metre
    const X: number[] = [], Z: number[] = [], Ln: number[] = [], Ge: number[] = [];
    lines.forEach((L, li) => { for (let i = 1; i < L.p.length; i++) { const [ax, az] = L.p[i - 1], [bx, bz] = L.p[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az))); for (let k = 0; k < n; k++) { X.push(ax + (bx - ax) * k / n); Z.push(az + (bz - az) * k / n); Ln.push(li); Ge.push(L.german ? 1 : 0); } } });
    this.tl = { x: new Float32Array(X), z: new Float32Array(Z), line: new Int32Array(Ln), german: new Uint8Array(Ge) };
    for (let i = 0; i < X.length; i++) { const k = this.gkey(X[i], Z[i]); const a = this.grid.get(k); if (a) a.push(i); else this.grid.set(k, [i]); }

    // textures: colour and trench mask over the window
    const px = (x: number) => (x + HW) / (2 * HW) * TEX, pz = (z: number) => (z + HD) / (2 * HD) * TEX, mpp = TEX / (2 * HW);
    const mask = document.createElement('canvas'); mask.width = mask.height = TEX;
    const mg = mask.getContext('2d')!; mg.fillStyle = '#000'; mg.fillRect(0, 0, TEX, TEX);
    mg.strokeStyle = '#fff'; mg.lineCap = 'round'; mg.lineJoin = 'round'; mg.lineWidth = (WIDTH - 0.35) * mpp;
    for (const L of lines) { mg.beginPath(); L.p.forEach(([x, z], i) => (i ? mg.lineTo(px(x), pz(z)) : mg.moveTo(px(x), pz(z)))); mg.stroke(); }
    const col = document.createElement('canvas'); col.width = col.height = TEX;
    const cg = col.getContext('2d')!;
    cg.fillStyle = 'rgb(104,114,64)'; cg.fillRect(0, 0, TEX, TEX);
    // fields in strips
    for (let i = 0; i < 60; i++) { const x = hash(i, 1) * TEX, z = hash(i, 2) * TEX, w = 150 + hash(i, 3) * 400, h = 60 + hash(i, 4) * 200; cg.fillStyle = `rgba(${120 + hash(i, 5) * 40},${118 + hash(i, 6) * 30},${66 + hash(i, 7) * 20},0.5)`; cg.save(); cg.translate(x, z); cg.rotate(0.3); cg.fillRect(-w / 2, -h / 2, w, h); cg.restore(); }
    // Thiepval Wood floor
    const wood = (GEO as any).woods?.find((w: any) => w.name === 'Thiepval Wood');
    const woodPoly: P[] = wood ? pts(wood.poly ?? wood.pts ?? wood.ll).map((p: P) => ({ x: p.x - CX, z: p.z - CZ })) : [];
    if (woodPoly.length) { cg.fillStyle = 'rgb(66,74,40)'; cg.beginPath(); woodPoly.forEach((p, i) => (i ? cg.lineTo(px(p.x), pz(p.z)) : cg.moveTo(px(p.x), pz(p.z)))); cg.fill(); }
    // churned ground and shell holes: dense along the German trenches and in no man's land
    const dens = document.createElement('canvas'); dens.width = dens.height = 256; const dg = dens.getContext('2d')!, dk = 256 / TEX;
    dg.filter = 'blur(5px)'; dg.lineCap = 'round';
    for (const L of lines) { dg.beginPath(); L.p.forEach(([x, z], i) => (i ? dg.lineTo(px(x) * dk, pz(z) * dk) : dg.moveTo(px(x) * dk, pz(z) * dk))); dg.lineWidth = (L.german ? 90 : 40) * mpp * dk; dg.strokeStyle = L.german ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)'; dg.stroke(); }
    const dd = dg.getImageData(0, 0, 256, 256).data, density = (i: number, j: number) => dd[(Math.min(255, Math.max(0, i)) * 256 + Math.min(255, Math.max(0, j))) * 4] / 255;
    const wash = cg.getImageData(0, 0, TEX, TEX), W = wash.data;
    for (let i = 0; i < TEX; i++) for (let j = 0; j < TEX; j++) { const v = Math.min(1, density(Math.floor(i * dk), Math.floor(j * dk)) * 1.5), o = (i * TEX + j) * 4; W[o] += (124 - W[o]) * v * 0.55; W[o + 1] += (114 - W[o + 1]) * v * 0.55; W[o + 2] += (88 - W[o + 2]) * v * 0.55; }
    cg.putImageData(wash, 0, 0);
    const craters: { x: number; z: number; r: number }[] = [];
    for (let n = 0; n < 70000; n++) {
      const x = hash(n, 11) * TEX, z = hash(n, 12) * TEX, d = density(Math.floor(z * dk), Math.floor(x * dk));
      if (hash(n, 13) > d * 0.42 + 0.004) continue;
      const big = hash(n, 14) < 0.05, r = (big ? 2.5 + hash(n, 15) * 3 : 0.7 + hash(n, 15) ** 2 * 2) * mpp;
      const gr = cg.createRadialGradient(x, z, 0, x, z, r * 1.6);
      gr.addColorStop(0, 'rgba(70,58,44,0.75)'); gr.addColorStop(0.5, 'rgba(98,86,66,0.5)'); gr.addColorStop(0.7, 'rgba(204,196,176,0.5)'); gr.addColorStop(1, 'rgba(204,196,176,0)');
      cg.fillStyle = gr; cg.beginPath(); cg.arc(x, z, r * 1.6, 0, 7); cg.fill();
      if (big) craters.push({ x: x / TEX * 2 * HW - HW, z: z / TEX * 2 * HD - HD, r: r / mpp });
    }
    // chalk spoil thrown up along the trenches
    cg.lineCap = 'round'; cg.lineJoin = 'round';
    for (const L of lines) { cg.beginPath(); L.p.forEach(([x, z], i) => (i ? cg.lineTo(px(x), pz(z)) : cg.moveTo(px(x), pz(z)))); cg.lineWidth = 7 * mpp; cg.strokeStyle = L.german ? 'rgba(214,208,190,0.85)' : 'rgba(170,160,130,0.7)'; cg.stroke(); }
    this.colTex = this.tex(col, true); this.maskTex = this.tex(mask, false);

    // ground mesh, with big shell holes pressed in
    const nx = Math.round(2 * HW / RES) + 1, nz = Math.round(2 * HD / RES) + 1, hgt = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) hgt[j * nx + i] = this.heightAt(-HW + i * RES, -HD + j * RES);
    for (const c of craters) { const i0 = Math.floor((c.x + HW) / RES), j0 = Math.floor((c.z + HD) / RES), k = Math.ceil(c.r / RES) + 1; for (let j = j0 - k; j <= j0 + k; j++) for (let i = i0 - k; i <= i0 + k; i++) { if (i < 0 || j < 0 || i >= nx || j >= nz) continue; const d = Math.hypot(-HW + i * RES - c.x, -HD + j * RES - c.z) / c.r; if (d < 1) hgt[j * nx + i] -= (1 - d * d) * c.r * 0.35; } }
    const gm = new MeshBuilder(8);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, hl = hgt[j * nx + Math.max(0, i - 1)], hr = hgt[j * nx + Math.min(nx - 1, i + 1)], hd = hgt[Math.max(0, j - 1) * nx + i], hu = hgt[Math.min(nz - 1, j + 1) * nx + i];
      let n0 = hl - hr, n1 = 2 * RES, n2 = hd - hu; const l = Math.hypot(n0, n1, n2);
      gm.vertex(-HW + i * RES, hgt[k], -HD + j * RES, n0 / l, n1 / l, n2 / l, i / (nx - 1), j / (nz - 1));
    }
    for (let j = 0; j + 1 < nz; j++) for (let i = 0; i + 1 < nx; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; gm.tri(a, c, b); gm.tri(b, c, d); }
    this.ground = uploadMesh(gl, gm, [{ loc: 0, size: 3 }, { loc: 1, size: 3 }, { loc: 2, size: 2 }]);
    this.hgt = hgt; this.nx = nx; this.nz = nz;

    // trench walls, floor and sandbag lips
    const wm = new MeshBuilder(10);
    const quad = (a: number[], b: number[], c: number[], d: number[], col: number[], sh: number) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      let nx2 = uy * vz - uz * vy, ny2 = uz * vx - ux * vz, nz2 = ux * vy - uy * vx; const L = Math.hypot(nx2, ny2, nz2) || 1; nx2 /= L; ny2 /= L; nz2 /= L;
      const i0 = wm.vertex(...a, nx2, ny2, nz2, ...col, sh), i1 = wm.vertex(...b, nx2, ny2, nz2, ...col, sh), i2 = wm.vertex(...c, nx2, ny2, nz2, ...col, sh), i3 = wm.vertex(...d, nx2, ny2, nz2, ...col, sh);
      wm.tri(i0, i1, i2); wm.tri(i0, i2, i3);
    };
    for (const L of lines) {
      const P = L.p; if (P.length < 2) continue;
      const wallC = L.german ? [0.7, 0.67, 0.58] : [0.5, 0.44, 0.33], floorC = [0.3, 0.25, 0.19], lipC = L.german ? [0.62, 0.58, 0.48] : [0.52, 0.46, 0.34];
      const off = (i: number, s: number, w: number) => { const a = P[Math.max(0, i - 1)], c = P[Math.min(P.length - 1, i + 1)]; let nx2 = -(c[1] - a[1]), nz2 = c[0] - a[0]; const l = Math.hypot(nx2, nz2) || 1; return [P[i][0] + nx2 / l * s * w, P[i][1] + nz2 / l * s * w]; };
      for (let i = 0; i + 1 < P.length; i++) {
        const g = (x: number, z: number) => this.groundAt(x, z);
        const lt0 = off(i, 1, WIDTH / 2), lt1 = off(i + 1, 1, WIDTH / 2), rt0 = off(i, -1, WIDTH / 2), rt1 = off(i + 1, -1, WIDTH / 2);
        const lb0 = off(i, 1, 0.7), lb1 = off(i + 1, 1, 0.7), rb0 = off(i, -1, 0.7), rb1 = off(i + 1, -1, 0.7);
        const lo0 = off(i, 1, WIDTH / 2 + 1.1), lo1 = off(i + 1, 1, WIDTH / 2 + 1.1), ro0 = off(i, -1, WIDTH / 2 + 1.1), ro1 = off(i + 1, -1, WIDTH / 2 + 1.1);
        const c0 = this.groundAt(P[i][0], P[i][1]) - DEPTH, c1 = this.groundAt(P[i + 1][0], P[i + 1][1]) - DEPTH;
        const V = (q: number[], y: number) => [q[0], y, q[1]];
        quad(V(lb0, c0), V(lb1, c1), V(rb1, c1), V(rb0, c0), floorC, 0.6);
        quad(V(lt0, g(lt0[0], lt0[1]) + 0.25), V(lt1, g(lt1[0], lt1[1]) + 0.25), V(lb1, c1), V(lb0, c0), wallC, 0.75);
        quad(V(rb0, c0), V(rb1, c1), V(rt1, g(rt1[0], rt1[1]) + 0.25), V(rt0, g(rt0[0], rt0[1]) + 0.25), wallC, 0.75);
        quad(V(lo0, g(lo0[0], lo0[1]) - 0.05), V(lo1, g(lo1[0], lo1[1]) - 0.05), V(lt1, g(lt1[0], lt1[1]) + 0.25), V(lt0, g(lt0[0], lt0[1]) + 0.25), lipC, 1);
        quad(V(rt0, g(rt0[0], rt0[1]) + 0.25), V(rt1, g(rt1[0], rt1[1]) + 0.25), V(ro1, g(ro1[0], ro1[1]) - 0.05), V(ro0, g(ro0[0], ro0[1]) - 0.05), lipC, 1);
      }
    }
    this.walls = uploadMesh(gl, wm, VCOL_ATTR);

    // Thiepval Wood: whole trees deep in the wood, shattered stumps nearer the line
    const put = (d: InstanceData, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, t = 1) => { const o = d.push(), a = d.arr; a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = yaw; a[o + 4] = sx; a[o + 5] = sy; a[o + 6] = sz; a[o + 7] = t; a[o + 8] = t; a[o + 9] = t; };
    if (woodPoly.length) for (let x = -HW; x < HW; x += 9) for (let z = -HD; z < HD; z += 9) {
      const jx = x + (hash(Math.round(x), Math.round(z)) - 0.5) * 8, jz = z + (hash(Math.round(z), Math.round(x)) - 0.5) * 8;
      if (!inside(jx, jz, woodPoly) || this.nearTrench(jx, jz, 3)) continue;
      const toLine = this.distToGermanFront(jx, jz), shattered = hash(Math.round(jx * 7), 3) < Math.max(0.15, 1 - toLine / 500);
      if (shattered) put(this.stumps, jx, this.groundAt(jx, jz), jz, hash(Math.round(jx), 9) * 6, 2.5, 2 + hash(Math.round(jz), 4) * 5, 2.5, 0.9);
      else { const h = 9 + hash(Math.round(jx), Math.round(jz)) * 7; put(this.trees, jx, this.groundAt(jx, jz), jz, jx, h * 0.42, h, h * 0.42, 0.85 + hash(Math.round(jz), 2) * 0.25); }
    }
    // wire: German belts in front of their front line, British in front of theirs
    const front = (thiepval.front as XZ[]).map(p => [p[0] - CX, p[1] - CZ] as XZ);
    const wire = (P: XZ[], dist: number, towardBrit: boolean) => {
      for (let i = 1; i < P.length; i++) {
        const [ax, az] = P[i - 1], [bx, bz] = P[i], L = Math.hypot(bx - ax, bz - az); let nx2 = -(bz - az) / L, nz2 = (bx - ax) / L;
        const mid = { x: (ax + bx) / 2 + CX, z: (az + bz) / 2 + CZ }, q = project(pts(GEO.britishFront), mid);
        if (((q.x - mid.x) * nx2 + (q.z - mid.z) * nz2 > 0) !== towardBrit) { nx2 = -nx2; nz2 = -nz2; }
        for (let s = 0; s < L; s += 3.5) for (const row of [0, 4, 8]) {
          const x = ax + (bx - ax) * s / L + nx2 * (dist + row), z = az + (bz - az) * s / L + nz2 * (dist + row);
          if (!this.inBounds(x, z)) continue;
          const y = this.groundAt(x, z); put(this.postData, x, y, z, 0.3, 1, 1.2, 1);
          const x2 = x + (bx - ax) / L * 3.5, z2 = z + (bz - az) / L * 3.5, y2 = this.groundAt(x2, z2);
          this.wireLines.push(x, y + 0.9, z, 0.12, 0.12, 0.12, 0.7, x2, y2 + 0.5, z2, 0.12, 0.12, 0.12, 0.7, x, y + 0.4, z, 0.12, 0.12, 0.12, 0.7, x2, y2 + 1.0, z2, 0.12, 0.12, 0.12, 0.7);
        }
      }
    };
    wire(front, 16, true);
    const bf = pts(GEO.britishFront).filter(p => p.x > SECTOR.x0 && p.x < SECTOR.x1 && p.z > SECTOR.z0 && p.z < SECTOR.z1).map(p => [p.x - CX, p.z - CZ] as XZ);
    if (bf.length > 1) wire(bf, 14, false);
  }
  private hgt = new Float32Array(); private nx = 1; private nz = 1;
  /** drawn ground height (bilinear on the mesh grid, including shell holes) */
  groundAt(x: number, z: number) {
    if (!this.hgt.length) return this.heightAt(x, z);
    const fx = Math.max(0, Math.min(this.nx - 1.001, (x + HW) / RES)), fz = Math.max(0, Math.min(this.nz - 1.001, (z + HD) / RES)), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, n = this.nx;
    const h = this.hgt; return (h[j * n + i] * (1 - u) + h[j * n + i + 1] * u) * (1 - v) + (h[(j + 1) * n + i] * (1 - u) + h[(j + 1) * n + i + 1] * u) * v;
  }
  private tex(src: HTMLCanvasElement, mip: boolean) {
    const gl = this.gl, t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    if (mip) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); const e = gl.getExtension('EXT_texture_filter_anisotropic'); if (e) gl.texParameterf(gl.TEXTURE_2D, e.TEXTURE_MAX_ANISOTROPY_EXT, 8); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  private gkey(x: number, z: number) { return Math.floor((x + 2000) / 20) * 1000 + Math.floor((z + 2000) / 20); }
  /** nearest trench sample within r metres (optionally German only), or -1 */
  private nearestTrench(x: number, z: number, r: number, german?: boolean) {
    let best = -1, bd = r * r; const g = Math.ceil(r / 20);
    const gx = Math.floor((x + 2000) / 20), gz = Math.floor((z + 2000) / 20);
    for (let a = gx - g; a <= gx + g; a++) for (let c = gz - g; c <= gz + g; c++) {
      const L = this.grid.get(a * 1000 + c); if (!L) continue;
      for (const i of L) { if (german !== undefined && !!this.tl.german[i] !== german) continue; const d = (this.tl.x[i] - x) ** 2 + (this.tl.z[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    return best;
  }
  private nearTrench(x: number, z: number, r: number) { return this.nearestTrench(x, z, r) >= 0; }
  private distToGermanFront(x: number, z: number) { let d = Infinity; for (const p of thiepval.front as XZ[]) d = Math.min(d, Math.hypot(p[0] - CX - x, p[1] - CZ - z)); return d; }
  /** a point k metres along the trench from sample i (staying on the same line) */
  private along(i: number, k: number) {
    const L = this.tl.line[i]; let j = i; const step = k > 0 ? 1 : -1;
    for (let n = 0; n < Math.abs(k); n++) { const nj = j + step; if (nj < 0 || nj >= this.tl.x.length || this.tl.line[nj] !== L) break; j = nj; }
    return j;
  }

  // ---------------- the recorded battle as men ----------------
  private losses(i: number) {
    let L = this.loss.get(i); const done = this.b.done, R = this.b.rec;
    if (L && L.done === done) return L;
    const men = (m: number) => R.men[m * R.nStrip + i];
    const n0 = men(0), rank = new Int16Array(n0), death = new Float32Array(n0).fill(Infinity);
    for (let j = 0; j < n0; j++) rank[j] = j;
    for (let j = n0 - 1; j > 0; j--) { const k = Math.floor(hash(i, j) * (j + 1)); const t = rank[j]; rank[j] = rank[k]; rank[k] = t; }
    let level = n0 - 1, prev = n0;
    for (let m = 0; m <= done && level >= 0; m++) { const v = men(m); while (level >= 0 && v <= level) { death[level] = m > 0 ? m - 1 + (prev - level) / Math.max(1e-6, prev - v) : 0; level--; } prev = v; }
    L = { done, n0, rank, death }; this.loss.set(i, L); return L;
  }
  private put(x: number, y: number, z: number, yaw: number, german: boolean, pose: number, ph: number, t: number) {
    const o = this.dMan.push(), a = this.dMan.arr, u = german ? UNIFORM.german : UNIFORM.british;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = yaw;
    a[o + 4] = u.tunic[0]; a[o + 5] = u.tunic[1]; a[o + 6] = u.tunic[2]; a[o + 7] = u.legs[0]; a[o + 8] = u.legs[1]; a[o + 9] = u.legs[2];
    a[o + 10] = u.helmet[0]; a[o + 11] = u.helmet[1]; a[o + 12] = u.helmet[2]; a[o + 13] = u.skin[0]; a[o + 14] = u.skin[1]; a[o + 15] = u.skin[2];
    a[o + 16] = ph; a[o + 17] = pose; a[o + 18] = t; a[o + 19] = 1;
    this.count++;
  }
  /** where man j of a company strip is at time t, in scene coordinates */
  private place(c: Battle['strips'][0], j: number, n0: number, t: number) {
    const st = this.bv.stripAt(c.id, t), h1 = hash(c.id, j * 3 + 1), h2 = hash(c.id, j * 3 + 2), row = j % 3;
    let along = ((j + 0.5) / n0 - 0.5) * c.len * 0.92 + (h1 - 0.5) * 2, across = 0, pose = POSE.walk, back = false, inTrench = false;
    switch (st.state) {
      case ST.wait: case ST.home: pose = POSE.stand; inTrench = true; break;
      case ST.hold: case ST.mop: pose = POSE.aim; inTrench = true; break;
      case ST.advance: across = -row * 18 + (h2 - 0.5) * 4; break;
      case ST.assault: pose = POSE.run; across = -row * 5 + (h2 - 0.5) * 3; break;
      case ST.halted: pose = POSE.kneel; across = -row * 10 + (h2 - 0.5) * 4; break;
      case ST.pinned: case ST.spent: pose = POSE.down; across = (h2 - 0.5) * 40; along += (h1 - 0.5) * 8; break;
      case ST.retire: back = true; across = (h2 - 0.5) * 30; break;
    }
    const w = this.b.world(c.s + along, st.depth + across);
    let x = w.x - CX, z = w.z - CZ, y: number;
    let yaw = Math.atan2(w.ax, w.az); if (back) yaw += Math.PI;
    if (inTrench) {
      const k = this.nearestTrench(x, z, 22);
      if (k >= 0) { const q = this.along(k, Math.round((h1 - 0.5) * 3)); x = this.tl.x[q]; z = this.tl.z[q]; y = this.groundAt(x, z) - DEPTH + (pose === POSE.aim ? FIRESTEP : 0); }
      else y = this.groundAt(x, z);
    } else y = this.groundAt(x, z);
    return { x, y, z, yaw, pose };
  }
  /** the trench sample a German section's men stand along */
  private snapSection(sid: number) {
    let k = this.sectionSnap.get(sid);
    if (k === undefined) { const s = this.b.secs[sid], c = this.b.cells[s.cell], w = this.b.world(c.s, s.depth); k = this.nearestTrench(w.x - CX, w.z - CZ, 70, true); this.sectionSnap.set(sid, k); }
    return k;
  }

  private figures(t: number, anim: number, playing: boolean) {
    const b = this.b; this.dMan.reset(); this.count = 0;
    if (b.done < 0) return;
    const tm = t - T0, budget = 16000;
    const inWin = (x: number, z: number) => Math.abs(x) < HW + 60 && Math.abs(z) < HD + 60;
    for (const c of b.strips) {
      const p0 = b.world(c.s, this.bv.stripAt(c.id, t).depth); if (!inWin(p0.x - CX, p0.z - CZ)) continue;
      const L = this.losses(c.id), alive = this.bv.stripAt(c.id, t).men;
      for (let j = 0; j < L.n0 && this.count < budget; j++) {
        const rk = L.rank[j], dt = L.death[rk];
        if (rk < alive - 0.5 || dt > tm) {
          const P = this.place(c, j, L.n0, t);
          this.put(P.x, P.y, P.z, P.yaw, false, P.pose, anim * (P.pose === POSE.run ? 9 : 6) + hash(c.id, j) * 6.3, P.pose === POSE.down ? 1 : 0);
          if (playing && P.pose === POSE.aim && Math.random() < 0.003) this.flash(P.x + Math.sin(P.yaw) * 0.9, P.y + 1.45, P.z + Math.cos(P.yaw) * 0.9, 0.5);
        } else {
          const P = this.place(c, j, L.n0, T0 + dt);
          this.put(P.x, P.y, P.z, P.yaw + hash(j, 3) * 1.5 - 0.75, false, POSE.down, 0, 1);
        }
      }
    }
    const m0 = Math.max(0, Math.min(b.done, Math.floor(tm))), R = b.rec, nS = R.nSec;
    for (const s of b.secs) {
      const c = b.cells[s.cell], w = b.world(c.s, s.depth); if (!inWin(w.x - CX, w.z - CZ)) continue;
      const k0 = this.snapSection(s.id); if (k0 < 0) continue;
      const own = R.owner[m0 * nS + s.id], gm = R.gm[m0 * nS + s.id], yaw = Math.atan2(-w.ax, -w.az);
      if (!own) {
        const firing = playing && t >= s.lift && t > ZERO;
        for (let k = 0; k < gm && this.count < budget; k++) {
          const q = this.along(k0, Math.round(((k + 0.5) / Math.max(gm, 8) - 0.5) * CELL * 0.9));
          const x = this.tl.x[q], z = this.tl.z[q], y = this.groundAt(x, z) - DEPTH + FIRESTEP;
          this.put(x, y, z, yaw, true, POSE.aim, 0, 0);
          if (firing && Math.random() < 0.004) this.flash(x + Math.sin(yaw) * 0.9, y + 1.45, z + Math.cos(yaw) * 0.9, 0.5);
        }
        if (gm > 2 && s.mg >= 0.5 && firing) for (let g = 0; g < Math.round(s.mg); g++) { if (Math.random() < 0.3) { const q = this.along(k0, (g - (s.mg - 1) / 2) * 25), x = this.tl.x[q], z = this.tl.z[q]; this.flash(x + Math.sin(yaw), this.groundAt(x, z) + 0.2, z + Math.cos(yaw), 0.9); } }
      }
      // German dead, from the garrison's recorded losses
      let dead = 0; for (let m = 1; m <= m0; m++) { const o0 = R.owner[(m - 1) * nS + s.id], o1 = R.owner[m * nS + s.id], g0 = R.gar[(m - 1) * nS + s.id], g1 = R.gar[m * nS + s.id]; if (!o0 && !o1) dead += Math.max(0, g0 - g1); else if (!o0 && o1) dead += g0 * 0.3; }
      for (let k = 0; k < Math.min(40, Math.floor(dead)) && this.count < budget; k++) {
        const q = this.along(k0, Math.round((hash(s.id, k + 99) - 0.5) * CELL * 0.9)), x = this.tl.x[q], z = this.tl.z[q];
        this.put(x, this.groundAt(x, z) - DEPTH, z, hash(k, s.id) * 6.3, true, POSE.down, 0, 1);
      }
    }
  }

  // ---------------- effects ----------------
  private spawn(p: Partial<Particle> & { x: number; y: number; z: number }) { if (this.particles.length > 7000) return; this.particles.push({ vx: 0, vy: 0, vz: 0, size: 1, grow: 0, r: 1, g: 1, b: 1, a: 1, emissive: false, life: 1, age: 0, drag: 0, grav: 0, ...p }); }
  private flash(x: number, y: number, z: number, size: number) { this.spawn({ x, y, z, size, r: 1, g: 0.85, b: 0.5, emissive: true, life: 0.06 }); }
  private shell(x: number, z: number, big = 1) {
    const y = this.groundAt(x, z), rnd = Math.random;
    this.spawn({ x, y: y + 1.5, z, size: 14 * big, r: 1, g: 0.75, b: 0.4, emissive: true, life: 0.18, grow: -40 });
    for (let i = 0; i < 9; i++) this.spawn({ x, y: y + 1, z, vx: (rnd() - 0.5) * 8, vy: 9 + rnd() * 9, vz: (rnd() - 0.5) * 8, size: 2.2 * big, grow: 1, r: i % 3 ? 0.36 : 0.75, g: i % 3 ? 0.3 : 0.72, b: i % 3 ? 0.22 : 0.64, a: 0.95, life: 1.6, grav: 14, drag: 0.4 });
    for (let i = 0; i < 6; i++) this.spawn({ x: x + (rnd() - 0.5) * 3, y: y + 2 + i * 0.8, z: z + (rnd() - 0.5) * 3, vx: 0.6 + (rnd() - 0.5), vy: 1.2 + rnd(), vz: (rnd() - 0.5), size: 5 * big, grow: 2.2, r: 0.42, g: 0.4, b: 0.37, a: 0.55, life: 7 + rnd() * 4, drag: 0.2 });
  }
  private shrapnel(x: number, z: number) {
    const y = this.groundAt(x, z) + 14 + Math.random() * 8, rnd = Math.random;
    this.spawn({ x, y, z, size: 6, r: 1, g: 0.9, b: 0.7, emissive: true, life: 0.12, grow: -30 });
    for (let i = 0; i < 5; i++) this.spawn({ x: x + (rnd() - 0.5) * 2, y: y + (rnd() - 0.5) * 2, z: z + (rnd() - 0.5) * 2, vx: 0.5 + (rnd() - 0.5), vy: 0.3, vz: rnd() - 0.5, size: 4, grow: 1.6, r: 0.9, g: 0.9, b: 0.88, a: 0.6, life: 6 + rnd() * 3, drag: 0.3 });
  }
  private effects(t: number, dt: number, playing: boolean) {
    if (!playing) return;
    const b = this.b, rnd = Math.random;
    // the British barrage: on each German trench until its lift
    const targets: number[] = [];
    if (t >= 6 * 60) for (const s of b.secs) { if (t >= s.lift || t > s.lift + 1) continue; const k = this.snapSection(s.id); if (k >= 0) targets.push(k); }
    const brit = (t < 6 * 60 + 25 ? 3 : t < ZERO ? 14 : 8) * dt;
    for (let n = brit; n > 0; n--) { if (!targets.length || (n < 1 && rnd() > n)) break; const k = targets[Math.floor(rnd() * targets.length)]; const x = this.tl.x[k] + (rnd() - 0.5) * 30, z = this.tl.z[k] + (rnd() - 0.5) * 30; rnd() < 0.25 ? this.shrapnel(x, z) : this.shell(x, z, 1.2); }
    // the German barrage on no man's land and the British trenches
    const cell = b.cells.find(c => c.div === SECTOR.division)!, A = b.gerArt(cell, t);
    for (let n = A * 9 * dt; n > 0; n--) { if (n < 1 && rnd() > n) break; const c = b.cells[125 + Math.floor(rnd() * 11)], w = b.world(c.s + (rnd() - 0.5) * CELL, -300 + rnd() * (c.w + 250)); const x = w.x - CX, z = w.z - CZ; if (this.inBounds(x, z)) rnd() < 0.3 ? this.shrapnel(x, z) : this.shell(x, z); }
    // flares after dark
    if (t > 21 * 60 + 15 && rnd() < dt * 0.6) { const k = Math.floor(rnd() * this.tl.x.length); this.spawn({ x: this.tl.x[k], y: this.groundAt(this.tl.x[k], this.tl.z[k]) + 2, z: this.tl.z[k], vx: (rnd() - 0.5) * 2, vy: 26, vz: (rnd() - 0.5) * 2, size: 2.4, r: 1, g: 1, b: 0.85, emissive: true, life: 7, grav: 6, drag: 0.15 }); }
  }
  private stepParticles(dt: number) {
    const out = this.pts; let n = 0; const live: Particle[] = [];
    for (const p of this.particles) {
      p.age += dt; if (p.age >= p.life) continue;
      p.vy -= p.grav * dt; const k = Math.exp(-p.drag * dt); p.vx *= k; p.vy *= k; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.size = Math.max(0.05, p.size + p.grow * dt);
      live.push(p); if (n >= 11999) continue;
      const f = 1 - p.age / p.life, o = n * 8;
      out[o] = p.x; out[o + 1] = p.y; out[o + 2] = p.z; out[o + 3] = p.size; out[o + 4] = p.r; out[o + 5] = p.g; out[o + 6] = p.b; out[o + 7] = p.emissive ? 2 + Math.min(1, f * 1.5) : p.a * Math.min(1, f * 1.6);
      n++;
    }
    this.particles = live; return n;
  }

  // ---------------- frame ----------------
  /** light for the time of day (British clocks an hour ahead of GMT) */
  private light(tm: number) {
    const ha = ((tm - 60 + 11) - 720) / 4 * Math.PI / 180, dec = 23.1 * Math.PI / 180, lat = 50.06 * Math.PI / 180;
    const e = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
    const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI;
    const ce = Math.cos(Math.max(e, 0.05)), sun = [Math.sin(az) * ce, Math.max(Math.sin(e), 0.05), -Math.cos(az) * ce];
    const d = Math.max(0, Math.min(1, (e * 180 / Math.PI + 4) / 12)), warm = 1 - Math.min(1, Math.max(0, e * 180 / Math.PI / 25));
    const mix = (a: number[], b: number[], f: number) => a.map((v, i) => v + (b[i] - v) * f);
    return { sun, d, sunCol: mix([0.2, 0.23, 0.32], mix([0.95, 0.88, 0.75], [1.0, 0.7, 0.45], warm), d), skyCol: mix([0.16, 0.18, 0.27], [0.55, 0.58, 0.64], d), gndCol: mix([0.08, 0.08, 0.1], [0.38, 0.35, 0.3], d), fogA: mix([0.05, 0.06, 0.09], [0.68, 0.7, 0.72], d), fogS: mix([0.07, 0.07, 0.1], mix([0.86, 0.8, 0.7], [0.95, 0.72, 0.5], warm), d) };
  }
  render(t: number, dt: number, anim: number, playing: boolean) {
    const gl = this.gl, cv = this.canvas, cam = this.cam;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cam.update(dt, W, H);
    this.effects(t, dt, playing);
    this.figures(t, anim, playing);
    const L = this.light(t);
    gl.viewport(0, 0, W, H); gl.clearColor(L.fogA[0], L.fogA[1], L.fogA[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.depthMask(true);
    const setLit = (u: U) => {
      gl.uniformMatrix4fv(u.uVP, false, cam.vp); gl.uniform3f(u.uSun, L.sun[0], L.sun[1], L.sun[2]); gl.uniform3f(u.uCam, cam.ex, cam.ey, cam.ez);
      gl.uniform3fv(u.uSunCol, L.sunCol); gl.uniform3fv(u.uSkyCol, L.skyCol); gl.uniform3fv(u.uGndCol, L.gndCol);
      gl.uniform3fv(u.uFogSun, L.fogS); gl.uniform3fv(u.uFogAway, L.fogA); gl.uniform1f(u.uFogDen, 0.0009); gl.uniform1f(u.uHazeY, 60);
      gl.uniform1i(u.uShadow, 3); gl.uniform1f(u.uShadowOn, 0); gl.uniform1f(u.uTexel, 1);
    };
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.dummyShadow); gl.activeTexture(gl.TEXTURE0);
    // sky
    gl.depthMask(false); gl.useProgram(this.pS); setLit(this.uS); gl.uniformMatrix4fv(this.uS.uInvVP, false, cam.inv); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.depthMask(true);
    // ground with the trenches cut out, then the trench walls
    gl.enable(gl.CULL_FACE);
    gl.useProgram(this.pG); setLit(this.uG);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.colTex); gl.uniform1i(this.uG.uCol, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.maskTex); gl.uniform1i(this.uG.uMask, 1); gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.ground.vao); gl.drawElements(gl.TRIANGLES, this.ground.count, this.ground.indexType, 0);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.pV); setLit(this.uV); gl.bindVertexArray(this.walls.vao); gl.drawElements(gl.TRIANGLES, this.walls.count, this.walls.indexType, 0);
    // trees, stumps, wire pickets
    gl.useProgram(this.pP); setLit(this.uP); gl.uniform1f(this.uP.uAlpha, 1);
    drawInstanced(gl, this.tree, this.trees, false); drawInstanced(gl, this.stump, this.stumps, false); drawInstanced(gl, this.posts, this.postData, false);
    // soldiers
    gl.useProgram(this.pF); setLit(this.uF); drawInstanced(gl, this.man, this.dMan);
    // wire strands
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.wireLines.length) { gl.useProgram(this.pL); gl.uniformMatrix4fv(this.uL.uVP, false, cam.vp); gl.bindVertexArray(this.lineVAO); gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf); if (!this.wireUp) { gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.wireLines), gl.STATIC_DRAW); this.wireUp = true; } gl.drawArrays(gl.LINES, 0, this.wireLines.length / 7); }
    // smoke, dust, flashes
    const n = this.stepParticles(dt);
    if (n) {
      gl.depthMask(false); gl.useProgram(this.pPt); setLit(this.uPt); gl.uniform1f(this.uPt.uScale, H / (2 * Math.tan(cam.fov / 2)));
      gl.bindVertexArray(this.pointVAO); gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf); gl.bufferData(gl.ARRAY_BUFFER, this.pts.subarray(0, n * 8), gl.DYNAMIC_DRAW); gl.drawArrays(gl.POINTS, 0, n);
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
  }
  private wireUp = false;

  // ---------------- input ----------------
  attachInput() {
    const cv = this.canvas, cam = this.cam, ptrs = new Map<number, { x: number; y: number }>();
    let rot = false, pinch: { d: number; a: number; cy: number } | null = null;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); rot = e.button === 2 || e.shiftKey || e.ctrlKey; pinch = null; });
    cv.addEventListener('pointermove', e => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 1) { if (rot) { cam.rotate(-dx * 0.005); cam.tilt(dy * 0.004); } else cam.pan(-dx / cv.clientHeight * 1.1, -dy / cv.clientHeight * 1.1); }
      else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(b.x - a.x, b.y - a.y), an = Math.atan2(b.y - a.y, b.x - a.x), cy = (a.y + b.y) / 2; if (pinch) { cam.zoom(pinch.d / d); cam.rotate(-(an - pinch.a)); cam.tilt((cy - pinch.cy) * 0.004); } pinch = { d, a: an, cy }; }
    });
    const up = (e: PointerEvent) => { ptrs.delete(e.pointerId); pinch = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', e => { e.preventDefault(); cam.zoom(Math.exp(e.deltaY * 0.0015)); }, { passive: false });
  }
  /** keyboard movement while the 3D view is open */
  keys(k: Set<string>, dt: number) {
    const cam = this.cam, s = dt * 0.8;
    if (k.has('w') || k.has('arrowup')) cam.pan(0, s); if (k.has('s') || k.has('arrowdown')) cam.pan(0, -s);
    if (k.has('a') || k.has('arrowleft')) cam.pan(-s, 0); if (k.has('d') || k.has('arrowright')) cam.pan(s, 0);
    if (k.has('q')) cam.rotate(dt); if (k.has('e')) cam.rotate(-dt);
    if (k.has('r')) cam.tilt(-dt * 0.7); if (k.has('f')) cam.tilt(dt * 0.7);
    if (k.has('=') || k.has('+')) cam.zoom(Math.exp(-dt * 1.5)); if (k.has('-')) cam.zoom(Math.exp(dt * 1.5));
  }
}
