# Fine terrain from IGN RGE ALTI 5 m (Licence Ouverte Etalab 2.0), resampled to a 5 m grid in local metres, kept in
# 1 km blocks along the front (within BAND metres of either front line, where the tiles have data). Where a block
# meets ground without fine data the heights blend into the whole-front grid over EDGE metres, so the meshes meet
# without a seam. Output: web/terrain.bin (uint16 decimetres per block, 201 x 201, rows by increasing z) and
# src/finedem.ts (the block list).
#   python3 tools/rgealti.py <folder of RGEALTI_FXX_*.asc tiles>
import os, sys, glob, math, json, base64, numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOX = (-5600, -3400, -300, 2600)            # x0, z0, x1, z1: Beaumont Hamel and Y Ravine to Ovillers, Thiepval in the middle
STEP, EDGE = 5.0, 150.0

LAT0, LON0 = 50.06, 2.72
KX = 111320 * math.cos(math.radians(LAT0)); KZ = 110574
def to_ll(x, z): return LAT0 - z / KZ, LON0 + x / KX

# Lambert-93 (RGF93, GRS80), conformal conic
a = 6378137.0; f = 1 / 298.257222101; e = math.sqrt(2 * f - f * f)
p1, p2, p0, l0 = map(math.radians, (44, 49, 46.5, 3)); X0, Y0 = 700000, 6600000
m_ = lambda p: np.cos(p) / np.sqrt(1 - (e * np.sin(p)) ** 2)
t_ = lambda p: np.tan(np.pi / 4 - p / 2) / ((1 - e * np.sin(p)) / (1 + e * np.sin(p))) ** (e / 2)
n = (math.log(m_(p1)) - math.log(m_(p2))) / (math.log(t_(p1)) - math.log(t_(p2)))
F = m_(p1) / (n * t_(p1) ** n); r0 = a * F * t_(p0) ** n
def l93(lat, lon):
    p, l = np.radians(lat), np.radians(lon); r = a * F * t_(p) ** n; th = n * (l - l0)
    return X0 + r * np.sin(th), Y0 + r0 - r * np.cos(th)

def mosaic(folder):
    tiles = sorted(glob.glob(os.path.join(folder, '**', '*.asc'), recursive=True))
    hdrs = []
    for fn in tiles:
        h = {}
        with open(fn) as fh:
            for _ in range(6): k, v = fh.readline().split(); h[k.lower()] = float(v)
        hdrs.append((fn, h))
    cs = hdrs[0][1]['cellsize']
    x0 = min(h['xllcorner'] for _, h in hdrs); y0 = min(h['yllcorner'] for _, h in hdrs)
    x1 = max(h['xllcorner'] + h['ncols'] * cs for _, h in hdrs); y1 = max(h['yllcorner'] + h['nrows'] * cs for _, h in hdrs)
    W, H = int(round((x1 - x0) / cs)), int(round((y1 - y0) / cs))
    M = np.full((H, W), np.nan, np.float32)
    for fn, h in hdrs:
        d = np.loadtxt(fn, skiprows=6, dtype=np.float32); d[d <= h['nodata_value'] + 1] = np.nan
        c = int(round((h['xllcorner'] - x0) / cs)); r = int(round((y1 - (h['yllcorner'] + h['nrows'] * cs)) / cs))
        blk = M[r:r + d.shape[0], c:c + d.shape[1]]; ok = ~np.isnan(d); blk[ok] = d[ok]
    print(len(tiles), 'tiles', W, 'x', H, flush=True)
    return M, x0, y1, cs          # row 0 at the north edge; cell centres at x0 + (c + 0.5) cs, y1 - (r + 0.5) cs

def bilinear(M, x0, ytop, cs, X, Y):
    c = (X - x0) / cs - 0.5; r = (ytop - Y) / cs - 0.5
    i = np.clip(np.floor(r).astype(int), 0, M.shape[0] - 2); j = np.clip(np.floor(c).astype(int), 0, M.shape[1] - 2)
    fr = np.clip(r - i, 0, 1); fc = np.clip(c - j, 0, 1)
    return M[i, j] * (1 - fr) * (1 - fc) + M[i, j + 1] * (1 - fr) * fc + M[i + 1, j] * fr * (1 - fc) + M[i + 1, j + 1] * fr * fc

