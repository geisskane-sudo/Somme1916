# German trench network for the whole front, from the georeferenced NLS trench-map screenshots
# (tools/sheets.py) -> data/trenches.json. Red ink is extracted, thinned to centre lines, traced
# into polylines, gaps in broken ink joined, and converted to local metres. Where screenshots
# overlap, each place is taken from the screenshot whose map area centre is nearest.
import json, sys, numpy as np, cv2
from PIL import Image
from skimage.morphology import skeletonize
from scipy.spatial import cKDTree
sys.path.insert(0, '/home/claude/somme-1july/tools')
import sheets
ROOT = '/home/claude/somme-1july'
fits = json.load(open(f'{ROOT}/data/sheetfits.json'))
EXTRA_MASK = {  # red lettering and other red marks that are not trenches (x0, y0, x1, y1)
  '07': [(1700, 240, 1790, 320), (1780, 330, 1904, 370)],   # supply dump shading, its note
  '09': [(1340, 130, 1700, 170)], '12': [(1150, 130, 1440, 165)],
}

def extract(k):
    S = sheets.SHOTS[k]
    im = np.array(Image.open(sheets.path(k)).convert('RGB')).astype(int)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    red = ((r - g) > 28) & ((r - b) > 30) & (r > 140)
    x0, y0, x1, y1 = S['area']
    keep = np.zeros_like(red); keep[y0:y1, x0:x1] = True
    for a, b_, c_, d_ in sheets.MASKS['*'] + sheets.MASKS.get(k, []) + EXTRA_MASK.get(k, []): keep[b_:d_, a:c_] = False
    red &= keep
    m = cv2.morphologyEx(red.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    for i in range(1, n):
        w, h = st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]
        if st[i, cv2.CC_STAT_AREA] < 18 or max(w, h) < 9: m[lab == i] = 0   # specks, numbers and small lettering
    sk = skeletonize(m > 0)
    H, W = sk.shape
    ys, xs = np.nonzero(sk); on = set(zip(ys.tolist(), xs.tolist()))
    nb = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    neigh = lambda p: [(p[0] + dy, p[1] + dx) for dy, dx in nb if (p[0] + dy, p[1] + dx) in on]
    deg = {p: len(neigh(p)) for p in on}
    seen = set(); paths = []
    def walk(a, c):
        P = [a, c]; seen.add((a, c)); seen.add((c, a)); prev, cur = a, c
        while deg[cur] == 2:
            nx = [q for q in neigh(cur) if q != prev and (cur, q) not in seen]
            if not nx: break
            prev, cur = cur, nx[0]; seen.add((prev, cur)); seen.add((cur, prev)); P.append(cur)
        return P
    for p, d in deg.items():
        if d != 2:
            for q in neigh(p):
                if (p, q) not in seen: paths.append(walk(p, q))
    for p, d in deg.items():
        if d == 2:
            for q in neigh(p):
                if (p, q) not in seen: paths.append(walk(p, q))
    paths = [np.array([[x, y] for y, x in P], float) for P in paths if len(P) >= 3]
    # join ends that nearly meet, heading the same way (broken ink)
    gap = max(6, S['sp'] / 185 * 7)
    joined = True
    while joined:
        joined = False
        ends = []
        for i, P in enumerate(paths):
            if len(P) < 2: continue
            ends.append((i, 0, P[0], P[0] - P[min(4, len(P) - 1)]))
            ends.append((i, 1, P[-1], P[-1] - P[max(-5, -len(P))]))
        if not ends: break
        tree = cKDTree(np.array([e[2] for e in ends]))
        used = set(); merges = []
        for a, (i, ai, pa, da) in enumerate(ends):
            if i in used: continue
            for bidx in tree.query_ball_point(pa, gap):
                j, bi, pb, db = ends[bidx]
                if j == i or j in used: continue
                d = pb - pa; L = np.hypot(*d)
                if L < 1e-6: continue
                na, nb_ = da / (np.hypot(*da) + 1e-9), db / (np.hypot(*db) + 1e-9)
                if np.dot(na, d / L) < 0.45 or np.dot(nb_, -d / L) < 0.45: continue
                merges.append((i, ai, j, bi)); used.add(i); used.add(j); break
        if merges:
            joined = True
            gone = set()
            for i, ai, j, bi in merges:
                A = paths[i] if ai == 1 else paths[i][::-1]; B = paths[j] if bi == 0 else paths[j][::-1]
                paths[i] = np.vstack([A, B]); gone.add(j)
            paths = [P for t, P in enumerate(paths) if t not in gone]
    out = []
    f = sheets.transform(k, fits[k])
    for P in paths:
        L = np.sum(np.hypot(*np.diff(P, axis=0).T))
        if L < 12 * S['sp'] / 185: continue          # under ~60 m of line: lettering, wire knots
        Q = cv2.approxPolyDP(P.astype(np.float32).reshape(-1, 1, 2), 0.8, False).reshape(-1, 2)
        out.append((Q, f(Q[:, 0], Q[:, 1])))
    return out

def centre(k):
    x0, y0, x1, y1 = sheets.SHOTS[k]['area']; f = sheets.transform(k, fits[k])
    return np.array(f((x0 + x1) / 2, (y0 + y1) / 2)), [np.array(f(u, v)) for u, v in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]]

def inside(p, poly):
    c = False
    for i in range(len(poly)):
        a, b = poly[i], poly[i - 1]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]: c = not c
    return c

if __name__ == '__main__':
    keys = list(sheets.SHOTS)
    geo = {k: centre(k) for k in keys}
    lines = []
    for k in keys:
        got = extract(k); n0 = len(lines)
        for Q, X in got:
            # keep the parts of the line this screenshot owns (nearest centre among screenshots covering the point)
            own = []
            for p in X:
                cover = [j for j in keys if inside(p, geo[j][1])]
                best = min(cover or [k], key=lambda j: np.hypot(*(p - geo[j][0])))
                own.append(best == k)
            seg = []
            for p, o in zip(X, own):
                if o: seg.append([round(float(p[0]), 1), round(float(p[1]), 1)])
                elif len(seg) > 1: lines.append({'sheet': k, 'p': seg}); seg = []
                else: seg = []
            if len(seg) > 1: lines.append({'sheet': k, 'p': seg})
        print(k, len(got), 'traced,', len(lines) - n0, 'kept', flush=True)
    meta = {k: {'sheet': sheets.SHOTS[k]['sheet'], 'date': sheets.SHOTS[k]['date'], 'fit': fits[k], 'corners': [[round(float(c[0]), 1), round(float(c[1]), 1)] for c in geo[k][1]]} for k in keys}
    json.dump({'source': 'German trenches traced from NLS British trench maps 1:20,000 (57D NE ed. 2B, 16 May 1916; 57D SE ed. 2B, 28 Apr 1916; 62D NE ed. 2B, 25 Apr 1916), CC-BY National Library of Scotland',
               'sheets': meta, 'lines': lines}, open(f'{ROOT}/data/trenches.json', 'w'))
    print('total', len(lines), 'lines,', sum(len(l['p']) for l in lines), 'points')
