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
  // intensities smoothed along the front over about a kilometre, so a division boundary is a gradual change
  const raw = b.cells.map(c => [bombardment(c.div, c.corps), (plan.corps as Corps)[c.corps]?.gerArt ?? 0.8]);
  const sm = raw.map((_, i) => { let a = 0, g = 0, w = 0; for (let k = -5; k <= 5; k++) { const r = raw[i + k]; if (!r) continue; const q = Math.exp(-k * k / 12); a += r[0] * q; g += r[1] * q; w += q; } return [a / w, g / w]; });
  for (const c of b.cells) {
    const [I, G] = sm[c.i];
    const tx = -c.az, tz = c.ax, h = CELL * 0.8;            // overlapping, so no wedges are left unshelled where the front bends
    const band = (d0: number, d1: number, p: number) => {
      const q = (a: number, d: number) => ({ x: c.bx + tx * a + c.ax * d, z: c.bz + tz * a + c.az * d });
      out.push({ poly: [q(-h, d0), q(h, d0), q(h, d1), q(-h, d1)], p });
    };
    band(c.w - 30, c.w + 450, 0.25 + 1.2 * I);                       // German front system: the weight of the bombardment
    band(20, c.w - 30, 0.45 + 0.9 * I + 0.25 * G);                    // no man's land: months of shelling, shorts, wire-cutting, German barrage
    band(c.w + 450, (c.d2 ?? c.w + 1500) + 150, 0.18 * I);           // deeper German positions
    band(-220, 20, 0.75 * G * G);                                    // German shelling of the British trenches
  }
  return out;
}
