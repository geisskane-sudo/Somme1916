// Shell holes for the close-up ground, placed from the record of the bombardment rather than at random:
// the British week-long bombardment fell on no man's land and the German trench zone, heaviest where it
// cut the wire and wrecked the garrison (Montauban, Mametz), lightest where it failed (Serre, Beaumont
// Hamel, Gommecourt); the German guns shelled the British front trenches where they were untouched
// by counter-battery fire (VII and VIII Corps).
import plan from '../data/plan.json';
import type { Battle } from './battle';
import { CELL } from './battle';

type Corps = Record<string, { gerArt: number; garrison: number }>;
type Divs = Record<string, { wire: number }>;

/** 0..1 weight of the British bombardment on a division's front */
export function bombardment(div: string | null, corps: string) {
  const C = (plan.corps as Corps)[corps], D = div ? (plan.divisions as unknown as Divs)[div] : undefined;
  const wire = D?.wire ?? 0.6, garrison = C?.garrison ?? 1;
  return Math.min(1, wire * (1.4 - garrison) / 0.76);
}

/** craters (x, z, radius in metres) in a box [x0, z0, x1, z1], deterministic for each stretch of front */
export function craters(b: Battle, box: number[]): Float32Array {
  const out: number[] = [];
  const pad = 1200;
  for (const c of b.cells) {
    if (c.bx < box[0] - pad || c.bx > box[2] + pad || c.bz < box[1] - pad || c.bz > box[3] + pad) continue;
    let seed = 1000 + c.i * 7919; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const I = bombardment(c.div, c.corps), G = (plan.corps as Corps)[c.corps]?.gerArt ?? 0.8;
    const tx = -c.az, tz = c.ax;
    const put = (n: number, d0: number, d1: number, big: number) => {
      for (let k = 0; k < n; k++) {
        const a = (rnd() - 0.5) * CELL, d = d0 + rnd() * (d1 - d0), u = rnd();
        const x = c.bx + tx * a + c.ax * d, z = c.bz + tz * a + c.az * d;
        const r = 0.6 + 2.2 * u * u * u + (rnd() < big ? 1.5 + rnd() * 2.5 : 0);   // field guns mostly; some heavies
        if (x > box[0] && x < box[2] && z > box[1] && z < box[3]) out.push(x, z, r);
      }
    };
    // German front system: the main weight of the bombardment
    put(Math.round(1600 * I), c.w - 30, c.w + 450, 0.06 + 0.1 * I);
    // no man's land: shorts and wire-cutting
    put(Math.round(350 * I), 20, c.w - 30, 0.03);
    // deeper German positions, lighter
    put(Math.round(500 * I), c.w + 450, (c.d2 ?? c.w + 1500) + 150, 0.08);
    // German shelling of the British front and support trenches
    put(Math.round(500 * G * G), -220, 20, 0.08);
  }
  return new Float32Array(out);
}
