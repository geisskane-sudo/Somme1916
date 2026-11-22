// Where the ground was shelled, for the shell holes the terrain shader draws up close. Placed from the
// record rather than at random: the British week-long bombardment fell on no man's land and the German
// trench zone, heaviest where it cut the wire and wrecked the garrison (Montauban, Mametz), lightest where
// it failed (Serre, Beaumont Hamel, Gommecourt); the German guns shelled the British front trenches where
// they were untouched by counter-battery fire (VII and VIII Corps).
import plan from '../data/plan.json';
import type { Battle } from './battle';
import { CELL } from './battle';
import type { P } from './geo';

type Corps = Record<string, { gerArt: number; garrison: number }>;
type Divs = Record<string, { wire: number }>;

/** 0..1 weight of the British bombardment on a division's front */
export function bombardment(div: string | null, corps: string) {
  const C = (plan.corps as Corps)[corps], D = div ? (plan.divisions as unknown as Divs)[div] : undefined;
  const wire = D?.wire ?? 0.6, garrison = C?.garrison ?? 1;
  return Math.min(1, wire * (1.4 - garrison) / 0.76);
}

/** shelled bands for each stretch of front, with the chance of a shell hole in each 6 m square */
export function shellBands(b: Battle): { poly: P[]; p: number }[] {
  const out: { poly: P[]; p: number }[] = [];
  for (const c of b.cells) {
    const I = bombardment(c.div, c.corps), G = (plan.corps as Corps)[c.corps]?.gerArt ?? 0.8;
    const tx = -c.az, tz = c.ax, h = CELL * 0.56;
    const band = (d0: number, d1: number, p: number) => {
      const q = (a: number, d: number) => ({ x: c.bx + tx * a + c.ax * d, z: c.bz + tz * a + c.az * d });
      out.push({ poly: [q(-h, d0), q(h, d0), q(h, d1), q(-h, d1)], p });
    };
    band(c.w - 30, c.w + 450, 1.2 * I);                              // German front system: the weight of the bombardment
    band(20, c.w - 30, 0.5 * I);                                     // no man's land: shorts and wire-cutting
    band(c.w + 450, (c.d2 ?? c.w + 1500) + 150, 0.18 * I);           // deeper German positions
    band(-220, 20, 0.75 * G * G);                                    // German shelling of the British trenches
  }
  return out;
}
