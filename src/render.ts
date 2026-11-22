// WebGL2 renderer for the whole-front map: terrain from the elevation data, painted with a map texture
// (fields, woods, villages, the Ancre, roads, trench systems), front lines as screen-width ribbons,
// battalion blocks, crater decals and point effects (shell bursts, mine explosions, flares).
import { createProgram, uniforms } from './render/gl';
import { mat4, perspective, lookAt, multiply, invert, transformPoint, clamp } from './core/math';
import { GEO, Dem, toXZ, toLL, pts, resample, offsetAway, type P, type LL } from './geo';
import type { Battalion } from './units';
import { trenchRuns, styled, insideSheets, SHEETS, FIRE, type Run } from './trenches';

const TEX = 4096;

// ---------------- shaders ----------------
const TERRAIN_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aN; layout(location=2) in vec2 aUV;
uniform mat4 uVP; out vec3 vPos; out vec3 vN; out vec2 vUV;
void main(){ vPos=aPos; vN=aN; vUV=aUV; gl_Position=uVP*vec4(aPos,1.0); }`;
const TERRAIN_FS = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vN; in vec2 vUV; uniform sampler2D uTex; uniform vec3 uSun, uSunCol, uSky, uCam, uFog; uniform float uFogDen, uContour;
uniform sampler2D uDetail, uMap; uniform vec4 uDB; uniform vec4 uHoles[8]; uniform float uDetailOn, uMapOn; uniform vec3 uMapA, uMapB; uniform vec4 uMapFrame;
out vec4 o;
void main(){
  for (int i = 0; i < 8; i++) if (uHoles[i].w > 0.0 && distance(vPos.xz, uHoles[i].xy) < uHoles[i].z) discard;   // mine craters
  vec3 base = texture(uTex, vUV).rgb;
  if (uDetailOn > 0.0) {
    vec2 du = (vPos.xz - uDB.xy) / (uDB.zw - uDB.xy);
    if (du.x > 0.0 && du.y > 0.0 && du.x < 1.0 && du.y < 1.0) { vec4 dt = texture(uDetail, du); base = mix(base, dt.rgb, dt.a * uDetailOn); }
  }
  if (uMapOn > 0.0) {
    vec2 mu = vec2(dot(uMapA, vec3(vPos.xz, 1.0)), dot(uMapB, vec3(vPos.xz, 1.0)));
    if (mu.x > uMapFrame.x && mu.y > uMapFrame.y && mu.x < uMapFrame.z && mu.y < uMapFrame.w) base = mix(base, texture(uMap, mu).rgb, uMapOn);
  }
  float h = vPos.y / 10.0; float fw = fwidth(h);
  float c = 1.0 - smoothstep(0.0, 1.2, abs(fract(h + 0.5) - 0.5) / max(fw, 1e-4));
  base *= 1.0 - c * 0.16 * uContour * (1.0 - smoothstep(0.06, 0.25, fw));
  vec3 n = normalize(vN);
  float dif = max(dot(n, uSun), 0.0);
  vec3 col = base * (uSunCol * dif + uSky * (0.55 + 0.45 * n.y));
  float d = length(vPos - uCam);
  col = mix(col, uFog, 1.0 - exp(-d * uFogDen));
  o = vec4(col, 1.0);
}`;
const RIBBON_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aDir; layout(location=2) in float aSide; layout(location=3) in float aU;
uniform mat4 uVP; uniform vec3 uCam; uniform float uPx, uWidth, uLift;
out float vU; out float vSide; out float vPxM;
void main(){
  float d = length(aPos - uCam);
  float m = d * uPx;                           // metres per pixel at this distance
  vec3 p = aPos + vec3(aDir.x, 0.0, aDir.y) * aSide * uWidth * 0.5 * m;
  p.y += uLift + m * 1.5;
  vU = aU; vSide = aSide; vPxM = m;
  gl_Position = uVP * vec4(p, 1.0);
  gl_Position.z -= 0.0015 * gl_Position.w;
}`;
const RIBBON_FS = `#version 300 es
precision highp float;
in float vU; in float vSide; in float vPxM; uniform vec4 uColor; uniform float uDash; out vec4 o;
void main(){
  float a = 1.0 - smoothstep(0.6, 1.0, abs(vSide));
  if (uDash > 0.0) { float k = fract(vU / (uDash * vPxM)); if (k > 0.55) discard; }
  o = vec4(uColor.rgb, uColor.a * (0.35 + 0.65 * a));
}`;
const FIG_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aN; layout(location=2) in float aPart;
layout(location=3) in vec4 iPY; layout(location=4) in vec4 iPS;
uniform mat4 uVP; uniform float uSwing;
out vec3 vN; out vec3 vCol; out vec3 vW;
mat3 rx(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
void main(){
  vec3 p = aPos, n = aN;
  if (aPart > 0.5 && uSwing > 0.0) {
    float side = aPart < 1.5 ? 1.0 : (aPart < 2.5 ? -1.0 : 0.0);
    float a = aPart > 2.5 ? -0.5 * sin(iPS.x) * uSwing : sin(iPS.x) * uSwing * side;
    vec3 piv = aPart > 2.5 ? vec3(0., 1.4, 0.) : vec3(0., 0.85, 0.);
    p = rx(a) * (p - piv) + piv; n = rx(a) * n;
  }
  p *= iPS.y;
  float c = cos(iPY.w), s = sin(iPY.w);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); n = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  vec3 w = p + iPY.xyz; vW = w; vN = n;
  // colour: instance base; helmets and boots darker, by height in the model
  float k = aPart > 3.5 ? 0.55 : 1.0;
  vCol = vec3(fract(iPS.z), fract(iPS.z * 256.0), fract(iPS.w)) * k;
  vCol = mix(vCol, vec3(0.16, 0.13, 0.1), step(4.5, aPart));
  gl_Position = uVP * vec4(w, 1.0);
}`;
const FIG_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vCol; in vec3 vW; uniform vec3 uSun, uSunCol, uSky, uCam, uFog; uniform float uFogDen; out vec4 o;
void main(){
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; float dif = max(dot(n, uSun), 0.0);
  vec3 col = vCol * 1.25 * (uSunCol * dif * 1.15 + uSky * (0.85 + 0.35 * n.y) + 0.15);
  col = mix(col, uFog, 1.0 - exp(-length(vW - uCam) * uFogDen));
  o = vec4(col, 1.0);
}`;
const BLOCK_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; layout(location=2) in vec4 aCol; layout(location=3) in float aShape;
uniform mat4 uVP; out vec2 vUV; out vec4 vCol; out float vShape;
void main(){ vUV=aUV; vCol=aCol; vShape=aShape; gl_Position=uVP*vec4(aPos,1.0); gl_Position.z -= 0.001*gl_Position.w; }`;
const BLOCK_FS = `#version 300 es
precision highp float;
in vec2 vUV; in vec4 vCol; in float vShape; out vec4 o;
void main(){
  vec2 q = vUV * 2.0 - 1.0;
  if (vShape > 0.5) { float r = length(q); if (r > 1.0) discard; o = vec4(vCol.rgb * (0.6 + 0.4 * r), vCol.a); return; }
  vec2 e = 1.0 - abs(q); vec2 fw = fwidth(q) * 2.5;
  float edge = 1.0 - min(smoothstep(0.0, fw.x, e.x), smoothstep(0.0, fw.y, e.y));
  o = vec4(mix(vCol.rgb, vCol.rgb * 0.35, edge), vCol.a);
}`;
// mine craters: a lit mesh with a bowl below ground (the terrain is cut away over it) and a raised lip
const CRATER_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aN; layout(location=2) in vec4 aCol;
uniform mat4 uVP; out vec3 vPos; out vec3 vN; out vec4 vCol;
void main(){ vPos = aPos; vN = aN; vCol = aCol; gl_Position = uVP * vec4(aPos, 1.0); gl_Position.z -= 0.0004 * gl_Position.w; }`;
const CRATER_FS = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vN; in vec4 vCol; uniform vec3 uSun, uSunCol, uSky, uCam, uFog; uniform float uFogDen; out vec4 o;
void main(){
  vec3 n = normalize(vN);                       // normals already point up out of the ground
  vec3 c = vCol.rgb * (uSunCol * max(dot(n, uSun), 0.0) + uSky * (0.55 + 0.45 * n.y));
  o = vec4(mix(c, uFog, 1.0 - exp(-length(vPos - uCam) * uFogDen)), vCol.a);
}`;
// trenches as geometry: world-width strips on the ground, never thinner than about a pixel
const TRENCH_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aN; layout(location=2) in float aSide; layout(location=3) in float aHalf; layout(location=4) in vec4 aCol; layout(location=5) in float aEnd;
uniform mat4 uVP; uniform vec3 uCam; uniform float uPx, uMinW, uLift; out vec4 vCol; out float vSide; out vec3 vW;
void main(){
  float m = length(aPos - uCam) * uPx;
  float h = max(aHalf, 0.5 * uMinW * m);
  vec3 p = aPos + (vec3(aN.x, 0.0, aN.y) * aSide + vec3(aN.y, 0.0, -aN.x) * aEnd) * h; p.y += 0.4 + m * 0.6;
  vCol = aCol; vSide = aSide; vW = p;
  float top = aHalf < 2.0 ? 1.0 : 0.0; p.y += top * (0.2 + m * 0.2) + uLift * (1.0 + m * 0.8);
  gl_Position = uVP * vec4(p, 1.0); gl_Position.z -= (0.0012 + top * 0.0004 + uLift * 0.0008) * gl_Position.w;
}`;
const TRENCH_FS = `#version 300 es
precision highp float;
in vec4 vCol; in float vSide; in vec3 vW; uniform vec3 uLight, uCam, uFog; uniform float uFogDen, uAlpha; uniform vec4 uHoles[8]; out vec4 o;
void main(){
  for (int i = 0; i < 8; i++) if (uHoles[i].w > 0.0 && distance(vW.xz, uHoles[i].xy) < uHoles[i].z * 1.3) discard;   // blown away by a mine
  float e = 1.0 - smoothstep(0.75, 1.0, abs(vSide));
  vec3 c = mix(vCol.rgb * uLight, uFog, 1.0 - exp(-length(vW - uCam) * uFogDen));
  o = vec4(c, vCol.a * uAlpha * (0.5 + 0.5 * e));
}`;
const POINT_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in float aSize; layout(location=2) in vec4 aCol;
uniform mat4 uVP; uniform vec3 uCam; uniform float uPx; out vec4 vCol;
void main(){ vCol=aCol; gl_Position=uVP*vec4(aPos,1.0); float m=length(aPos-uCam)*uPx; gl_PointSize=clamp(aSize/m, aCol.a>1.0?3.0:1.5, 220.0); }`;
const POINT_FS = `#version 300 es
precision highp float;
in vec4 vCol; out vec4 o;
void main(){ vec2 q=gl_PointCoord*2.0-1.0; float r=dot(q,q); if(r>1.0) discard;
  float glow = vCol.a > 1.0 ? 1.0 : 0.0; float a = (1.0 - r);
  o = glow > 0.5 ? vec4(vCol.rgb * (1.0 + a), min(1.0, (vCol.a - 1.0) * a * 1.6)) : vec4(vCol.rgb, vCol.a * a); }`;

