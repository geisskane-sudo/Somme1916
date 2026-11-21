// Isometric-style RTS camera: orbit around a ground target with smoothed pan, zoom, rotation and tilt.
import { mat4, perspective, lookAt, multiply, invert, transformPoint, clamp, lerp } from '../core/math';
/** the ground the camera needs: a box centred on 0 and a height function */
export interface Terrain { minX: number; minZ: number; heightAt(x: number, z: number): number; inBounds(x: number, z: number): boolean }

export class RTSCamera {
  // current
  tx = 0; tz = 0; ty = 0; yaw = 0; pitch = 0.9; dist = 450;
  // goals
  gx = 0; gz = 0; gyaw = 0; gpitch = 0.9; gdist = 450;
  manualPitch = false;
  fov = 0.8;
  aspect = 1;
  width = 1; height = 1;
  view = mat4(); proj = mat4(); vp = mat4(); inv = mat4();
  ex = 0; ey = 0; ez = 0;
  private v4 = new Float32Array(4);

  constructor(private terrain: Terrain) {}

  setTarget(x: number, z: number, snap = false) { this.gx = x; this.gz = z; if (snap) { this.tx = x; this.tz = z; } }
  /** pitch follows zoom (closer → lower, more cinematic) unless the player tilted manually */
  autoPitch(d: number) { return lerp(0.42, 1.1, clamp((d - 40) / 900, 0, 1)); }

  pan(right: number, fwd: number) {
    const s = this.gdist * 0.9;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = -fz, rz = fx;
    this.gx += (rx * right + fx * fwd) * s; this.gz += (rz * right + fz * fwd) * s;
  }
  rotate(d: number) { this.gyaw += d; }
  /** look-at height above the ground target (m); raising it tilts the view up toward the sky */
  lookUp = 0; glookUp = 0;
  tilt(d: number) {
    this.manualPitch = true;
    // below the lowest orbit pitch, further tilting raises the look-at point so the horizon and sky come into view
    if (this.gpitch <= 0.06 && d < 0) { this.glookUp = clamp(this.glookUp - d * this.gdist * 0.8, 0, this.gdist * 0.42); return; }
    if (this.glookUp > 0 && d > 0) { this.glookUp = clamp(this.glookUp - d * this.gdist * 0.8, 0, this.gdist * 0.42); return; }
    this.gpitch = clamp(this.gpitch + d, 0.06, 1.45);
  }
  zoom(f: number) {
    this.gdist = clamp(this.gdist * f, 14, 1300);
    if (!this.manualPitch) this.gpitch = this.autoPitch(this.gdist);
  }
  preset(kind: 'tactical' | 'close') {
    this.manualPitch = false; this.glookUp = 0;
    this.gdist = kind === 'tactical' ? 950 : 110;
    this.gpitch = this.autoPitch(this.gdist);
  }

  update(dt: number, w: number, h: number) {
    this.width = w; this.height = h; this.aspect = w / Math.max(1, h);
    const k = 1 - Math.exp(-dt * 7);
    const t = this.terrain;
    const m = 40;
    this.gx = clamp(this.gx, t.minX + m, -t.minX - m); this.gz = clamp(this.gz, t.minZ + m, -t.minZ - m);
    this.tx += (this.gx - this.tx) * k; this.tz += (this.gz - this.tz) * k;
    this.yaw += (this.gyaw - this.yaw) * k;
    this.pitch += (this.gpitch - this.pitch) * k;
    this.lookUp += (this.glookUp - this.lookUp) * k;
    this.dist += (this.gdist - this.dist) * k;
    const groundY = t.heightAt(this.tx, this.tz);
    this.ty += (groundY - this.ty) * (1 - Math.exp(-dt * 4));
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.ex = this.tx + Math.sin(this.yaw) * cp * this.dist;
    this.ez = this.tz + Math.cos(this.yaw) * cp * this.dist;
    this.ey = this.ty + sp * this.dist;
    const floor = t.heightAt(this.ex, this.ez) + 2.2;
    if (this.ey < floor) this.ey = floor;
    lookAt(this.view, this.ex, this.ey, this.ez, this.tx, this.ty + this.lookUp, this.tz);
    perspective(this.proj, this.fov, this.aspect, 1.5, 6000);
    multiply(this.vp, this.proj, this.view);
    invert(this.inv, this.vp);
  }

  /** world → screen pixels; returns null if behind camera */
  project(x: number, y: number, z: number): { x: number; y: number; d: number } | null {
    const v = transformPoint(this.vp, x, y, z, this.v4);
    if (v[3] <= 0.1) return null;
    return { x: (v[0] / v[3] * 0.5 + 0.5) * this.width, y: (1 - (v[1] / v[3] * 0.5 + 0.5)) * this.height, d: v[3] };
  }

  ray(sx: number, sy: number) {
    const nx = (sx / this.width) * 2 - 1, ny = 1 - (sy / this.height) * 2;
    const a = transformPoint(this.inv, nx, ny, -1, new Float32Array(4));
    const b = transformPoint(this.inv, nx, ny, 1, new Float32Array(4));
    const ox = a[0] / a[3], oy = a[1] / a[3], oz = a[2] / a[3];
    let dx = b[0] / b[3] - ox, dy = b[1] / b[3] - oy, dz = b[2] / b[3] - oz;
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    return { ox, oy, oz, dx, dy, dz };
  }

  /** intersect screen ray with terrain */
  pickGround(sx: number, sy: number): { x: number; z: number; y: number } | null {
    const r = this.ray(sx, sy);
    const t = this.terrain;
    let prev = 0;
    for (let s = 2; s < 5000; s *= 1.02) {
      const x = r.ox + r.dx * s, y = r.oy + r.dy * s, z = r.oz + r.dz * s;
      if (y < t.heightAt(x, z)) {
        let lo = prev, hi = s;
        for (let i = 0; i < 18; i++) {
          const m = (lo + hi) / 2, mx = r.ox + r.dx * m, my = r.oy + r.dy * m, mz = r.oz + r.dz * m;
          if (my < t.heightAt(mx, mz)) hi = m; else lo = m;
        }
        const x2 = r.ox + r.dx * hi, z2 = r.oz + r.dz * hi;
        if (!t.inBounds(x2, z2)) return null;
        return { x: x2, z: z2, y: t.heightAt(x2, z2) };
      }
      prev = s;
      if (s > 2 && y < -50) break;
      s += 1;
    }
    return null;
  }
}
