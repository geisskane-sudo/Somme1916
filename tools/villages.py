# Buildings traced from the NLS trench-map screenshots: the solid grey blocks the Ordnance Survey drew for
# houses, farms and village streets. Thin lines (roads, contours, hedges) and lettering are removed by a
# morphological opening sized to each sheet's scale; railway dashes (short bars in a row) and hollow bold
# numerals are filtered out. Each building is kept from the screenshot whose centre is nearest, as for the
# trenches. Output: data/buildings.json, footprints in local metres.
import os, sys, json, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
import sheets
from trenches import centre, inside

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fits = json.load(open(f'{ROOT}/data/sheetfits.json'))

def blobs(k):
    S = sheets.SHOTS[k]
    im = np.array(Image.open(sheets.path(k)).convert('RGB')).astype(int)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    gray = (r + g + b) / 3; sat = np.max(im, 2) - np.min(im, 2)
    dark = ((gray < 120) & (sat < 40)).astype(np.uint8)
    x0, y0, x1, y1 = S['area']; keep = np.zeros_like(dark); keep[y0:y1, x0:x1] = 1
    for a, b_, c_, d_ in sheets.MASKS['*'] + sheets.MASKS.get(k, []): keep[b_:d_, a:c_] = 0
    dark &= keep
    ksz = 3 if S['sp'] >= 160 else 2
    op = cv2.morphologyEx(dark, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (ksz, ksz)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(op, 8)
    cand = []
    for i in range(1, n):
        a = st[i, 4]
        if a < ksz * ksz + 2 or a > 1500 * (S['sp'] / 185) ** 2: continue
        m = (lab[st[i, 1]:st[i, 1] + st[i, 3], st[i, 0]:st[i, 0] + st[i, 2]] == i).astype(np.uint8)
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE); c = max(cs, key=cv2.contourArea) + [st[i, 0], st[i, 1]]
        (cx, cy), (w, h), ang = cv2.minAreaRect(c)
        if min(w, h) < ksz - 0.5 or max(w, h) > 7 * max(1, min(w, h)): continue      # thick lines
        hull = cv2.convexHull(c); sol = a / max(1, cv2.contourArea(hull) + len(hull) * 0.5)
        if sol < 0.5: continue                                                        # hollow numerals, letters
        cand.append(dict(c=c, cx=cx, cy=cy, w=max(w, h), h=min(w, h), ang=np.radians(ang if w >= h else ang + 90)))
    # railway dashes: bars with another bar of the same shape straight ahead along their length
    out = []
    for i, p in enumerate(cand):
        if p['w'] >= 1.8 * p['h'] and p['h'] <= 4.5:
            ux, uy = np.cos(p['ang']), np.sin(p['ang']); dash = False
            for q in cand:
                if q is p: continue
                dx, dy = q['cx'] - p['cx'], q['cy'] - p['cy'],
                along, across = abs(dx * ux + dy * uy), abs(-dx * uy + dy * ux)
                if along < 3 * p['w'] and across < 2.5 and abs(q['w'] - p['w']) < 3: dash = True; break
            if dash: continue
        out.append(cv2.approxPolyDP(p['c'], 0.7, True).reshape(-1, 2))
    return out

if __name__ == '__main__':
    keys = list(sheets.SHOTS); geo = {k: centre(k) for k in keys}
    res = []
    for k in keys:
        f = sheets.transform(k, fits[k]); n = 0
        for P in blobs(k):
            X = f(P[:, 0].astype(float), P[:, 1].astype(float)); c = X.mean(0)
            cover = [j for j in keys if inside(c, geo[j][1])]
            if min(cover or [k], key=lambda j: np.hypot(*(c - geo[j][0]))) != k: continue
            res.append({'sheet': k, 'p': [[round(float(x), 1), round(float(z), 1)] for x, z in X]}); n += 1
        print(k, n, flush=True)
    json.dump({'source': 'Buildings traced from NLS British trench maps 1:20,000 (CC-BY National Library of Scotland), tools/villages.py',
               'buildings': res}, open(f'{ROOT}/data/buildings.json', 'w'))
    print('total', len(res))
