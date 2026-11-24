# The 1916 trench maps as one underlay: every screenshot resampled into local metres at 5 m per pixel, each place
# taken from the screenshot that owns it (as for the trenches: nearest map centre, fill-only screenshots last).
# Ground no screenshot covers is black, which the terrain shader treats as "no map". Output: web/map1916.jpg and
# src/map1916.ts (its extent).
import os, sys, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
import sheets
from trenches import centre, inside, FILL_ONLY
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fits = json.load(open(f'{ROOT}/data/sheetfits.json'))
M = 5.0

def inverse(k):
    """local -> pixel for screenshot k (affine before the warp to the ground)"""
    f = sheets.transform(k, fits[k], raw=True); P = np.array([[0, 0], [1000, 0], [0, 1000]], float); X = f(P[:, 0], P[:, 1])
    A = np.linalg.solve(np.c_[X, np.ones(3)], P)
    def inv(x, z): q = sheets.unwarp(np.c_[x, z]); return np.c_[q, np.ones(len(x))] @ A
    return inv

if __name__ == '__main__':
    keys = list(sheets.SHOTS); geo = {k: centre(k) for k in keys}
    C = np.array([c for k in keys for c in geo[k][1]])
    x0, z0 = np.floor(C.min(0) / 100) * 100; x1, z1 = np.ceil(C.max(0) / 100) * 100
    W, H = int((x1 - x0) / M), int((z1 - z0) / M)
    xs = x0 + (np.arange(W) + 0.5) * M; zs = z0 + (np.arange(H) + 0.5) * M
    X, Z = np.meshgrid(xs, zs); P = np.c_[X.ravel(), Z.ravel()]
    # owner of each pixel
    from matplotlib.path import Path
    cov = {k: Path(np.array(geo[k][1])).contains_points(P) for k in keys}
    d = {k: np.hypot(P[:, 0] - geo[k][0][0], P[:, 1] - geo[k][0][1]) for k in keys}
    best = np.full(len(P), -1); bd = np.full(len(P), np.inf)
    for rank in (0, 1):                                   # main screenshots first, then fill-only ones where nothing else
        for i, k in enumerate(keys):
            if (k in FILL_ONLY) != (rank == 1): continue
            m = cov[k] & (d[k] < bd) & ((best < 0) if rank == 1 else True)
            best[m] = i; bd[m] = d[k][m]
    out = np.zeros((len(P), 3), np.uint8)
    for i, k in enumerate(keys):
        m = best == i
        if not m.any(): continue
        im = np.array(Image.open(sheets.path(k)).convert('RGB'))
        uv = inverse(k)(P[m, 0], P[m, 1]); u = np.clip(np.round(uv[:, 0]).astype(int), 0, im.shape[1] - 1); v = np.clip(np.round(uv[:, 1]).astype(int), 0, im.shape[0] - 1)
        # bilinear
        uf, vf = uv[:, 0] - np.floor(uv[:, 0]), uv[:, 1] - np.floor(uv[:, 1]); u0 = np.clip(np.floor(uv[:, 0]).astype(int), 0, im.shape[1] - 2); v0 = np.clip(np.floor(uv[:, 1]).astype(int), 0, im.shape[0] - 2)
        c = (im[v0, u0] * ((1 - uf) * (1 - vf))[:, None] + im[v0, u0 + 1] * (uf * (1 - vf))[:, None] + im[v0 + 1, u0] * ((1 - uf) * vf)[:, None] + im[v0 + 1, u0 + 1] * (uf * vf)[:, None])
        c = np.clip(c, 8, 255).astype(np.uint8)          # never pure black on the map itself
        mask = np.zeros(im.shape[:2], bool)              # the screenshot's buttons and insets
        for a, b, cc, dd in sheets.MASKS['*'] + sheets.MASKS.get(k, []): mask[b:dd, a:cc] = True
        c[mask[v, u]] = 0
        out[m] = c
        print(k, m.sum(), 'pixels', flush=True)
    Image.fromarray(out.reshape(H, W, 3)).save(f'{ROOT}/web/map1916.jpg', quality=86, optimize=True)
    open(f'{ROOT}/src/map1916.ts', 'w').write(f'// extent of web/map1916.jpg in local metres (tools/mapmosaic.py)\nexport const MAP1916 = {{ x0: {x0:.0f}, z0: {z0:.0f}, x1: {x1:.0f}, z1: {z1:.0f} }};\n')
    print('map1916.jpg', W, 'x', H, round(os.path.getsize(f'{ROOT}/web/map1916.jpg') / 1e6, 1), 'MB')