export class Camera {
  tx = 0; tz = 0; ty = 0; dist = 26000; yaw = -0.75; pitch = 0.85;
  gx = 0; gz = 0; gdist = 26000; gyaw = -0.75; gpitch = 0.85;
  fov = 0.75; w = 1; h = 1;
  vp = mat4(); inv = mat4(); private view = mat4(); private proj = mat4();
  ex = 0; ey = 0; ez = 0;
  constructor(private dem: Dem) {}
  update(dt: number, w: number, h: number) {
    this.w = w; this.h = h;
    const k = 1 - Math.exp(-dt * 6);
    this.gx = clamp(this.gx, this.dem.minX, this.dem.maxX); this.gz = clamp(this.gz, this.dem.minZ, this.dem.maxZ);
    this.gdist = clamp(this.gdist, 120, 66000); this.gpitch = clamp(this.gpitch, 0.12, 1.5);
    this.tx += (this.gx - this.tx) * k; this.tz += (this.gz - this.tz) * k;
    this.dist *= Math.pow(this.gdist / this.dist, k);
    this.yaw += (this.gyaw - this.yaw) * k; this.pitch += (this.gpitch - this.pitch) * k;
    this.ty += (this.dem.height(this.tx, this.tz) - this.ty) * k;
    const cp = Math.cos(this.pitch);
    this.ex = this.tx + Math.sin(this.yaw) * cp * this.dist; this.ez = this.tz + Math.cos(this.yaw) * cp * this.dist;
    this.ey = Math.max(this.ty + Math.sin(this.pitch) * this.dist, this.dem.height(this.ex, this.ez) + 20);
    lookAt(this.view, this.ex, this.ey, this.ez, this.tx, this.ty, this.tz);
    perspective(this.proj, this.fov, w / Math.max(1, h), Math.max(5, this.dist * 0.01), this.dist * 6 + 30000);
    multiply(this.vp, this.proj, this.view); invert(this.inv, this.vp);
  }
  /** metres per pixel per metre of distance */
  get px() { return 2 * Math.tan(this.fov / 2) / Math.max(1, this.h); }
  project(x: number, y: number, z: number) {
    const v = transformPoint(this.vp, x, y, z, new Float32Array(4));
    if (v[3] <= 0.1) return null;
    const sx = (v[0] / v[3] * 0.5 + 0.5) * this.w, sy = (1 - (v[1] / v[3] * 0.5 + 0.5)) * this.h;
    return { x: sx, y: sy, d: v[3], on: sx > -60 && sx < this.w + 60 && sy > -40 && sy < this.h + 40 && v[2] / v[3] < 1 };
  }
  pick(sx: number, sy: number, dem: Dem): P | null {
    const nx = sx / this.w * 2 - 1, ny = 1 - sy / this.h * 2;
    const a = transformPoint(this.inv, nx, ny, -1, new Float32Array(4)), b = transformPoint(this.inv, nx, ny, 1, new Float32Array(4));
    const o = [a[0] / a[3], a[1] / a[3], a[2] / a[3]], e = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    let dx = e[0] - o[0], dy = e[1] - o[1], dz = e[2] - o[2]; const L = Math.hypot(dx, dy, dz); dx /= L; dy /= L; dz /= L;
    let s = 0, prev = 0, step = Math.max(5, this.dist * 0.004);
    for (let i = 0; i < 4000; i++) {
      const x = o[0] + dx * s, y = o[1] + dy * s, z = o[2] + dz * s;
      if (y < dem.height(x, z)) {
        let lo = prev, hi = s;
        for (let j = 0; j < 20; j++) { const m = (lo + hi) / 2; if (o[1] + dy * m < dem.height(o[0] + dx * m, o[2] + dz * m)) hi = m; else lo = m; }
        return { x: o[0] + dx * hi, z: o[2] + dz * hi };
      }
      prev = s; s += step; step *= 1.004;
      if (y < -100) break;
    }
    return null;
  }
}

interface Ribbon { vao: WebGLVertexArrayObject; n: number; color: [number, number, number, number]; width: number; dash: number; lift: number; minDist?: number; maxDist?: number }
export interface Burst { x: number; y: number; z: number; size: number; r: number; g: number; b: number; a: number; vy: number; grow: number; life: number; age: number; glow: boolean }

export class Renderer {
  gl: WebGL2RenderingContext;
  private pT: WebGLProgram; private uT: Record<string, WebGLUniformLocation | null>;
  private pR: WebGLProgram; private uR: Record<string, WebGLUniformLocation | null>;
  private pB: WebGLProgram; private uB: Record<string, WebGLUniformLocation | null>;
  private pP: WebGLProgram; private uP: Record<string, WebGLUniformLocation | null>;
  private pF!: WebGLProgram; private uF!: Record<string, WebGLUniformLocation | null>;
  private figMesh: { vao: WebGLVertexArrayObject; inst: WebGLBuffer; n: number }[] = [];
  /** per pose: instance data (x, y, z, yaw, phase, scale, colour-packed rg, colour b) and count */
  figs: { data: Float32Array; n: number }[] = [];
  private terrain!: { vao: WebGLVertexArrayObject; n: number; type: number };
  private tex!: WebGLTexture;
  private detail: { tex: WebGLTexture; box: number[] } | null = null;
  private pTr!: WebGLProgram; private uTr!: Record<string, WebGLUniformLocation | null>;
  private trMesh: { vao: WebGLVertexArrayObject; buf: WebGLBuffer; n: number } | null = null;
  private map: { tex: WebGLTexture; a: number[]; b: number[]; frame: number[] } | null = null;
  /** 0..1: how strongly the 1916 map is shown on the ground */
  mapOpacity = 0;
  private ribbons: Ribbon[] = [];
  private blocks!: { vao: WebGLVertexArrayObject; buf: WebGLBuffer; n: number; nBn: number };
  /** draw the static battalion start positions (off once companies are drawn from the battle) */
  showBattalions = true;
  private live: Ribbon[] = [];
  private liveBuf: WebGLBuffer[] = [];
  private flat = new Float32Array(10 * 6 * 6000); private flatN = 0;
  private dyn!: { vao: WebGLVertexArrayObject; buf: WebGLBuffer };
  private ptsVao!: WebGLVertexArrayObject; private ptsBuf!: WebGLBuffer; private ptsArr = new Float32Array(8 * 20000);
  bursts: Burst[] = [];
  /** fixed lines in local metres, kept for other modules */
  lines: Record<string, P[]> = {};