def coarse_height():
    """the whole-front grid exactly as the app builds it (tools/prep.py: Copernicus 30 m, 2x2 averaged)"""
    g = json.load(open(f'{ROOT}/web/geography.json'))['dem']
    b64 = open(f'{ROOT}/src/demdata.ts').read().split('"')[1]
    h = np.frombuffer(base64.b64decode(b64), '<u2').astype(np.float32).reshape(g['rows'], g['cols']) * g['scale']
    def at(lat, lon):
        r = np.clip((g['north'] - lat) / g['cell_deg'] - 0.5, 0, g['rows'] - 1.001); c = np.clip((lon - g['west']) / g['cell_deg'] - 0.5, 0, g['cols'] - 1.001)
        i = np.floor(r).astype(int); j = np.floor(c).astype(int); fr = r - i; fc = c - j
        return h[i, j] * (1 - fr) * (1 - fc) + h[i, j + 1] * (1 - fr) * fc + h[i + 1, j] * fr * (1 - fc) + h[i + 1, j + 1] * fr * fc
    return at

BAND, BLK = 1700.0, 1000.0

def front_lines():
    g = json.load(open(f'{ROOT}/web/geography.json'))
    to = lambda ll: ((ll[1] - LON0) * KX, -(ll[0] - LAT0) * KZ)
    out = []
    for key in ('britishFront', 'germanFront'):
        P = np.array([to(p) for p in g[key]]); D = [P[0]]
        for i in range(1, len(P)):
            k = max(1, int(np.hypot(*(P[i] - P[i - 1])) / 50)); D += [P[i - 1] + (P[i] - P[i - 1]) * (j + 1) / k for j in range(k)]
        out.append(np.array(D))
    return np.concatenate(out)

if __name__ == '__main__':
    from scipy.ndimage import distance_transform_edt
    from scipy.spatial import cKDTree
    M, mx0, mtop, cs = mosaic(sys.argv[1])
    FL = front_lines(); tree = cKDTree(FL)
    bx0, bz0 = np.floor((FL.min(0) - BAND) / BLK) * BLK; bx1, bz1 = np.ceil((FL.max(0) + BAND) / BLK) * BLK
    xs = np.arange(bx0, bx1 + STEP / 2, STEP); zs = np.arange(bz0, bz1 + STEP / 2, STEP)
    Xg, Zg = np.meshgrid(xs, zs)
    lat, lon = to_ll(Xg, Zg); E, N = l93(lat, lon)
    fine = bilinear(M, mx0, mtop, cs, E, N)
    coarse = coarse_height()(lat, lon)
    # blocks near the front with data
    nbx, nbz = int((bx1 - bx0) / BLK), int((bz1 - bz0) / BLK); K = int(BLK / STEP)
    sel = np.zeros((nbz, nbx), bool)
    for j in range(nbz):
        for i in range(nbx):
            c = (bx0 + (i + 0.5) * BLK, bz0 + (j + 0.5) * BLK)
            if tree.query(c)[0] > BAND + BLK * 0.5: continue
            blk = fine[j * K:(j + 1) * K + 1, i * K:(i + 1) * K + 1]
            sel[j, i] = np.mean(~np.isnan(blk)) > 0.25
    have = np.zeros(fine.shape, bool)
    for j, i in zip(*np.nonzero(sel)): have[j * K:(j + 1) * K + 1, i * K:(i + 1) * K + 1] = True
    have &= ~np.isnan(fine)
    print('blocks', sel.sum(), '; fine - coarse: median %.2f m, 5-95%% %.1f..%.1f m' % tuple(np.nanpercentile((fine - coarse)[have], [50, 5, 95])), flush=True)
    # blend into the coarse grid near anything that isn't fine data
    d = distance_transform_edt(have) * STEP
    w = np.clip((d - STEP) / EDGE, 0, 1); w = w * w * (3 - 2 * w)
    out = coarse + np.where(have, np.nan_to_num(fine) - coarse, 0) * w
    blocks, chunks = [], []
    for j, i in zip(*np.nonzero(sel)):
        q = np.round(out[j * K:(j + 1) * K + 1, i * K:(i + 1) * K + 1] * 10).astype('<u2')
        blocks.append([int(i), int(j)]); chunks.append(q.tobytes())
    open(f'{ROOT}/web/terrain.bin', 'wb').write(b''.join(chunks))
    open(f'{ROOT}/src/finedem.ts', 'w').write(
        '// Fine terrain: IGN RGE ALTI 5 m (Licence Ouverte Etalab 2.0), 5 m grid in 1 km blocks along the front.\n'
        '// Heights are in terrain.bin (uint16 decimetres, (n+1) x (n+1) per block, rows by increasing z). Generated by tools/rgealti.py.\n'
        f'export const FINE = {{ x0: {bx0:.0f}, z0: {bz0:.0f}, block: {BLK:.0f}, step: {STEP:.0f}, n: {K}, scale: 0.1, blocks: {json.dumps(blocks)} as [number, number][] }};\n')
    print('terrain.bin', len(blocks), 'blocks', round(sum(len(c) for c in chunks) / 1e6, 1), 'MB')
