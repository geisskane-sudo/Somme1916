# Roads from the NLS trench-map screenshots. The Ordnance Survey drew roads as two parallel lines with
# paper between them; at screenshot resolution they can't be picked out reliably on their own, so each road
# is found as the best path between two points that are known to be on it, through a "double line"
# response map (an oriented filter that scores two inked lines a few pixels apart with paper between):
#  - the hand-placed main roads (data/geography_src.json), vertex to vertex;
#  - neighbouring villages, nearest pairs first, kept only if the path is fairly direct, mostly on
#    double-line ink, and not just a repeat of a road already found.
# Output: data/roads.json, centrelines in local metres.
import os, sys, json, math, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
from skimage.graph import route_through_array
import sheets
from trenches import centre, inside

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fits = json.load(open(f'{ROOT}/data/sheetfits.json'))
KX = 111320 * math.cos(math.radians(50.06)); KZ = 110574
ll2xz = lambda ll: np.array([(ll[1] - 2.72) * KX, -(ll[0] - 50.06) * KZ])
MANUAL_STRAIGHT = {'07': [(470, 655), (955, 312)]}   # Albert to La Boisselle, pixels on 57D.SE
CACHE = '/tmp/roadness'; os.makedirs(CACHE, exist_ok=True)

def roadness(k, gaps=(2.0, 2.5, 3.0), L=15):
    fn = f'{CACHE}/{k}.npy'
    if os.path.exists(fn): return np.load(fn)
    im = np.array(Image.open(sheets.path(k)).convert('RGB')).astype(np.float32)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    ink = np.clip((215 - (r + g + b) / 3) / 120, 0, 1)
    ink *= (np.abs(r - g) < 30) & (b <= r + 10) & ~((r - g > 35) & (r - b > 25))   # grey ink: not water, not trenches
    # the map's grid lines run straight across the sheet: find and erase them so roads aren't routed along them
    lines = cv2.HoughLinesP((ink > 0.35).astype(np.uint8) * 255, 1, np.pi / 720, 200, minLineLength=260, maxLineGap=6)
    if lines is not None:
        m = np.zeros(ink.shape, np.uint8)
        for x1, y1, x2, y2 in lines.reshape(-1, 4):
            a = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1))) % 90
            if min(a, 90 - a) < 4: cv2.line(m, (int(x1), int(y1)), (int(x2), int(y2)), 1, 3)   # grid lines run with the sheet's axes
        ink[m > 0] = 0
    best = np.zeros(ink.shape, np.float32)
    for gap in gaps:
        for ai in range(16):
            a = ai * np.pi / 16; ux, uy = np.cos(a), np.sin(a); nx, ny = -uy, ux
            R = int(L / 2 + gap + 2); K = np.zeros((2 * R + 1, 2 * R + 1), np.float32); K1 = K.copy(); K2 = K.copy()
            for t in np.linspace(-L / 2, L / 2, int(L) * 2):
                for off, w, KK in [(-gap, 1.0, K1), (gap, 1.0, K2), (0, -1.4, None)]:
                    xi, yi = int(round(R + ux * t + nx * off)), int(round(R + uy * t + ny * off))
                    K[yi, xi] += w
                    if KK is not None: KK[yi, xi] += 1
            resp = cv2.filter2D(ink, -1, K / np.abs(K).sum())
            side = np.minimum(cv2.filter2D(ink, -1, K1 / K1.sum()), cv2.filter2D(ink, -1, K2 / K2.sum()))
            best = np.maximum(best, np.minimum(resp, side * 0.6))
    best = cv2.GaussianBlur(best, (0, 0), 1.0)
    np.save(fn, best); return best