  constructor(public canvas: HTMLCanvasElement, private dem: Dem, units: Battalion[]) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('This browser does not support WebGL2.');
    this.gl = gl;
    gl.getExtension('OES_texture_float_linear');
    this.pT = createProgram(gl, TERRAIN_VS, TERRAIN_FS); this.uT = uniforms(gl, this.pT, ['uVP', 'uTex', 'uSun', 'uSunCol', 'uSky', 'uCam', 'uFog', 'uFogDen', 'uContour', 'uDetail', 'uMap', 'uDB', 'uDetailOn', 'uMapOn', 'uMapA', 'uMapB', 'uMapFrame', 'uHoles']);
    this.pR = createProgram(gl, RIBBON_VS, RIBBON_FS); this.uR = uniforms(gl, this.pR, ['uVP', 'uCam', 'uPx', 'uWidth', 'uLift', 'uColor', 'uDash']);
    this.pB = createProgram(gl, BLOCK_VS, BLOCK_FS); this.uB = uniforms(gl, this.pB, ['uVP']);
    this.pF = createProgram(gl, FIG_VS, FIG_FS); this.uF = uniforms(gl, this.pF, ['uVP', 'uSwing', 'uSun', 'uSunCol', 'uSky', 'uCam', 'uFog', 'uFogDen']);
    this.buildFigures();
    this.pP = createProgram(gl, POINT_VS, POINT_FS); this.uP = uniforms(gl, this.pP, ['uVP', 'uCam', 'uPx']);
    this.lines = {
      british: pts(GEO.britishFront), german: pts(GEO.germanFront), second: pts(GEO.germanSecond),
      french: pts(GEO.frenchSector), ancre: pts(GEO.ancre),
    };
    this.buildTerrain();
    this.buildTexture();
    this.buildRibbons();
    this.buildBlocks(units);
    this.dyn = this.makeBlockBuffer();
    this.ptsVao = gl.createVertexArray()!; this.ptsBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.ptsVao); gl.bindBuffer(gl.ARRAY_BUFFER, this.ptsBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.bindVertexArray(null);
  }

  // ---------- terrain ----------
  private buildTerrain() {
    const gl = this.gl, d = this.dem, R = d.rows, C = d.cols;
    const v = new Float32Array(R * C * 8);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const p = toXZ(d.llOf(r, c)), k = (r * C + c) * 8, h = d.h[r * C + c];
      const hl = d.h[r * C + Math.max(0, c - 1)], hr = d.h[r * C + Math.min(C - 1, c + 1)];
      const hu = d.h[Math.max(0, r - 1) * C + c], hd = d.h[Math.min(R - 1, r + 1) * C + c];
      const sx = (toXZ(d.llOf(r, Math.min(C - 1, c + 1))).x - toXZ(d.llOf(r, Math.max(0, c - 1))).x) || 1;
      const sz = (toXZ(d.llOf(Math.min(R - 1, r + 1), c)).z - toXZ(d.llOf(Math.max(0, r - 1), c)).z) || 1;
      let nx = -(hr - hl) / sx, nz = -(hd - hu) / sz, ny = 1; const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
      v.set([p.x, h, p.z, nx, ny, nz, (c + 0.5) / C, (r + 0.5) / R], k);
    }
    const idx = new Uint32Array((R - 1) * (C - 1) * 6); let i = 0;
    for (let r = 0; r + 1 < R; r++) for (let c = 0; c + 1 < C; c++) {
      const a = r * C + c, b = a + 1, e = a + C, f = e + 1;
      idx[i++] = a; idx[i++] = e; idx[i++] = b; idx[i++] = b; idx[i++] = e; idx[i++] = f;
    }
    const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    for (const [loc, size, off] of [[0, 3, 0], [1, 3, 3], [2, 2, 6]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 32, off * 4); }
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.terrain = { vao, n: idx.length, type: gl.UNSIGNED_INT };
  }

  // ---------- painted map texture ----------
  private buildTexture() {
    const cv = document.createElement('canvas'); cv.width = cv.height = TEX;
    this.paintMap(cv.getContext('2d')!, { trenches: true, fine: false });
    this.tex = this.upload(cv);
  }
  /** pixel position on the whole-front texture of a local point */
  texPx(x: number, z: number): [number, number] {
    const d = this.dem, ll = toLL(x, z);
    return [(ll[1] - d.west) / (d.cols * d.cell) * TEX, (d.north - ll[0]) / (d.rows * d.cell) * TEX];
  }
  /** paint the map in whole-front texture pixel space (the caller's canvas transform maps it to its own canvas).
   *  trenches: paint the trench systems; fine: metre-scale trenches, shell holes and trees for a detail patch */
  private paintMap(g: CanvasRenderingContext2D, o: { trenches: boolean; fine: boolean }) {
    const d = this.dem;
    // the part of the whole-front texture this canvas shows (with a margin): shapes outside it aren't drawn,
    // but the random sequence is kept so a patch matches the whole-front painting
    const IT = g.getTransform().inverse(), c0 = IT.transformPoint(new DOMPoint(0, 0)), c1 = IT.transformPoint(new DOMPoint(g.canvas.width, g.canvas.height));
    const vx0 = Math.min(c0.x, c1.x) - 30, vx1 = Math.max(c0.x, c1.x) + 30, vy0 = Math.min(c0.y, c1.y) - 30, vy1 = Math.max(c0.y, c1.y) + 30;
    const vis = (x: number, y: number, r: number) => x + r >= vx0 && x - r <= vx1 && y + r >= vy0 && y - r <= vy1;
    const north = d.north, west = d.west, latSpan = d.rows * d.cell, lonSpan = d.cols * d.cell;
    const P = (ll: LL): [number, number] => [(ll[1] - west) / lonSpan * TEX, (north - ll[0]) / latSpan * TEX];
    const Pm = (p: P) => P(toLL(p.x, p.z));
    const mPerPx = (lonSpan * 71500) / TEX;          // ~ 4.9 m per pixel
    const m = (metres: number) => metres / mPerPx;
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // fields: a patchwork of strips and blocks in summer greens and chalky browns
    g.fillStyle = '#8f9a5c'; g.fillRect(0, 0, TEX, TEX);
    const fieldCols = ['#93a05e', '#a3a865', '#879356', '#b2a86c', '#9aa25f', '#a99f63', '#8c9a5a', '#b8b076'];
    for (let k = 0; k < 2600; k++) {
      const x = rnd() * TEX, y = rnd() * TEX, rot = (rnd() - 0.5) * 0.5 + (rnd() < 0.5 ? 0 : Math.PI / 2), col = fieldCols[Math.floor(rnd() * fieldCols.length)], fw = m(150 + rnd() * 450), fh = m(60 + rnd() * 220);
      if (!vis(x, y, fw + fh)) continue;
      g.save(); g.translate(x, y); g.rotate(rot); g.fillStyle = col; g.globalAlpha = 0.75; g.fillRect(0, 0, fw, fh); g.restore();
    }
    g.globalAlpha = 1;
    // fine grain
    for (let k = 0; k < 90000; k++) { const c = rnd() < 0.5, x = rnd() * TEX, y = rnd() * TEX; if (!vis(x, y, 2)) continue; g.fillStyle = c ? 'rgba(60,60,30,0.08)' : 'rgba(230,220,170,0.08)'; g.fillRect(x, y, 2, 2); }
    const poly = (ll: LL[], close = true) => { g.beginPath(); ll.forEach((q, i) => { const [x, y] = P(q); i ? g.lineTo(x, y) : g.moveTo(x, y); }); if (close) g.closePath(); };
    const polyM = (p: P[], close = false) => { g.beginPath(); p.forEach((q, i) => { const [x, y] = Pm(q); i ? g.lineTo(x, y) : g.moveTo(x, y); }); if (close) g.closePath(); };
    const B = this.lines.british, G = this.lines.german;
    // ground cut up by shellfire: no man's land and the German trench zone
    const zoneBack = offsetAway(resample(G, 40), 650, B), britBack = offsetAway(resample(B, 40), 120, G);
    g.save();
    polyM([...britBack, ...[...zoneBack].reverse()], true); g.clip();
    for (let k = 0; k < 160000; k++) {
      const x = rnd() * TEX, y = rnd() * TEX, c = rnd() < 0.6, r = 1 + rnd() * m(9);
      if (o.fine || !vis(x, y, r)) continue;           // a close-up patch places its shell holes from the record instead
      g.fillStyle = c ? 'rgba(120,100,70,0.35)' : 'rgba(215,205,175,0.3)';
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    }
    g.restore();
    // woods
    for (const w of GEO.woods) {
      g.fillStyle = '#4f6236'; poly(w.poly); g.fill();
      g.save(); poly(w.poly); g.clip();
      for (let k = 0; k < 2500; k++) { const [x, y] = P(w.poly[0]), c = rnd() < 0.5, u = x + (rnd() - 0.5) * m(3000), v = y + (rnd() - 0.5) * m(3000), r = m(6 + rnd() * 8); if (!vis(u, v, r)) continue; g.fillStyle = c ? '#3d4f29' : '#5d7240'; g.beginPath(); g.arc(u, v, r, 0, 6.283); g.fill(); }
      g.restore();
    }
    // the Ancre and its marshes
    g.lineCap = 'round'; g.lineJoin = 'round';
    poly(GEO.ancre, false); g.strokeStyle = 'rgba(95,120,90,0.8)'; g.lineWidth = m(160); g.stroke();
    poly(GEO.ancre, false); g.strokeStyle = '#4f7f9c'; g.lineWidth = m(14); g.stroke();
    // roads
    for (const r of GEO.roads) { poly(r.pts, false); g.strokeStyle = '#d9cfae'; g.lineWidth = m(9); g.stroke(); }
    // villages: ruined houses round the centre
    for (const v of GEO.places) {
      const [cx, cy] = P(v.ll), big = v.name === 'Albert' ? 2.4 : 1;
      for (let k = 0; k < 70 * big; k++) {
        const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * m(260 * big);
        g.fillStyle = v.side === 'german' ? (rnd() < 0.5 ? '#8a7f70' : '#a2917c') : (rnd() < 0.5 ? '#8c7466' : '#9f8a76');
        g.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, m(12 + rnd() * 14), m(10 + rnd() * 12));
      }
    }
    if (o.fine) { this.paintFine(g, m, vis); return; }
    if (!o.trenches) return;
    // trenches: the traced German network, the British front and support, and schematic German lines where no
    // trench map has been traced. Fire trenches wider than communication trenches.
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const [kind, spoil, cut, col] of [[1, 2.4, 1.1, '#56473a'], [0, 3.4, 1.6, '#4a3a2e']] as [number, number, number, string][]) {
      const runs = this.trenchSet().filter(r => r.kind === kind);
      const path = () => { g.beginPath(); for (const r of runs) r.p.forEach((q, i) => { const [u, v] = Pm(q); i ? g.lineTo(u, v) : g.moveTo(u, v); }); };
      path(); g.strokeStyle = 'rgba(226,220,200,0.85)'; g.lineWidth = spoil; g.stroke();
      path(); g.strokeStyle = col; g.lineWidth = cut; g.stroke();
    }
  }

  private trenches: Run[] | null = null;
  /** every trench drawn on the map: traced German runs, British front and support, schematic lines off the sheets */
  trenchSet(): Run[] {
    if (this.trenches) return this.trenches;
    const out: Run[] = [...trenchRuns()];
    const B = this.lines.british, G = this.lines.german;
    out.push({ kind: FIRE, p: B }, { kind: FIRE, p: offsetAway(B, 160, G) });
    for (const line of [G, offsetAway(G, 140, B), offsetAway(G, 300, B), this.lines.second, offsetAway(this.lines.second, 130, B)]) {
      let cur: P[] = [];
      for (const q of resample(line, 20)) {
        if (insideSheets(q.x, q.z)) { if (cur.length > 1) out.push({ kind: FIRE, p: cur }); cur = []; } else cur.push(q);
      }
      if (cur.length > 1) out.push({ kind: FIRE, p: cur });
    }
    return (this.trenches = out);
  }

  /** craters for a patch, from the record of the bombardment: x, z, radius (m) triples; set by the app */
  craterSource: ((box: number[]) => Float32Array) | null = null;
  /** metre-scale extras for a close-up patch: grass, shell holes, tree crowns */
  private paintFine(g: CanvasRenderingContext2D, m: (metres: number) => number, vis: (x: number, y: number, r: number) => boolean) {
    let seed = 99; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const inv = g.getTransform().inverse(), a = inv.transformPoint(new DOMPoint(0, 0)), b = inv.transformPoint(new DOMPoint(g.canvas.width, g.canvas.height));
    const X0 = a.x, Y0 = a.y, SX = b.x - a.x, SY = b.y - a.y;              // the patch in whole-front texture px
    // grass and soil mottling
    for (let k = 0; k < 220000; k++) { g.fillStyle = rnd() < 0.5 ? 'rgba(60,70,30,0.10)' : 'rgba(235,225,180,0.10)'; g.fillRect(X0 + rnd() * SX, Y0 + rnd() * SY, m(0.8 + rnd()), m(0.8 + rnd())); }
    // shell holes where the record puts the bombardment
    if (this.craterSource && this.patchBox) {
      const C = this.craterSource(this.patchBox);
      for (let i = 0; i < C.length; i += 3) {
        const [x, y] = this.texPx(C[i], C[i + 1]), r = m(C[i + 2]);
        if (!vis(x, y, r * 1.6)) continue;
        g.fillStyle = 'rgba(205,195,165,0.4)'; g.beginPath(); g.arc(x, y, r * 1.55, 0, 6.283); g.fill();
        g.fillStyle = 'rgba(92,78,58,0.55)'; g.beginPath(); g.arc(x + r * 0.12, y + r * 0.12, r, 0, 6.283); g.fill();
      }
    }
    // tree crowns
    for (const w of GEO.woods) {
      const pp = w.poly.map(q => { const p = toXZ(q); return this.texPx(p.x, p.z); });
      const wx = Math.min(...pp.map(p => p[0])), wy = Math.min(...pp.map(p => p[1])), wX = Math.max(...pp.map(p => p[0])) - wx, wY = Math.max(...pp.map(p => p[1])) - wy;
      if (wx > X0 + SX || wy > Y0 + SY || wx + wX < X0 || wy + wY < Y0) continue;
      g.save(); g.beginPath(); pp.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.clip();
      const n = Math.min(60000, Math.round(wX * wY / (m(3.2) ** 2)));
      for (let k = 0; k < n; k++) { const x = wx + rnd() * wX, y = wy + rnd() * wY, c = rnd() < 0.5, r = m(2 + rnd() * 3); if (!vis(x, y, r)) continue; g.fillStyle = c ? 'rgba(48,64,34,0.9)' : 'rgba(96,118,66,0.85)'; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill(); }
      g.restore();
    }
  }

  // ---------- ribbons ----------
  private ribbon(p: P[], color: [number, number, number, number], width: number, dash = 0, lift = 3): Ribbon {
    const gl = this.gl, q = resample(p, 30);
    const v: number[] = []; let u = 0;
    q.forEach((s, i) => {
      const a = q[Math.max(0, i - 1)], b = q[Math.min(q.length - 1, i + 1)];
      let nx = -(b.z - a.z), nz = b.x - a.x; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      if (i) u += Math.hypot(s.x - q[i - 1].x, s.z - q[i - 1].z);
      const y = Math.max(this.dem.height(s.x, s.z), this.dem.height(s.x + 15, s.z), this.dem.height(s.x - 15, s.z), this.dem.height(s.x, s.z + 15), this.dem.height(s.x, s.z - 15));
      v.push(s.x, y, s.z, nx, nz, -1, u, s.x, y, s.z, nx, nz, 1, u);
    });
    const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    for (const [loc, size, off] of [[0, 3, 0], [1, 2, 3], [2, 1, 5], [3, 1, 6]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 28, off * 4); }
    gl.bindVertexArray(null);
    return { vao, n: q.length * 2, color, width, dash, lift };
  }
  private buildRibbons() {
    const L = this.lines;
    this.ribbons.push(this.ribbon(L.second, [0.16, 0.42, 0.2, 0.85], 2.5, 9));
    this.ribbons.push(this.ribbon(L.french, [0.2, 0.35, 0.8, 0.9], 3, 7));
    this.gfRibbon = this.ribbon(L.german, [0.1, 0.45, 0.18, 1], 3.6); this.ribbons.push(this.gfRibbon);
    this.ribbons.push(this.ribbon(L.british, [0.78, 0.12, 0.1, 1], 3.6));
  }

  // ---------- blocks (battalions, German regiments, craters) ----------
  private makeBlockBuffer() {
    const gl = this.gl, vao = gl.createVertexArray()!, buf = gl.createBuffer()!;
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (const [loc, size, off] of [[0, 3, 0], [1, 2, 3], [2, 4, 5], [3, 1, 9]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, off * 4); }
    gl.bindVertexArray(null);
    return { vao, buf };
  }
  /** a draped quad: centre, half-axes (along, across), colour, shape */
  quad(out: number[], cx: number, cz: number, ax: number, az: number, bx: number, bz: number, col: number[], shape: number, lift = 4) {
    const N = 4; // subdivisions so it follows the ground
    const V = (i: number, j: number) => {
      const u = i / N, w = j / N, x = cx + ax * (u * 2 - 1) + bx * (w * 2 - 1), z = cz + az * (u * 2 - 1) + bz * (w * 2 - 1);
      return [x, this.dem.height(x, z) + lift, z, u, w, ...col, shape];
    };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const a = V(i, j), b = V(i + 1, j), c = V(i, j + 1), d = V(i + 1, j + 1);
      out.push(...a, ...c, ...b, ...b, ...c, ...d);
    }
  }
  private buildBlocks(units: Battalion[]) {
    const out: number[] = [];
    for (const u of units) {
      const col = u.wave === 1 ? [0.78, 0.13, 0.1, 0.92] : u.wave === 2 ? [0.66, 0.16, 0.13, 0.85] : [0.55, 0.22, 0.18, 0.75];
      if (!u.involved) col[3] *= 0.55;
      this.quad(out, u.x, u.z, u.tx * u.w / 2, u.tz * u.w / 2, u.nx * u.d / 2, u.nz * u.d / 2, col, 0);
    }
    const nBn = out.length / 10;
    for (const g of GEO.germanUnits) {
      const p = toXZ(g.ll);
      this.quad(out, p.x, p.z, 170, 0, 0, 120, [0.12, 0.4, 0.2, 0.85], 0);
    }
    const b = this.makeBlockBuffer(), gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
    this.blocks = { ...b, n: out.length / 10, nBn };
  }

  // ---------- soldiers ----------
  private buildFigures() {
    const gl = this.gl;
    for (let pose = 0; pose < FIG_POSES; pose++) {
      const v = figureMesh(pose);
      const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
      const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
      const inst = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(4, 1);
      gl.bindVertexArray(null);
      this.figMesh.push({ vao, inst, n: v.length / 7 });
      this.figs.push({ data: new Float32Array(8 * 4096), n: 0 });
    }
  }
  /** add a soldier: pose (FIG.*), position, facing (radians, 0 = +z), walk phase, scale, colour */
  fig(pose: number, x: number, y: number, z: number, yaw: number, phase: number, scale: number, r: number, g: number, b: number) {
    const F = this.figs[pose];
    if ((F.n + 1) * 8 > F.data.length) { const d = new Float32Array(F.data.length * 2); d.set(F.data); F.data = d; }
    const o = F.n++ * 8, A = F.data;
    A[o] = x; A[o + 1] = y; A[o + 2] = z; A[o + 3] = yaw; A[o + 4] = phase; A[o + 5] = scale;
    A[o + 6] = Math.min(255, Math.round(r * 255)) / 256 + Math.min(255, Math.round(g * 255)) / 65536 + 1e-6; A[o + 7] = b;
  }
  clearFigs() { for (const F of this.figs) F.n = 0; }
  private drawFigs(cam: Camera, light: { sun: number[]; sunCol: number[]; sky: number[]; fog: number[] }) {
    const gl = this.gl; if (!this.figs.some(F => F.n)) return;
    gl.useProgram(this.pF); gl.uniformMatrix4fv(this.uF.uVP, false, cam.vp);
    gl.uniform3fv(this.uF.uSun, light.sun); gl.uniform3fv(this.uF.uSunCol, light.sunCol); gl.uniform3fv(this.uF.uSky, light.sky);
    gl.uniform3f(this.uF.uCam, cam.ex, cam.ey, cam.ez); gl.uniform3fv(this.uF.uFog, light.fog); gl.uniform1f(this.uF.uFogDen, 0.6 / (cam.dist * 3 + 8000));
    gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
    this.figs.forEach((F, pose) => {
      if (!F.n) return;
      const M = this.figMesh[pose];
      gl.uniform1f(this.uF.uSwing, pose === FIG.walk ? 0.45 : pose === FIG.run ? 0.8 : 0);
      gl.bindVertexArray(M.vao); gl.bindBuffer(gl.ARRAY_BUFFER, M.inst); gl.bufferData(gl.ARRAY_BUFFER, F.data.subarray(0, F.n * 8), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, M.n, F.n);
    });
    gl.enable(gl.BLEND); gl.bindVertexArray(null);
  }

  // ---------- close-up layers ----------
  private upload(src: TexImageSource) {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic'); if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return t;
  }
  /** detailed ground painting over an axis-aligned box [x0, z0, x1, z1] in local metres */
  setDetail(src: TexImageSource, box: number[]) { this.detail = { tex: this.upload(src), box }; }
  /** a map image draped on the ground: rows a, b map (x, z, 1) to texture u, v; frame = [u0, v0, u1, v1] */
  setMap(src: TexImageSource, a: number[], b: number[], frame: number[]) { this.map = { tex: this.upload(src), a, b, frame }; }

  // ---------- close-up: a sharp patch of ground round the camera, with trenches as shapes ----------
  private patchBox: number[] | null = null;
  private patchStill = 0; private lastTarget = [0, 0];
  static readonly PATCH = 3200;           // metres across, painted at 4096 px (about 0.8 m per pixel)
  static readonly PATCH_ON = 6500;        // camera distance below which the patch is used
  private updatePatch(cam: Camera) {
    const moved = Math.hypot(cam.tx - this.lastTarget[0], cam.tz - this.lastTarget[1]);
    this.lastTarget = [cam.tx, cam.tz];
    this.patchStill = moved < 2 ? this.patchStill + 1 : 0;
    if (cam.gdist > Renderer.PATCH_ON) return;
    const B = this.patchBox, H = Renderer.PATCH / 2;
    const off = B ? Math.max(Math.abs(cam.tx - (B[0] + H)), Math.abs(cam.tz - (B[1] + H))) : Infinity;
    // repaint once the camera has settled away from the patch centre (at once if there is no usable patch)
    if (off > H * 0.85 || (off > H * 0.3 && this.patchStill > 10)) this.paintPatch(cam.tx, cam.tz);
  }
  /** milliseconds the last patch took to paint */
  patchMs = 0;
  paintPatch(cx: number, cz: number) {
    const t0 = performance.now(), gl = this.gl, H = Renderer.PATCH / 2, size = matchMedia('(pointer: coarse)').matches ? 3072 : 4096;   // phones: about 1 m per pixel
    const box = [cx - H, cz - H, cx + H, cz + H]; this.patchBox = box;
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const g = cv.getContext('2d')!, [ax, ay] = this.texPx(box[0], box[1]), [bx, by] = this.texPx(box[2], box[3]);
    g.setTransform(size / (bx - ax), 0, 0, size / (by - ay), -ax * size / (bx - ax), -ay * size / (by - ay));
    this.paintMap(g, { trenches: false, fine: true });
    if (this.detail) gl.deleteTexture(this.detail.tex);
    this.detail = { tex: this.upload(cv), box };
    this.buildTrenchMesh(box);
    this.patchMs = performance.now() - t0;
  }
  private stripMesh(old: { vao: WebGLVertexArrayObject; buf: WebGLBuffer; n: number } | null, v: number[]) {
    const gl = this.gl;
    if (!this.pTr) { this.pTr = createProgram(gl, TRENCH_VS, TRENCH_FS); this.uTr = uniforms(gl, this.pTr, ['uVP', 'uCam', 'uPx', 'uLight', 'uFog', 'uFogDen', 'uAlpha', 'uMinW', 'uLift', 'uHoles']); }
    let mesh = old;
    if (!mesh) {
      const vao = gl.createVertexArray()!, buf = gl.createBuffer()!;
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (const [loc, size, off] of [[0, 3, 0], [1, 2, 3], [2, 1, 5], [3, 1, 6], [4, 4, 7], [5, 1, 11]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 48, off * 4); }
      gl.bindVertexArray(null);
      mesh = { vao, buf, n: 0 };
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    mesh.n = v.length / 12;
    return mesh;
  }
  /** quads along polylines: each straight piece its own quad, lengthened by its half-width so corners join square */
  private strips(v: number[], lines: P[][], half: number, col: number[], box?: number[]) {
    for (const q of lines) for (let i = 1; i < q.length; i++) {
      const A = q[i - 1], B = q[i];
      if (box && (Math.max(A.x, B.x) < box[0] || Math.min(A.x, B.x) > box[2] || Math.max(A.z, B.z) < box[1] || Math.min(A.z, B.z) > box[3])) continue;
      const dx = B.x - A.x, dz = B.z - A.z, L = Math.hypot(dx, dz) || 1, nx = -dz / L, nz = dx / L;
      const ya = this.dem.height(A.x, A.z), yb = this.dem.height(B.x, B.z);
      const vert = (P: P, y: number, side: number, end: number) => v.push(P.x, y, P.z, nx, nz, side, half, ...col, end);
      vert(A, ya, -1, -1); vert(A, ya, 1, -1); vert(B, yb, -1, 1); vert(B, yb, -1, 1); vert(A, ya, 1, -1); vert(B, yb, 1, 1);
    }
  }
  private buildTrenchMesh(box: number[]) {
    const near = (r: Run) => r.p.some(p => p.x > box[0] - 50 && p.x < box[2] + 50 && p.z > box[1] - 50 && p.z < box[3] + 50);
    const runs = this.trenchSet().filter(near), fire = runs.filter(r => r.kind === FIRE).map(styled), comm = runs.filter(r => r.kind !== FIRE).map(styled);
    const v: number[] = [];
    this.strips(v, comm, 2.3, [0.72, 0.68, 0.58, 1], box); this.strips(v, fire, 3.4, [0.74, 0.7, 0.6, 1], box);    // chalk spoil
    this.strips(v, comm, 0.8, [0.25, 0.2, 0.16, 1], box); this.strips(v, fire, 1.1, [0.22, 0.17, 0.13, 1], box);   // the cut
    this.trMesh = this.stripMesh(this.trMesh, v);
  }
  // ---------- mine craters ----------
  private pC!: WebGLProgram; private uC!: Record<string, WebGLUniformLocation | null>;
  private craterMesh: { vao: WebGLVertexArrayObject; parts: { first: number; n: number; hole: number[] }[] } | null = null;
  /** which craters exist at this moment (index as given to setMines) */
  craterOn: boolean[] = [];
  /** mines: centre and the crater's overall diameter in metres (crater_m) */
  setMines(mines: { x: number; z: number; d: number }[]) {
    const gl = this.gl, v: number[] = [], parts: { first: number; n: number; hole: number[] }[] = [];
    if (!this.pC) { this.pC = createProgram(gl, CRATER_VS, CRATER_FS); this.uC = uniforms(gl, this.pC, ['uVP', 'uSun', 'uSunCol', 'uSky', 'uCam', 'uFog', 'uFogDen']); }
    mines.forEach((m, mi) => {
      // Lochnagar: about 70 m across the rim, 21 m deep, a lip 4-5 m high spreading 15 m; smaller craters scaled
      const R = m.d <= 50 ? m.d / 2 : 0.35 * m.d, depth = Math.min(21, 0.6 * R), lip = 0.16 * R, Rout = R + Math.max(8, 0.45 * R);
      const SEG = 64, NB = 14, NL = 12;
      let seed = 31 + mi * 977; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      // an irregular rim: a few slow waves round the circle, not per-vertex noise (which streaks the shading)
      const ph = Array.from({ length: 6 }, () => rnd() * 6.283);
      const wob = Array.from({ length: SEG }, (_, j) => { const a = j / SEG * 6.283; return 1 + 0.05 * Math.sin(2 * a + ph[0]) + 0.035 * Math.sin(3 * a + ph[1]) + 0.02 * Math.sin(5 * a + ph[2]); });
      const hn = Array.from({ length: SEG }, (_, j) => { const a = j / SEG * 6.283; return R * (0.05 * Math.sin(2 * a + ph[3]) + 0.03 * Math.sin(4 * a + ph[4])); });
      const ring: { x: number; y: number; z: number; c: number[] }[][] = [];
      const rad = [...Array.from({ length: NB + 1 }, (_, k) => R * k / NB), ...Array.from({ length: NL }, (_, k) => R + (Rout - R) * (k + 1) / NL)];
      rad.forEach((r, k) => {
        const row: { x: number; y: number; z: number; c: number[] }[] = [];
        for (let j = 0; j < SEG; j++) {
          const a = j / SEG * Math.PI * 2, w = wob[j], x = m.x + Math.cos(a) * r * w, z = m.z + Math.sin(a) * r * w, g = this.dem.height(x, z);
          let y: number, c: number[];
          if (r <= R) {
            const u = r / R; y = g + lip - (depth + lip) * (1 - Math.pow(u, 2.2)) + hn[j] * u * u;
            const k2 = 0.74 + 0.2 * u; c = [k2, k2 * 0.97, k2 * 0.86, 1];                            // chalk, greyer in the bottom
          } else {
            const u = (r - R) / (Rout - R); y = g + lip * (1 - u) * (1 - u) + 0.3 + hn[j] * (1 - u) * 0.5;
            const ch = Math.pow(1 - u, 0.7); c = [0.6 + 0.34 * ch, 0.58 + 0.34 * ch, 0.44 + 0.38 * ch, Math.min(1, (1 - u) * 2.5)];   // chalk spoil thinning to turf
          }
          row.push({ x, y, z, c });
        }
        ring.push(row);
      });
      // normals from neighbouring vertices
      const first = v.length / 10;
      const P = (k: number, j: number) => ring[Math.max(0, Math.min(ring.length - 1, k))][(j + SEG) % SEG];
      const vert = (k: number, j: number) => {
        const p = P(k, j), a = P(k + 1, j), b = P(k - 1, j), c = P(k, j + 1), d = P(k, j - 1);
        const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z, wx = c.x - d.x, wy = c.y - d.y, wz = c.z - d.z;
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const L = Math.hypot(nx, ny, nz) || 1; if (k === 0) { nx = 0; ny = 1; nz = 0; }
        v.push(p.x, p.y, p.z, nx / L, ny / L, nz / L, ...p.c);
      };
      for (let k = 0; k + 1 < ring.length; k++) for (let j = 0; j < SEG; j++) { vert(k, j); vert(k + 1, j); vert(k, j + 1); vert(k, j + 1); vert(k + 1, j); vert(k + 1, j + 1); }
      parts.push({ first, n: v.length / 10 - first, hole: [m.x, m.z, R * 0.93, 1] });
    });
    const vao = gl.createVertexArray()!, buf = gl.createBuffer()!;
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    for (const [loc, size, off] of [[0, 3, 0], [1, 3, 3], [2, 4, 6]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, off * 4); }
    gl.bindVertexArray(null);
    this.craterMesh = { vao, parts };
  }
  private capMesh: { vao: WebGLVertexArrayObject; buf: WebGLBuffer; n: number } | null = null;
  /** trench lengths in British hands, drawn red over the trenches */
  setCaptured(lines: P[][]) { const v: number[] = []; this.strips(v, lines, 4.2, [0.86, 0.12, 0.1, 0.9]); this.capMesh = this.stripMesh(this.capMesh, v); }
  private pocketMesh: { vao: WebGLVertexArrayObject; buf: WebGLBuffer; n: number } | null = null;
  /** German-held trench lengths behind the British advance */
  setPockets(lines: P[][]) { const v: number[] = []; this.strips(v, lines, 4.2, [0.12, 0.5, 0.2, 0.9]); this.pocketMesh = this.stripMesh(this.pocketMesh, v); }
  /** replace the German front-line ribbon */
  setGermanFront(p: P[]) {
    const k = this.ribbons.findIndex(r => r === this.gfRibbon); const r = this.ribbon(p, [0.1, 0.45, 0.18, 1], 3.6); r.minDist = 2400;
    if (k >= 0) this.ribbons[k] = r; else this.ribbons.push(r); this.gfRibbon = r;
  }
  private gfRibbon: Ribbon | null = null;

  // ---------- per-frame shapes from the battle ----------
  /** start a new frame's worth of flat quads */
  clearFlat() { this.flatN = 0; }
  /** a single-quad block lying on the ground: centre, half-axes, colour */
  flatQuad(cx: number, cz: number, ax: number, az: number, bx: number, bz: number, r: number, g: number, b: number, a: number, lift = 3) {
    if ((this.flatN + 6) * 10 > this.flat.length) { const n = new Float32Array(this.flat.length * 2); n.set(this.flat); this.flat = n; }
    const A = this.flat, h = this.dem;
    const P = [[cx - ax - bx, cz - az - bz, 0, 0], [cx + ax - bx, cz + az - bz, 1, 0], [cx - ax + bx, cz - az + bz, 0, 1], [cx + ax + bx, cz + az + bz, 1, 1]];
    const ys = P.map(p => h.height(p[0], p[1]) + lift), y = Math.max(...ys);
    for (const k of [0, 2, 1, 1, 2, 3]) {
      const o = this.flatN++ * 10, q = P[k];
      A[o] = q[0]; A[o + 1] = (ys[k] + y) / 2; A[o + 2] = q[1]; A[o + 3] = q[2]; A[o + 4] = q[3];
      A[o + 5] = r; A[o + 6] = g; A[o + 7] = b; A[o + 8] = a; A[o + 9] = 0;
    }
  }
  /** set (or replace) live line k: one or more polylines drawn with constant screen width */
  setLive(k: number, lines: P[][], color: [number, number, number, number], width: number, lift = 5) {
    const gl = this.gl;
    if (!this.live[k]) {
      const vao = gl.createVertexArray()!, buf = gl.createBuffer()!;
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (const [loc, size, off] of [[0, 3, 0], [1, 2, 3], [2, 1, 5], [3, 1, 6]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 28, off * 4); }
      gl.bindVertexArray(null);
      this.live[k] = { vao, n: 0, color, width, dash: 0, lift }; this.liveBuf[k] = buf;
    }
    const v: number[] = [];
    for (const q of lines) {
      if (q.length < 2) continue;
      if (v.length) { const a = v.slice(-7); v.push(...a); } // degenerate join between strips
      let u = 0, first = true;
      q.forEach((s, i) => {
        const a = q[Math.max(0, i - 1)], b = q[Math.min(q.length - 1, i + 1)];
        let nx = -(b.z - a.z), nz = b.x - a.x; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
        if (i) u += Math.hypot(s.x - q[i - 1].x, s.z - q[i - 1].z);
        const y = this.dem.height(s.x, s.z);
        if (first && v.length) v.push(s.x, y, s.z, nx, nz, -1, u);
        first = false;
        v.push(s.x, y, s.z, nx, nz, -1, u, s.x, y, s.z, nx, nz, 1, u);
      });
    }
    const R = this.live[k]; R.color = color; R.width = width; R.lift = lift; R.n = v.length / 7;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.liveBuf[k]); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
  }

  // ---------- frame ----------
  render(cam: Camera, light: { sun: number[]; sunCol: number[]; sky: number[]; fog: number[] }, decals: number[], dt: number) {
    const gl = this.gl, cv = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cam.update(dt, W, H);
    gl.viewport(0, 0, W, H);
    gl.clearColor(light.fog[0], light.fog[1], light.fog[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE); gl.depthMask(true);
    // terrain
    gl.useProgram(this.pT);
    gl.uniformMatrix4fv(this.uT.uVP, false, cam.vp);
    gl.uniform3fv(this.uT.uSun, light.sun); gl.uniform3fv(this.uT.uSunCol, light.sunCol); gl.uniform3fv(this.uT.uSky, light.sky);
    gl.uniform3f(this.uT.uCam, cam.ex, cam.ey, cam.ez); gl.uniform3fv(this.uT.uFog, light.fog);
    gl.uniform1f(this.uT.uFogDen, 0.6 / (cam.dist * 3 + 8000)); gl.uniform1f(this.uT.uContour, 1);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(this.uT.uTex, 0);
    this.updatePatch(cam);
    const dOn = this.detail ? clamp((Renderer.PATCH_ON - cam.dist) / 2500, 0, 1) : 0;
    gl.uniform1f(this.uT.uDetailOn, dOn); gl.uniform1f(this.uT.uMapOn, this.map ? this.mapOpacity : 0);
    if (this.detail) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.detail.tex); gl.uniform1i(this.uT.uDetail, 1); gl.uniform4fv(this.uT.uDB, this.detail.box); }
    if (this.map) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.map.tex); gl.uniform1i(this.uT.uMap, 2); gl.uniform3fv(this.uT.uMapA, this.map.a); gl.uniform3fv(this.uT.uMapB, this.map.b); gl.uniform4fv(this.uT.uMapFrame, this.map.frame); }
    gl.activeTexture(gl.TEXTURE0);
    const holes = new Float32Array(32);
    this.craterMesh?.parts.forEach((p, i) => { if (i < 8 && this.craterOn[i]) holes.set(p.hole, i * 4); });
    gl.uniform4fv(this.uT.uHoles, holes);
    gl.bindVertexArray(this.terrain.vao); gl.drawElements(gl.TRIANGLES, this.terrain.n, this.terrain.type, 0);
    if (this.craterMesh && this.craterOn.some(Boolean)) {
      gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.pC); gl.uniformMatrix4fv(this.uC.uVP, false, cam.vp);
      gl.uniform3fv(this.uC.uSun, light.sun); gl.uniform3fv(this.uC.uSunCol, light.sunCol); gl.uniform3fv(this.uC.uSky, light.sky);
      gl.uniform3f(this.uC.uCam, cam.ex, cam.ey, cam.ez); gl.uniform3fv(this.uC.uFog, light.fog); gl.uniform1f(this.uC.uFogDen, 0.6 / (cam.dist * 3 + 8000));
      gl.bindVertexArray(this.craterMesh.vao);
      this.craterMesh.parts.forEach((p, i) => { if (this.craterOn[i]) gl.drawArrays(gl.TRIANGLES, p.first, p.n); });
      gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
    }
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const trUniforms = () => {
      gl.useProgram(this.pTr); gl.uniformMatrix4fv(this.uTr.uVP, false, cam.vp); gl.uniform3f(this.uTr.uCam, cam.ex, cam.ey, cam.ez); gl.uniform1f(this.uTr.uPx, cam.px);
      const sy = Math.max(light.sun[1], 0); gl.uniform3f(this.uTr.uLight, light.sunCol[0] * sy + light.sky[0], light.sunCol[1] * sy + light.sky[1], light.sunCol[2] * sy + light.sky[2]);
      gl.uniform3fv(this.uTr.uFog, light.fog); gl.uniform1f(this.uTr.uFogDen, 0.6 / (cam.dist * 3 + 8000)); gl.uniform4fv(this.uTr.uHoles, holes);
    };
    if (this.trMesh?.n && dOn > 0) {
      trUniforms(); gl.uniform1f(this.uTr.uAlpha, dOn); gl.uniform1f(this.uTr.uMinW, 1.1); gl.uniform1f(this.uTr.uLift, 0);
      gl.bindVertexArray(this.trMesh.vao); gl.drawArrays(gl.TRIANGLES, 0, this.trMesh.n);
    }
    if (this.pocketMesh?.n) {
      trUniforms(); gl.uniform1f(this.uTr.uAlpha, 1); gl.uniform1f(this.uTr.uMinW, 2.6); gl.uniform1f(this.uTr.uLift, 0.6);
      gl.bindVertexArray(this.pocketMesh.vao); gl.drawArrays(gl.TRIANGLES, 0, this.pocketMesh.n);
    }
    if (this.capMesh?.n) {
      trUniforms(); gl.uniform1f(this.uTr.uAlpha, 1); gl.uniform1f(this.uTr.uMinW, 2.6); gl.uniform1f(this.uTr.uLift, 0.6);
      gl.bindVertexArray(this.capMesh.vao); gl.drawArrays(gl.TRIANGLES, 0, this.capMesh.n);
    }
    // blocks and crater decals
    gl.useProgram(this.pB); gl.uniformMatrix4fv(this.uB.uVP, false, cam.vp);
    if (decals.length) { gl.bindVertexArray(this.dyn.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(decals), gl.DYNAMIC_DRAW); gl.drawArrays(gl.TRIANGLES, 0, decals.length / 10); }
    gl.bindVertexArray(this.blocks.vao);
    if (this.showBattalions) gl.drawArrays(gl.TRIANGLES, 0, this.blocks.n); else gl.drawArrays(gl.TRIANGLES, this.blocks.nBn, this.blocks.n - this.blocks.nBn);
    if (this.flatN) { gl.bindVertexArray(this.dyn.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn.buf); gl.bufferData(gl.ARRAY_BUFFER, this.flat.subarray(0, this.flatN * 10), gl.DYNAMIC_DRAW); gl.drawArrays(gl.TRIANGLES, 0, this.flatN); }
    this.drawFigs(cam, light);
    // ribbons
    gl.useProgram(this.pR);
    gl.uniformMatrix4fv(this.uR.uVP, false, cam.vp); gl.uniform3f(this.uR.uCam, cam.ex, cam.ey, cam.ez); gl.uniform1f(this.uR.uPx, cam.px);
    for (const r of [...this.ribbons, ...this.live]) {
      if (!r.n || (r.minDist && cam.dist < r.minDist)) continue;
      gl.uniform1f(this.uR.uWidth, r.width * Math.min(2, window.devicePixelRatio || 1)); gl.uniform1f(this.uR.uLift, r.lift);
      gl.uniform4fv(this.uR.uColor, r.color); gl.uniform1f(this.uR.uDash, r.dash);
      gl.bindVertexArray(r.vao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, r.n);
    }
    // bursts
    let n = 0; const A = this.ptsArr, keep: Burst[] = [];
    for (const b of this.bursts) {
      b.age += dt; if (b.age > b.life) continue;
      keep.push(b); b.y += b.vy * dt; b.size += b.grow * dt;
      if (n >= 20000) continue;
      const f = 1 - b.age / b.life, o = n * 8;
      A[o] = b.x; A[o + 1] = b.y; A[o + 2] = b.z; A[o + 3] = b.size;
      A[o + 4] = b.r; A[o + 5] = b.g; A[o + 6] = b.b; A[o + 7] = b.glow ? 1 + f : b.a * Math.min(1, f * 1.5);
      n++;
    }
    this.bursts = keep;
    if (n) {
      gl.depthMask(false);
      gl.useProgram(this.pP); gl.uniformMatrix4fv(this.uP.uVP, false, cam.vp); gl.uniform3f(this.uP.uCam, cam.ex, cam.ey, cam.ez); gl.uniform1f(this.uP.uPx, cam.px);
      gl.bindVertexArray(this.ptsVao); gl.bindBuffer(gl.ARRAY_BUFFER, this.ptsBuf); gl.bufferData(gl.ARRAY_BUFFER, A.subarray(0, n * 8), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
  }
}

