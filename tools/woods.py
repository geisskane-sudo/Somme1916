# Woods read by eye off the georeferenced trench-map screenshots (the patches of tree symbols), as polygons in
# sheet pixels. Each replaces the hand-placed wood of the same name in data/geography_src.json (via tools/prep.py).
# Thiepval Wood comes from the 1:5000 sheet (tools/british.py). Woods off the sheets keep their hand-placed shape.
import os, sys, json, math, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sheets
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fits = json.load(open(f'{ROOT}/data/sheetfits.json'))
LAT0, LON0 = 50.06, 2.72; KX = 111320 * math.cos(math.radians(LAT0)); KZ = 110574
S = 1 / 0.6   # read on a 0.6x view of the map area, which starts at y = 118
READ = {
  'Aveluy Wood': ('08', [(235, 160), (300, 140), (332, 122), (372, 126), (405, 165), (412, 200), (395, 240), (380, 300), (372, 332), (330, 335), (255, 332), (240, 260)]),
  'Authuille Wood': ('08', [(478, 284), (520, 268), (565, 270), (600, 300), (585, 338), (505, 340), (478, 318)]),
}
if __name__ == '__main__':
    out = {}
    for name, (k, pts) in READ.items():
        f = sheets.transform(k, fits[k]); P = np.array([(u * S, v * S + 118) for u, v in pts])
        X = f(P[:, 0], P[:, 1]); out[name] = [[round(LAT0 - z / KZ, 6), round(LON0 + x / KX, 6)] for x, z in X]
        print(name, len(X), 'points')
    json.dump(out, open(f'{ROOT}/data/woods.json', 'w'))
