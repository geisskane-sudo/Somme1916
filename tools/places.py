# Village and feature positions read by eye off the georeferenced trench-map screenshots (sheet, pixel).
# Applied by tools/prep.py over the hand-placed positions in data/geography_src.json. Run to print the moves.
import os, sys, json, math, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sheets
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
READ = {
  # villages: the middle of the built-up area (checked by drawing each back onto its sheet)
  'Hamel': ('09', 787, 821), 'Beaumont-Hamel': ('09', 758, 385), 'Beaucourt': ('09', 1137, 466), 'Grandcourt': ('09', 1460, 498),
  'St Pierre-Divion': ('09', 1032, 740), 'Auchonvillers': ('09', 416, 442), 'Mailly-Maillet': ('09', 70, 465),
  'Mesnil': ('08', 476, 239), 'Thiepval': ('08', 1097, 247), 'Authuille': ('08', 774, 481), 'Aveluy': ('07', 468, 223),
  'Ovillers': ('08', 1194, 739), 'La Boisselle': ('07', 1000, 324), 'Pozières': ('08', 1573, 553), 'Contalmaison': ('07', 1500, 279),
  'Bécourt': ('07', 952, 674), 'Fricourt': ('13', 410, 330), 'Mametz': ('13', 870, 370), 'Serre': ('10', 950, 530),
  'Puisieux': ('10', 1230, 370), 'Hébuterne': ('11', 556, 400), 'Gommecourt': ('11', 648, 195), 'Colincamps': ('11', 177, 779),
  'Foncquevillers': ('12', 532, 710),
  # features: where the name is printed on the ground they describe
  'Y Ravine': ('09', 720, 510), 'Mash Valley': ('07', 900, 240), 'Sausage Valley': ('07', 1080, 520), 'Mouquet Farm': ('08', 1379, 308),
}
fits = json.load(open(f'{ROOT}/data/sheetfits.json'))
LAT0, LON0 = 50.06, 2.72; KX = 111320 * math.cos(math.radians(LAT0)); KZ = 110574
def ll(name):
    k, u, v = READ[name]; x, z = sheets.transform(k, fits[k])(np.array([float(u)]), np.array([float(v)]))[0]
    return [round(LAT0 - z / KZ, 6), round(LON0 + x / KX, 6)]
if __name__ == '__main__':
    g = json.load(open(f'{ROOT}/data/geography_src.json'))
    for p in g['places'] + g['features']:
        if p['name'] in READ:
            a, b = p['ll'], ll(p['name']); print(f"{p['name']:18s} moves {math.hypot((b[1]-a[1])*KX, (b[0]-a[0])*KZ):5.0f} m")
