# Named points from the owner's photo of the 36th Division's objective map (refs/research/r9.jpg): a 57D trench map
# with the Ulster place names given to German strongpoints. The photo is placed by a homography from the printed
# square numbers (each at the centre of its 1000-yard square). Output: data/namedpoints.json (lat/lon), merged by
# tools/prep.py into the features.
import os, sys, json, math, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sheets
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAT0, LON0 = 50.06, 2.72; KX = 111320 * math.cos(math.radians(LAT0)); KZ = 110574
SQUARES = {('Q', 12): (232, 512), ('R', 13): (596, 837), ('R', 14): (987, 820), ('R', 15): (1402, 808),
           ('R', 19): (603, 1219), ('R', 20): (1002, 1211), ('R', 21): (1408, 1209), ('Q', 24): (248, 1229)}
POINTS = {   # photo pixels of each circle
    'Coleraine': (649, 748), 'Portadown': (722, 852), 'Enniskillen': (802, 991), 'Strabane': (946, 1058), 'Omagh': (902, 1146),
    'Dungannon': (873, 1229), 'Lisnaskea': (936, 1331), 'Crucifix': (792, 1355), 'Moy': (681, 1414), 'Cavan': (629, 1340),
    'Clones': (646, 1241), 'Lisburn': (500, 1273), 'Lurgan': (510, 1136), 'Kilrea': (329, 1172), 'Bundoran': (1150, 808),
    'Derry City': (1173, 945), 'Portrush': (1032, 577), 'The Mound': (230, 1035),
}
def fit():
    src = np.array(list(SQUARES.values()), np.float32)
    dst = np.array([sheets.yards_to_local(*sheets.grid('57D', l, n, 0.5, 0.5)) for l, n in SQUARES], np.float32)
    H, _ = cv2.findHomography(src, dst, 0)
    res = cv2.perspectiveTransform(src[None], H)[0] - dst
    return H, np.hypot(*res.T)
if __name__ == '__main__':
    H, err = fit(); print('square-centre fit error (m): median %.0f, max %.0f' % (np.median(err), err.max()))
    P = cv2.perspectiveTransform(np.array(list(POINTS.values()), np.float32)[None], H)[0]
    out = {n: [round(float(LAT0 - z / KZ), 6), round(float(LON0 + x / KX), 6)] for n, (x, z) in zip(POINTS, P)}
    for n, (x, z) in zip(POINTS, P): print(f'{n:12s} {x:7.0f} {z:7.0f}')
    # trench-map references: 57D R.25.a.6.3 is Hammerhead Sap (battalion report, owner's research)
    x, z = sheets.yards_to_local(*sheets.grid('57D', 'R', 25, 0.6 * 0.5, 0.5 - 0.3 * 0.5))
    out['Hammerhead Sap'] = [round(float(LAT0 - z / KZ), 6), round(float(LON0 + x / KX), 6)]
    # Hawthorn Redoubt: the German strongpoint the Hawthorn Ridge mine was dug under
    out['Hawthorn Redoubt'] = json.load(open(f'{ROOT}/data/mines_snap.json'))['Hawthorn Ridge']
    json.dump(out, open(f'{ROOT}/data/namedpoints.json', 'w'), indent=1)
