# Fit each NLS trench-map screenshot to the British trench-map grid and to our local metres.
# The grid: each sheet (57D, 62D) is divided into lettered 6000-yard squares, A-F in the top row,
# G-L, M-R, S-X below; each into 36 numbered 1000-yard squares (6 per row). Coordinates here are
# yards east (E) and south (S) of the north-west corner of 57D's A square. 62D's lettered squares
# start again at 62D's top edge, which on 57D's lattice falls at S = 22775 yards (fitted to landmarks on the Fricourt sheet).
# Anchor: square R19's north-west corner on the georeferenced 1:5000 Schwaben Redoubt sheet.
import json, sys, numpy as np
from PIL import Image
ROOT = '/home/claude/somme-1july'
YD = 0.9144
LETTER = {c: (i // 6, i % 6) for i, c in enumerate('ABCDEFGHIJKLMNOPQRSTUVWX')}

def grid(sheet: str, letter: str, n: int, fx=0.0, fy=0.0):
    """yards (E, S) of a point in numbered square n of lettered square `letter` (fx, fy = fraction across, down)"""
    r, c = LETTER[letter]; sr, sc = (n - 1) // 6, (n - 1) % 6
    s0 = 0 if sheet == '57D' else 22775   # fitted: Devonshire Cemetery on the British front line at Mansel Copse, Fricourt and Mametz
    return c * 6000 + (sc + fx) * 1000, s0 + r * 6000 + (sr + fy) * 1000

# local metres from yards, via the Schwaben sheet fit (R19 NW corner at sheet pixel (177, 41))
T = json.load(open(f'{ROOT}/data/thiepval.json'))['fit']
def sch_local(u, v):
    c, s = np.cos(T['th']), np.sin(T['th']); du, dv = u - T['uc'], v - T['vc']
    return np.array([T['X0'] + T['s'] * (c * du - s * dv), T['Z0'] + T['s'] * (s * du + c * dv)])
A = sch_local(177, 41)
ex = sch_local(178, 41) - A; ex /= np.hypot(*ex)       # grid east in local metres
sy = sch_local(177, 42) - A; sy /= np.hypot(*sy)       # grid south
E0, S0 = grid('57D', 'R', 19)
def yards_to_local(E, S):
    return A + ex * (np.asarray(E) - E0)[..., None] * YD + sy * (np.asarray(S) - S0)[..., None] * YD

# screenshots: file, sheet, a labelled corner (pixel, square), approximate px per 1000 yd, map area to use
SHOTS = {
  '07': dict(sheet='57D', px=(768, 177), sq=('X', 13), sp=185, area=(0, 118, 1904, 735), date='28 Apr 1916'),
  '08': dict(sheet='57D', px=(930, 490), sq=('X', 1), sp=185, area=(0, 118, 1904, 875), date='28 Apr 1916'),
  '09': dict(sheet='57D', px=(1068, 197), sq=('R', 1), sp=187, area=(0, 200, 1904, 875), date='28 Apr 1916'),
  '10': dict(sheet='57D', px=(1010, 340), sq=('L', 19), sp=139, area=(0, 118, 1765, 760), date='16 May 1916'),
  '11': dict(sheet='57D', px=(997, 405), sq=('L', 13), sp=139, area=(0, 118, 1752, 875), date='16 May 1916'),
  '12': dict(sheet='57D', px=(1015, 447), sq=('F', 13), sp=140, area=(0, 178, 1770, 875), date='16 May 1916'),
  '13': dict(sheet='62D', px=(257, 695), sq=('F', 15), sp=270, area=(0, 156, 1197, 841), date='25 Apr 1916'),
}
MASKS = {  # interface and stray marks to ignore (x0, y0, x1, y1)
  '*': [(0, 118, 32, 180), (1750, 720, 1904, 875)],
  '10': [(0, 220, 62, 250)], '11': [(0, 220, 62, 250)], '12': [(0, 220, 62, 250), (1640, 810, 1904, 875)],
  '07': [(1780, 118, 1904, 400)],
}

def path(k): return f'{ROOT}/refs/nls/{k}.' + ('png' if k == '13' else 'jpg')

def refine(k):
    """lock the lattice onto the printed grid: maximise darkness along predicted grid lines"""
    S = SHOTS[k]; im = np.array(Image.open(path(k)).convert('RGB')).astype(float)
    g = im.mean(2); dark = np.clip((200 - g) / 120, 0, 1) * (np.abs(im[..., 0] - im[..., 2]) < 50)
    x0, y0, x1, y1 = S['area']; H, W = g.shape
    def score(u0, v0, sp, th):
        c, s = np.cos(th), np.sin(th); tot = 0; n = 0
        for a in range(-12, 13):
            for vert in (True, False):
                ts = np.arange(-2000, 2000, 3.0)
                if vert: xs, ys = u0 + a * sp * c - ts * s, v0 + a * sp * s + ts * c
                else: xs, ys = u0 + ts * c - a * sp * s, v0 + ts * s + a * sp * c
                m = (xs > x0 + 2) & (xs < x1 - 2) & (ys > y0 + 2) & (ys < y1 - 2)
                if m.sum() < 30: continue
                v = dark[ys[m].astype(int), xs[m].astype(int)]
                # a printed line is darker than its surroundings just beside it
                side = dark[np.clip(ys[m] + (0 if vert else 3), 0, H - 1).astype(int), np.clip(xs[m] + (3 if vert else 0), 0, W - 1).astype(int)]
                tot += (v - side).sum(); n += m.sum()
        return tot / max(1, n)
    best = (score(*S['px'], S['sp'], 0.0), *S['px'], S['sp'], 0.0)
    for step in [(4, 0.02, 0.004), (2, 0.008, 0.002), (1, 0.004, 0.001), (0.5, 0.002, 0.0005)]:
        improved = True
        while improved:
            improved = False
            _, u, v, sp, th = best
            for du in (-step[0], 0, step[0]):
                for dv in (-step[0], 0, step[0]):
                    for ds in (-step[1], 0, step[1]):
                        for dt in (-step[2], 0, step[2]):
                            c = (u + du, v + dv, sp * (1 + ds), th + dt)
                            sc = score(*c)
                            if sc > best[0] + 1e-6: best = (sc, *c); improved = True
    return best

def transform(k, fit):
    """pixel -> local metres for screenshot k"""
    _, u0, v0, sp, th = fit; S = SHOTS[k]
    E0k, S0k = grid(S['sheet'], *S['sq'])
    c, s = np.cos(th), np.sin(th)
    def f(u, v):
        du, dv = np.asarray(u) - u0, np.asarray(v) - v0
        e = (c * du + s * dv) / sp * 1000; n = (-s * du + c * dv) / sp * 1000
        return yards_to_local(E0k + e, S0k + n)
    return f

if __name__ == '__main__':
    out = {}
    for k in (sys.argv[1:] or SHOTS):
        fit = refine(k); out[k] = [float(x) for x in fit]
        print(k, 'score %.3f' % fit[0], 'corner (%.1f, %.1f)' % (fit[1], fit[2]), 'px/1000yd %.1f' % fit[3], 'rot %.2f deg' % np.degrees(fit[4]))
    old = {}
    try: old = json.load(open(f'{ROOT}/data/sheetfits.json'))
    except Exception: pass
    old.update(out); json.dump(old, open(f'{ROOT}/data/sheetfits.json', 'w'), indent=1)
