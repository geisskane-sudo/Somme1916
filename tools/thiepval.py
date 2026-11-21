# Georeferenced trench lines from the 1:5000 Schwaben Redoubt sheet (Edition 1, trenches corrected
# to 20-10-16) -> data/thiepval.json and web/thiepval_map.jpg.
# Fit: scale from the sheet's 1000-yard grid (298 px = 914.4 m); position and rotation fitted so the
# sheet's German front line (traced by hand below) matches the front line traced from the 1:20000
# sheets; checked by the Thiepval Memorial landing on the chateau site.
import json, sys, numpy as np, cv2
from PIL import Image
from skimage.morphology import skeletonize
ROOT = '/home/claude/somme-1july'
SRC = f'{ROOT}/refs/thiepval/schwaben_1-5000_ed1_corrected_1916-10-20.png'
FIT = dict(uc=425, vc=340, X0=-2247.1, Z0=261.8, th=np.radians(-3.0), s=3.07)
FRAME = (30, 43, 771, 641)          # map frame in sheet pixels
FRONT_PX = [(281,643),(285,620),(288,577),(302,547),(312,513),(318,497),(340,457),(352,443),(362,428),(363,400),(357,363),(353,340),(347,320),(343,305),(325,290),(300,265),(265,245),(230,238),(195,237)]
MASK_OUT = [(368,220,440,248), (70,240,150,262), (650,240,760,262)]  # red lettering: 'Schwaben Redoubt', the dug-out note, '(Unsurveyed)'

def to_local(u, v):
    c, s_ = np.cos(FIT['th']), np.sin(FIT['th']); du = np.asarray(u) - FIT['uc']; dv = np.asarray(v) - FIT['vc']
    return FIT['X0'] + FIT['s'] * (c * du - s_ * dv), FIT['Z0'] + FIT['s'] * (s_ * du + c * dv)

im = np.array(Image.open(SRC).convert('RGB')).astype(int)
r, g, b = im[..., 0], im[..., 1], im[..., 2]
red = ((r - g) > 18) & ((r - b) > 24) & (r > 100) & (r - g > 0.25 * (255 - g))
x0, y0, x1, y1 = FRAME
red[:y0, :] = False; red[y1:, :] = False; red[:, :x0] = False; red[:, x1:] = False
for a, b_, c_, d_ in MASK_OUT: red[b_:d_, a:c_] = False
m = cv2.morphologyEx(red.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
for i in range(1, n):
    if st[i, cv2.CC_STAT_AREA] < 25: m[lab == i] = 0
sk = skeletonize(m > 0)
H, W = sk.shape
nb = [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]
def neigh(y, x): return [(y+dy, x+dx) for dy, dx in nb if 0 <= y+dy < H and 0 <= x+dx < W and sk[y+dy, x+dx]]
deg = {(y, x): len(neigh(y, x)) for y, x in zip(*np.nonzero(sk))}
seen = set(); paths = []
def walk(start, nxt):
    path = [start, nxt]; seen.add((start, nxt)); seen.add((nxt, start)); prev, cur = start, nxt
    while deg.get(cur, 0) == 2:
        cand = [q for q in neigh(*cur) if q != prev and (cur, q) not in seen]
        if not cand: break
        prev, cur = cur, cand[0]; seen.add((prev, cur)); seen.add((cur, prev)); path.append(cur)
    return path
for p, d in deg.items():
    if d != 2:
        for q in neigh(*p):
            if (p, q) not in seen: paths.append(walk(p, q))
for p, d in deg.items():  # closed loops
    if d == 2:
        for q in neigh(*p):
            if (p, q) not in seen: paths.append(walk(p, q))
# join path ends that nearly meet (gaps left by broken ink), end to end, while the result stays straight-ish
paths = [np.array([[x, y] for y, x in P], float) for P in paths if len(P) >= 3]
def ends(P): return [(P[0], P[0] - P[min(4, len(P) - 1)]), (P[-1], P[-1] - P[max(-5, -len(P))])]
merged = True
while merged:
    merged = False
    for i in range(len(paths)):
        for j in range(i + 1, len(paths)):
            A, B = paths[i], paths[j]
            for ai, (pa, da) in enumerate(ends(A)):
                for bi, (pb, db) in enumerate(ends(B)):
                    gap = pb - pa; L = np.hypot(*gap)
                    if L > 9 or L < 1e-6: continue
                    na, nb_ = da / (np.hypot(*da) + 1e-9), db / (np.hypot(*db) + 1e-9)
                    if np.dot(na, gap / L) < 0.5 or np.dot(nb_, -gap / L) < 0.5: continue
                    A2 = A if ai == 1 else A[::-1]; B2 = B if bi == 0 else B[::-1]
                    paths[i] = np.vstack([A2, B2]); paths.pop(j); merged = True; break
                if merged: break
            if merged: break
        if merged: break
out = []
for P in paths:
    if len(P) < 8: continue
    pts = P.astype(np.float32).reshape(-1, 1, 2)
    pts = cv2.approxPolyDP(pts, 0.7, False).reshape(-1, 2)
    X, Z = to_local(pts[:, 0], pts[:, 1])
    out.append([[round(float(x), 1), round(float(z), 1)] for x, z in zip(X, Z)])
fx, fz = to_local([p[0] for p in FRONT_PX], [p[1] for p in FRONT_PX])
corners = [to_local(u, v) for u, v in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]]
json.dump({'source': 'Schwaben Redoubt 1:5000, Edition 1, trenches corrected to 20-10-16 (sheet 57D SE, squares Q24, R19, R20, R25, R26, Q30)',
           'fit': {k: float(v) for k, v in FIT.items()}, 'frame_px': FRAME, 'size_px': [W, H],
           'corners': [[round(float(x), 1), round(float(z), 1)] for x, z in corners],
           'front': [[round(float(x), 1), round(float(z), 1)] for x, z in zip(fx, fz)], 'trenches': out},
          open(f'{ROOT}/data/thiepval.json', 'w'))
# the sheet itself, as an overlay image (whole sheet; the client maps pixels with the fit)
Image.open(SRC).convert('RGB').save(f'{ROOT}/web/thiepval_map.jpg', quality=85)
print(len(out), 'trench lines;', sum(len(p) for p in out), 'points')