// ---------------- soldier meshes ----------------
export const FIG = { walk: 0, run: 1, kneel: 2, prone: 3, dead: 4, stand: 5, gun: 6 } as const;
const FIG_POSES = 7;
type M3 = number[]; // row-major 3x3
const RX = (a: number): M3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const RZ = (a: number): M3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const MUL = (a: M3, b: M3): M3 => [0, 1, 2].flatMap(i => [0, 1, 2].map(j => a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]));
const AP = (m: M3, v: number[]) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** parts: 0 body, 1 left leg, 2 right leg, 3 arms, 4 boots and rifle (darker), 5 helmet */
function box(out: number[], c: number[], h: number[], part: number, m: M3 = I3, piv = [0, 0, 0], off = [0, 0, 0]) {
  const F: [number[], number[][]][] = [
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]], [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]], [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]]], [[0, 0, -1], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]],
  ];
  for (const [n, q] of F) {
    const P = q.map(k => { const p = [c[0] + k[0] * h[0] - piv[0], c[1] + k[1] * h[1] - piv[1], c[2] + k[2] * h[2] - piv[2]]; const r = AP(m, p); return [r[0] + piv[0] + off[0], r[1] + piv[1] + off[1], r[2] + piv[2] + off[2]]; });
    const N = AP(m, n);
    for (const i of [0, 2, 1, 0, 3, 2]) out.push(...P[i], ...N, part);
  }
}
function figureMesh(pose: number) {
  const v: number[] = [];
  if (pose === FIG.gun) { // machine gun on its sledge mount
    box(v, [0, 0.35, 0.1], [0.08, 0.08, 0.45], 4); box(v, [0, 0.42, -0.25], [0.12, 0.12, 0.2], 4);
    box(v, [0, 0.15, -0.15], [0.3, 0.04, 0.35], 4); box(v, [0, 0.2, 0.32], [0.18, 0.1, 0.03], 4);
    return v;
  }
  // a standing man facing +z; the upper body can lean or be posed
  const legs = (m: M3, piv: number[], off: number[]) => {
    box(v, [0.1, 0.45, 0], [0.075, 0.42, 0.08], 1, m, piv, off); box(v, [-0.1, 0.45, 0], [0.075, 0.42, 0.08], 2, m, piv, off);
    box(v, [0.1, 0.04, 0.03], [0.08, 0.04, 0.12], 4, m, piv, off); box(v, [-0.1, 0.04, 0.03], [0.08, 0.04, 0.12], 4, m, piv, off);
  };
  const upper = (m: M3, piv: number[], off: number[], aim: boolean) => {
    box(v, [0, 1.17, 0], [0.2, 0.3, 0.12], 0, m, piv, off);                    // torso
    box(v, [0, 1.38, 0.02], [0.17, 0.08, 0.14], 0, m, piv, off);              // pack and shoulders
    box(v, [0, 1.58, 0.01], [0.09, 0.1, 0.1], 0, m, piv, off);                // head
    box(v, [0, 1.7, 0.01], [0.17, 0.025, 0.17], 5, m, piv, off);              // helmet brim
    box(v, [0, 1.73, 0.01], [0.1, 0.04, 0.1], 5, m, piv, off);
    if (aim) { box(v, [0.15, 1.36, 0.3], [0.05, 0.05, 0.3], 3, m, piv, off); box(v, [-0.12, 1.33, 0.35], [0.05, 0.05, 0.3], 3, m, piv, off); box(v, [0.06, 1.38, 0.55], [0.025, 0.03, 0.6], 4, m, piv, off); }
    else { box(v, [0.27, 1.12, 0.05], [0.05, 0.28, 0.06], 3, m, piv, off); box(v, [-0.27, 1.12, 0.05], [0.05, 0.28, 0.06], 3, m, piv, off); box(v, [0.18, 1.2, 0.2], [0.025, 0.55, 0.03], 4, MUL(m, RX(0.6)), [0.18, 1.2, 0.2], off); }
  };
  if (pose === FIG.walk || pose === FIG.stand) { legs(I3, [0, 0, 0], [0, 0, 0]); upper(RX(0.08), [0, 0.85, 0], [0, 0, 0], false); }
  else if (pose === FIG.run) { legs(I3, [0, 0, 0], [0, 0, 0]); upper(RX(0.35), [0, 0.85, 0], [0, -0.05, 0], false); }
  else if (pose === FIG.kneel) {
    box(v, [0.1, 0.45, 0.25], [0.075, 0.08, 0.25], 0); box(v, [0.1, 0.22, 0.48], [0.075, 0.22, 0.08], 0); // forward thigh and shin
    box(v, [-0.1, 0.5, -0.05], [0.075, 0.08, 0.25], 0, RX(1.2), [-0.1, 0.5, 0]); box(v, [-0.1, 0.08, -0.3], [0.075, 0.06, 0.22], 0);
    upper(I3, [0, 0, 0], [0, -0.38, 0], true);
  } else { // prone or dead: the standing figure laid down
    const m = pose === FIG.prone ? RX(Math.PI / 2) : MUL(RZ(1.2), RX(-Math.PI / 2));
    legs(m, [0, 0.12, 0], [0, -0.0, 0]); upper(MUL(m, pose === FIG.prone ? I3 : RX(0.4)), [0, 0.12, 0], [0, 0, 0], pose === FIG.prone);
  }
  return v;
}