class Sheet:
    def __init__(self, k):
        self.k = k; self.S = sheets.SHOTS[k]; self.f = sheets.transform(k, fits[k])
        self.rn = roadness(k); H, W = self.rn.shape
        x0, y0, x1, y1 = self.S['area']
        self.cost = 1.0 / (0.015 + np.clip(self.rn, 0, None))
        self.cost[:y0 + 3] = 1e4; self.cost[y1 - 3:] = 1e4; self.cost[:, :x0 + 3] = 1e4; self.cost[:, x1 - 3:] = 1e4
        uu, vv = np.meshgrid(np.arange(0, W, 2), np.arange(0, H, 2)); self.uu, self.vv = uu, vv; self.XZ = self.f(uu.astype(float), vv.astype(float))
        self.used = np.zeros((H, W), np.uint8)
    def px(self, p):
        d = np.hypot(self.XZ[..., 0] - p[0], self.XZ[..., 1] - p[1]); i = np.unravel_index(d.argmin(), d.shape)
        r, c = self.vv[i], self.uu[i]; x0, y0, x1, y1 = self.S['area']
        if d.min() > 10 or not (x0 + 6 < c < x1 - 6 and y0 + 6 < r < y1 - 6): return None
        # nudge onto the nearest strong double-line response (a village street, the road itself)
        R = 8; win = self.rn[r - R:r + R + 1, c - R:c + R + 1]; j = np.unravel_index(win.argmax(), win.shape)
        return (r - R + j[0], c - R + j[1])
    def route(self, a, b):
        # stay within a corridor round the straight line between the ends
        r0, c0 = max(0, min(a[0], b[0]) - 60), max(0, min(a[1], b[1]) - 60)
        sub = self.cost[r0:max(a[0], b[0]) + 61, c0:max(a[1], b[1]) + 61].copy()
        rr, cc = np.mgrid[0:sub.shape[0], 0:sub.shape[1]]; ar, ac, br_, bc = a[0] - r0, a[1] - c0, b[0] - r0, b[1] - c0
        L = max(1.0, np.hypot(br_ - ar, bc - ac)); dist = np.abs((bc - ac) * (rr - ar) - (br_ - ar) * (cc - ac)) / L
        sub[dist > 0.22 * L + 18] = 1e4
        path, _ = route_through_array(sub, (ar, ac), (br_, bc), fully_connected=True, geometric=True)
        path = [(p[0] + r0, p[1] + c0) for p in path]
        P = np.array(path); v = self.rn[P[:, 0], P[:, 1]]
        L = np.hypot(a[0] - b[0], a[1] - b[1]); seg = np.sum(np.hypot(*np.diff(P, axis=0).T))
        return P, (v > 0.08).mean(), seg / max(L, 1)
    def to_local(self, P):
        Q = cv2.approxPolyDP(P[:, ::-1].astype(np.float32).reshape(-1, 1, 2), 0.9, False).reshape(-1, 2)
        return self.f(Q[:, 0].astype(float), Q[:, 1].astype(float))

def clean(roads, min_piece=150.0):
    """drop stretches that run along the map's grid lines (the tracer can lock onto them): segments within 2.5 degrees
    of the grid's axes and longer than 60 m, then any piece left shorter than min_piece"""
    out = []
    for r in roads:
        if r['kind'] == 'main' and len(r['p']) == 2: out.append(r); continue          # the straight Albert-Bapaume road
        P = np.array(r['p'], float); pieces = [[P[0]]]
        for a, b in zip(P[:-1], P[1:]):
            d = b - a; L = np.hypot(*d); ang = np.degrees(np.arctan2(d[1], d[0])) % 90
            on_grid = min((ang - 87) % 90, (87 - ang) % 90) < 2.5 and L > 60
            if on_grid: pieces.append([b])
            else: pieces[-1].append(b)
        for q in pieces:
            q = np.array(q)
            if len(q) > 1 and np.hypot(*np.diff(q, axis=0).T).sum() >= min_piece:
                out.append({**r, 'p': [[round(float(x), 1), round(float(z), 1)] for x, z in q]})
    return out

# roads read by eye where the tracer misses them: sheet, pixels along the road
MANUAL = {
    'Mill Road': ('14', [(268, 262), (300, 300), (335, 333), (372, 340), (430, 345), (470, 350)]),
    'Thiepval Road': ('14', [(470, 350), (520, 376), (570, 402), (620, 440), (660, 482), (700, 530)]),
}
def manual():
    out = []
    for name, (k, pts) in MANUAL.items():
        P = np.array(pts, float); X = sheets.transform(k, fits[k])(P[:, 0], P[:, 1])
        out.append({'kind': 'road', 'sheet': k, 'name': name, 'p': [[round(float(x), 1), round(float(z), 1)] for x, z in X]})
    return out

if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == '--clean':
    R = json.load(open(f'{ROOT}/data/roads.json')); n0 = len(R['roads'])
    R['roads'] = clean([r for r in R['roads'] if 'name' not in r]) + manual()
    json.dump(R, open(f'{ROOT}/data/roads.json', 'w')); print(n0, '->', len(R['roads']), 'pieces'); sys.exit()

