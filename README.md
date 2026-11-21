# 1 July 1916 — a watchable simulation of the British attack on the Somme

Planned: the whole British front from Gommecourt to Maricourt on one zoomable map, with battalions (split into companies in the fight), the barrage timetable, the 19 mines, and front lines that change through the day. Pause and speed controls. Sister project to `thiepval-1916`, sharing its engine.

## Data so far (`data/`)
- `oob_british.json` — Fourth and Third Army order of battle to battalion level (221 battalions; 155 marked heavily involved).
- `oob_german.json` — German divisions and regiments facing the attack, with approximate positions.
- `sectors.json` — each corps sector north to south: frontage, width of no man's land, objectives, artillery density, strongpoints, special measures.
- `events.json` — mines (times, charges) and a timeline of the day.
- `results.json` — casualties by division and for the 32 battalions that lost over 500; night positions. For checking the simulation, not for tuning it to.

Check: the division casualty figures sum to 57,422 (19,268 killed) against the published total of 57,470 (19,240).

## Sources
- Martin Middlebrook, *The First Day on the Somme*, Appendices 1–5 (from photos supplied by the owner).
- *The Western Front Companion*, pp. 202–221 and Maps 40–45 (from photos supplied by the owner).
- Wikipedia: "First day on the Somme", "Mines on the first day of the Somme".
Only facts and figures are recorded here; no text is reproduced.

## Still needed
- Real coordinates: the Companion maps are schematic sector maps with yard scales; they need placing on real ground (village coordinates plus trench maps from the National Library of Scotland or McMaster).
- Elevation data for the area.
- Barrage lift timetables for each corps beyond what is noted; locations and times of the 11 small mines in the south.
- Battalion casualties under 500 (Middlebrook lists only those over 500).
- German regimental positions to confirm, especially reserves and the 10th Bavarian Division.

## Terrain and maps
- `data/dem/cop30_somme.tif`: Copernicus GLO-30 (2023_1), 1 arc-second, 2.58-2.86 E, 49.96-50.16 N, 27-185 m. Spot-checked against 1916 contours (Thiepval 140 m, Albert 72 m).
- `refs/nls/`: trench map screenshots (see its README). Montauban-Maricourt still missing.
