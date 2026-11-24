# The Ancre, traced along the valley floor of the IGN RGE ALTI 5 m terrain (the river runs on the lowest ground,
# with its marshes and lakes) between the ends of the hand-placed line, kept within a corridor round it.
# Output: data/ancre.json (lat/lon), applied by tools/prep.py.
#   python3 tools/ancre.py <folder of RGEALTI .asc tiles>
import os, sys, json, math, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rgealti import mosaic, bilinear, l93, to_ll, LAT0, LON0, KX, KZ
from skimage.graph import route_through_array
from scipy.ndimage import minimum_filter, gaussian_filter
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STEP = 10.0

if __name__ == '__main__':
    g = json.load(open(f'{ROOT}/data/geography_src.json'))
    A = np.array([((p[1] - LON0) * KX, -(p[0] - LAT0) * KZ) for p in g['ancre']])
    M, x0m, ytop, cs = mosaic(sys.argv[1])
    x0, z0 = A.min(0) - 900; x1, z1 = A.max(0) + 900
    xs = np.arange(x0, x1, STEP); zs = np.arange(z0, z1, STEP); X, Z = np.meshgrid(xs, zs)
    lat, lon = to_ll(X, Z); E, N = l93(lat, lon); H = bilinear(M, x0m, ytop, cs, E, N)
    have = ~np.isnan(H)
    # height above the lowest ground within 400 m: near zero on the valley floor
    Hf = np.where(have, H, 1e4); Hs = gaussian_filter(np.where(have, H, np.nanmean(H)), 1.0)
    rel = Hs - minimum_filter(Hf, size=int(400 / STEP))
    # corridor: within 700 m of the hand-placed line
    from scipy.spatial import cKDTree
    D = [A[0]]
    for i in range(1, len(A)):
        n = max(1, int(np.hypot(*(A[i] - A[i - 1])) / 50)); D += [A[i - 1] + (A[i] - A[i - 1]) * (j + 1) / n for j in range(n)]
    d, _ = cKDTree(np.array(D)).query(np.c_[X.ravel(), Z.ravel()]); d = d.reshape(X.shape)
    cost = 1 + 4 * np.clip(rel, 0, 30) ** 2 + (d > 700) * 1e4 + (~have) * 50
    # trace only where the tiles have data; outside it keep the hand-placed line
    inside = lambda p: bool(have[int((p[1] - z0) / STEP), int((p[0] - x0) / STEP)])
    ins = [i for i, p in enumerate(A) if inside(p)]
    a, b = ins[0], ins[-1]
    rc = lambda p: (int((p[1] - z0) / STEP), int((p[0] - x0) / STEP))
    path, _ = route_through_array(cost, rc(A[a]), rc(A[b]), fully_connected=True, geometric=True)
    P = np.array([[x0 + c * STEP, z0 + r * STEP] for r, c in path])
    # smooth the staircase, keep a point every ~40 m
    from scipy.ndimage import gaussian_filter1d
    P = np.c_[gaussian_filter1d(P[:, 0], 14, mode='nearest'), gaussian_filter1d(P[:, 1], 14, mode='nearest')][::4]   # the floor is flat marsh: smooth out the wander
    line = np.r_[A[:a], P, A[b + 1:]]
    off = cKDTree(np.array(D)).query(P)[0]
    print('traced', len(P), 'points between hand points', a, 'and', b, '; distance from the old line: median %.0f m, max %.0f m' % (np.median(off), off.max()))
    json.dump({'source': 'Ancre along the valley floor of IGN RGE ALTI 5 m (tools/ancre.py)',
               'line': [[round(LAT0 - z / KZ, 6), round(LON0 + x / KX, 6)] for x, z in line]}, open(f'{ROOT}/data/ancre.json', 'w'))