if __name__ == '__main__':
    g = json.load(open(f'{ROOT}/data/geography_src.json'))
    keys = list(sheets.SHOTS); geo = {k: centre(k) for k in keys}
    SH = {k: Sheet(k) for k in keys}; print('response maps ready', flush=True)
    def sheet_for(a, b):
        mid = (a + b) / 2; cover = [k for k in keys if inside(a, geo[k][1]) and inside(b, geo[k][1])]
        return min(cover, key=lambda k: np.hypot(*(mid - geo[k][0]))) if cover else None
    out = []
    def add(a, b, kind, strict):
        k = sheet_for(a, b)
        if not k: return False
        s = SH[k]; pa, pb = s.px(a), s.px(b)
        if pa is None or pb is None: return False
        P, good, ratio = s.route(pa, pb)
        if strict and (ratio > 1.4 or good < 0.6): return False
        if not strict and (ratio > 1.35 or good < 0.7): return False    # a main-road leg that wanders isn't the road
        if strict:
            if s.used[P[:, 0], P[:, 1]].mean() > 0.5: return False       # mostly an existing road
        s.used[P[:, 0], P[:, 1]] = 1; s.used = cv2.dilate(s.used, np.ones((5, 5), np.uint8))
        X = s.to_local(P); out.append({'kind': kind, 'sheet': k, 'p': [[round(float(x), 1), round(float(z), 1)] for x, z in X]}); return True
    # the Albert-Bapaume road is a straight Roman road: on each sheet, fit one straight line to the
    # double-line response along the hand-placed line, and draw that
    def straight(r):
        V = np.array([ll2xz(p) for p in r['pts']]); n = 0
        for k in keys:
            s = SH[k]; x0, y0, x1, y1 = s.S['area']
            if k in MANUAL_STRAIGHT:      # where the fit finds a neighbouring line instead, the road read off the sheet by eye
                E = np.array(MANUAL_STRAIGHT[k], float); X2 = s.f(E[:, 0], E[:, 1])
                out.append({'kind': 'main', 'sheet': k, 'p': [[round(float(x), 1), round(float(z), 1)] for x, z in X2]}); n += 1; continue
            ys, xs = np.nonzero(s.rn > 0.07)
            sel = (xs > x0 + 5) & (xs < x1 - 5) & (ys > y0 + 5) & (ys < y1 - 5); ys, xs = ys[sel], xs[sel]
            if len(xs) < 50: continue
            X = s.f(xs.astype(float), ys.astype(float))
            # distance of each candidate pixel to the hand line
            d = np.full(len(X), 1e9)
            for i in range(1, len(V)):
                a, b = V[i - 1], V[i]; ab = b - a; t = np.clip(((X - a) @ ab) / (ab @ ab), 0, 1); d = np.minimum(d, np.hypot(*(X - (a + t[:, None] * ab)).T))
            near = d < 250
            if near.sum() < 40: continue
            P = np.c_[xs[near], ys[near]].astype(float); rng = np.random.default_rng(1); best = (0, None)
            for _ in range(400):
                i, j = rng.choice(len(P), 2, replace=False); u = P[j] - P[i]; L = np.hypot(*u)
                if L < 60: continue
                nrm = np.array([-u[1], u[0]]) / L; inl = np.abs((P - P[i]) @ nrm) < 2.0
                if inl.sum() > best[0]: best = (inl.sum(), inl)
            if best[1] is None or best[0] < 60: continue
            Q = P[best[1]]; m = Q.mean(0); _, _, vt = np.linalg.svd(Q - m); u = vt[0]; t = (Q - m) @ u
            # keep the run of inliers without long gaps
            t = np.sort(t); gaps = np.diff(t); cut = np.nonzero(gaps > 160)[0]
            seg = np.split(t, cut + 1); t = max(seg, key=lambda q: q[-1] - q[0])
            E = np.array([m + u * t[0], m + u * t[-1]]); X2 = s.f(E[:, 0], E[:, 1])
            out.append({'kind': 'main', 'sheet': k, 'p': [[round(float(x), 1), round(float(z), 1)] for x, z in X2]}); n += 1
            s.used[np.clip(np.round(Q[:, 1]).astype(int), 0, s.used.shape[0] - 1), np.clip(np.round(Q[:, 0]).astype(int), 0, s.used.shape[1] - 1)] = 1
        print(r['name'], 'straight on', n, 'sheets', flush=True)
    # the main roads, vertex to vertex (densified so each leg stays on one sheet)
    for r in g['roads']:
        if r['name'] == 'Albert-Bapaume road': straight(r); continue
        V = np.array([ll2xz(p) for p in r['pts']]); D = [V[0]]
        for i in range(1, len(V)):
            n = max(1, int(np.hypot(*(V[i] - V[i - 1])) / 350)); D += [V[i - 1] + (V[i] - V[i - 1]) * (j + 1) / n for j in range(n)]
        n = 0
        for i in range(1, len(D)): n += add(D[i - 1], D[i], 'main', False)
        print(r['name'], n, 'of', len(D) - 1, 'legs', flush=True)
    # roads between neighbouring villages, nearest first
    P = [(p['name'], ll2xz(p['ll'])) for p in g['places']]
    pairs = sorted(((np.hypot(*(a[1] - b[1])), a, b) for i, a in enumerate(P) for b in P[i + 1:]), key=lambda t: t[0])
    for d, a, b in pairs:
        if d > 3200: break
        if add(a[1], b[1], 'road', True): print(' ', a[0], '-', b[0], int(d), flush=True)
    out = clean(out)
    json.dump({'source': 'Roads traced from NLS British trench maps 1:20,000 (CC-BY National Library of Scotland), tools/roads.py', 'roads': out},
              open(f'{ROOT}/data/roads.json', 'w'))
    print('total', len(out))
