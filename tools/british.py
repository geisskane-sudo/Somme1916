# British front line from the blue "BRITISH FRONT LINE" on the NLS trench-map screenshots -> local metres
import json, sys, math, numpy as np, cv2
from PIL import Image
sys.path.insert(0, '/home/claude/somme-1july/tools')
import sheets
ROOT = '/home/claude/somme-1july'
fits = json.load(open(f'{ROOT}/data/sheetfits.json'))

def blue_pixels(k):
    S = sheets.SHOTS[k]
    im = np.array(Image.open(sheets.path(k)).convert('RGB')).astype(int)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    blue = ((b - r) > 12) & (b > g - 6) & (r < 175)
    x0, y0, x1, y1 = S['area']
    keep = np.zeros_like(blue); keep[y0:y1, x0:x1] = True
    for a, b_, c_, d_ in sheets.MASKS['*'] + sheets.MASKS.get(k, []): keep[b_:d_, a:c_] = False
    blue &= keep
    ys, xs = np.nonzero(blue)
    xz = sheets.transform(k, fits[k])(xs.astype(float), ys.astype(float))
    return xz, xs, ys

KX = 111320 * math.cos(math.radians(50.06)); KZ = 110574
def ll2xz(p): return ((p[1] - 2.72) * KX, -(p[0] - 50.06) * KZ)

def resample(P, step):
    P = np.asarray(P, float); d = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    s = np.arange(0, d[-1], step)
    return np.c_[np.interp(s, d, P[:, 0]), np.interp(s, d, P[:, 1])]

def trace(old, pts, step=20, lo=-500, hi=250, dz=10):
    """Viterbi track of the blue line as an offset from the old line (negative = British side)"""
    Q = resample(old, step)
    t = np.gradient(Q, axis=0); t /= np.hypot(*t.T)[:, None]
    n = np.c_[t[:, 1], -t[:, 0]]                       # normal; sign fixed below so + points to the Germans
    from scipy.spatial import cKDTree
    tree = cKDTree(Q)
    d, i = tree.query(pts, distance_upper_bound=700)
    ok = np.isfinite(d); i = i[ok]; P = pts[ok]
    off = np.einsum('ij,ij->i', P - Q[i], n[i]); along = np.einsum('ij,ij->i', P - Q[i], t[i])
    ok = np.abs(along) <= step / 2
    offs = np.arange(lo, hi + dz, dz)
    return Q, t, n, i[ok], off[ok], offs

def solve(Q, n, bi, off, offs, sign, prior=0.002, jump=0.08):
    off = off * sign
    nb, no = len(Q), len(offs)
    H = np.zeros((nb, no))
    j = np.round((off - offs[0]) / (offs[1] - offs[0])).astype(int); ok = (j >= 0) & (j < no)
    np.add.at(H, (bi[ok], j[ok]), 1)
    H = np.minimum(H, 6) / 6
    has = H.max(1) > 0.3
    score = H - prior * np.abs(offs)[None, :]
    D = np.abs(offs[:, None] - offs[None, :])
    cost = -jump * np.maximum(D - 10, 0) / 10
    V = score[0].copy(); back = np.zeros((nb, no), int)
    for b in range(1, nb):
        M = V[None, :] + cost      # [to, from]
        back[b] = M.argmax(1); V = M.max(1) + score[b]
    path = np.zeros(nb, int); path[-1] = V.argmax()
    for b in range(nb - 1, 0, -1): path[b - 1] = back[b, path[b]]
    return offs[path].astype(float), has

# Where the maps can't be followed automatically:
#  - Gommecourt (VII Corps): the 16 May sheets show the old line; the 56th Division dug a new front line
#    in no man's land at the end of May, so the existing sketch line is kept there.
#  - St Pierre Divion to Thiepval Wood: the screenshots leave a gap here, so the line is taken from the
#    1:5000 Schwaben sheet: from the marsh on the north bank, across the Ancre at the Mill Road, then
#    down the east edge of Thiepval Wood (where the 36th Division formed up).
KEEP_OLD_UNTIL = 250                      # bin (20 m steps along the old line) before which the old line is kept
ANCRE = [(-3900, -500), (-3443, 17), (-3052, 150), (-2939, 267), (-2853, 432), (-2764, 658)]

def build():
    from scipy.ndimage import gaussian_filter1d
    g = json.load(open(f'{ROOT}/data/geography_src.json'))
    old = np.array([ll2xz(p) for p in g['britishFront']])
    pts = np.concatenate([blue_pixels(k)[0] for k in sheets.SHOTS])
    Q, t, n, bi, off, offs = trace(old, pts)
    o, has = solve(Q, n, bi, off, offs, 1.0, prior=0.0002, jump=0.12)
    # fill stretches with no ink by interpolation, then smooth out the dashes and lettering
    idx = np.nonzero(has)[0]
    o = np.interp(np.arange(len(Q)), idx, o[idx])
    o = gaussian_filter1d(o, 2.5)
    # east of Mansel Copse the blue on sheet 62D.NE is a stream, not the front line: stop there
    f13 = sheets.transform('13', fits['13']); mansel = f13(np.array([818.0]), np.array([668.0]))[0]
    from scipy.spatial import cKDTree as _T
    last = int(_T(Q).query(mansel)[1])
    first = idx[idx >= KEEP_OLD_UNTIL][0]
    ramp = lambda i, a, b: np.clip((i - a) / (b - a), 0, 1)
    I = np.arange(len(Q))
    w = ramp(I, first, first + 15) * (1 - ramp(I, last - 5, last + 15))
    new = Q + n * (o * w)[:, None]
    # splice in the Ancre / Thiepval Wood stretch
    from scipy.spatial import cKDTree
    tr = cKDTree(new)
    a = tr.query(ANCRE[0])[1]; b = tr.query(ANCRE[-1])[1]
    line = np.r_[new[:a], resample(np.array(ANCRE, float), 20), new[b + 1:]]
    return line, has, Q, new

# Thiepval Wood: north and east edges from the 1:5000 Schwaben sheet, south and west from sheet 57D.SE (08)
def thiepval_wood():
    a = [sheets.sch_local(u, v) for u, v in [(20, 322), (110, 307), (160, 345), (205, 395), (250, 455)]]
    f = sheets.transform('08', fits['08'])
    b = [f(np.array([float(u)]), np.array([float(v)]))[0] for u, v in
         [(940, 230), (910, 252), (880, 275), (850, 277), (805, 272), (795, 250), (790, 210), (800, 160), (805, 118)]]
    return [to_ll(*p) for p in a + b]

def to_ll(x, z): return [round(50.06 - z / KZ, 6), round(2.72 + x / KX, 6)]

if __name__ == '__main__':
    line, has, Q, new = build()
    # keep a point every ~40 m
    line = line[::2] if len(line) % 2 else np.r_[line[::2], line[-1:]]
    json.dump({'source': 'Blue "British front line" on the NLS 1:20,000 trench maps (refs/nls, tools/british.py); '
               'Gommecourt kept from the sketch line; Ancre to Thiepval Wood from the 1:5000 Schwaben sheet.',
               'line': [to_ll(x, z) for x, z in line], 'thiepvalWood': thiepval_wood()}, open(f'{ROOT}/data/britishfront.json', 'w'))
    np.save('/tmp/tw/final.npy', line)
    print(len(line), 'points')
