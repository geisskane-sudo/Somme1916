// Thin WebGL2 helpers: shader programs, static meshes and dynamic instance buffers.

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(s) + '\n' + src);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
  return p;
}

export function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]) {
  const o: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) o[n] = gl.getUniformLocation(p, n);
  return o;
}

/** CPU-side mesh builder with interleaved attributes */
export class MeshBuilder {
  data: number[] = [];
  idx: number[] = [];
  /** floats per vertex */
  constructor(readonly stride: number) {}
  get count() { return this.data.length / this.stride; }
  vertex(...v: number[]) { for (const x of v) this.data.push(x); return this.count - 1; }
  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }
}

export interface GPUMesh { vao: WebGLVertexArrayObject; count: number; indexType: number; instanceBuf?: WebGLBuffer; instanceStride?: number; }

export interface AttribSpec { loc: number; size: number; }

/** upload a mesh; `attribs` describe per-vertex layout, `inst` optional per-instance layout */
export function uploadMesh(gl: WebGL2RenderingContext, mb: MeshBuilder, attribs: AttribSpec[], inst?: AttribSpec[]): GPUMesh {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mb.data), gl.STATIC_DRAW);
  let off = 0;
  for (const a of attribs) {
    gl.enableVertexAttribArray(a.loc);
    gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, mb.stride * 4, off * 4);
    off += a.size;
  }
  const ib = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  const big = mb.count > 65535;
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, big ? new Uint32Array(mb.idx) : new Uint16Array(mb.idx), gl.STATIC_DRAW);
  const mesh: GPUMesh = { vao, count: mb.idx.length, indexType: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  if (inst) {
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = inst.reduce((s, a) => s + a.size, 0);
    let o = 0;
    for (const a of inst) {
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, stride * 4, o * 4);
      gl.vertexAttribDivisor(a.loc, 1);
      o += a.size;
    }
    mesh.instanceBuf = buf; mesh.instanceStride = stride;
  }
  gl.bindVertexArray(null);
  return mesh;
}

/** growable float array for per-frame instance data */
export class InstanceData {
  arr: Float32Array; n = 0;
  constructor(readonly stride: number, cap = 256) { this.arr = new Float32Array(stride * cap); }
  reset() { this.n = 0; }
  push(): number {
    if ((this.n + 1) * this.stride > this.arr.length) { const a = new Float32Array(this.arr.length * 2); a.set(this.arr); this.arr = a; }
    return this.n++ * this.stride;
  }
}

export function drawInstanced(gl: WebGL2RenderingContext, mesh: GPUMesh, data: InstanceData, dynamic = true) {
  if (!data.n) return;
  gl.bindVertexArray(mesh.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instanceBuf!);
  gl.bufferData(gl.ARRAY_BUFFER, data.arr.subarray(0, data.n * data.stride), dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
  gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, mesh.indexType, 0, data.n);
}
