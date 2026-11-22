# 1 July 1916 — handoff notes for Claude

A watch-only browser simulation of the British attack on the Somme, 1 July 1916, Gommecourt to Maricourt. Companies advance as red rectangles over a 3D terrain map; the day's results match the historical record per division. Published as a Claude artifact ("1 July 1916 – The British attack on the Somme"); republish `dist/index.html`, `dist/main.js`, `dist/thiepval_map.jpg` to the same artifact rather than creating a new one.

## The owner's standing wishes
- Replies are read on a phone: lead with the answer, keep it short.
- Work in stages: examine, propose, then build. Ask before large changes.
- Historically accurate. Outcomes are matched to the record exactly (record steering plus loss scaling); don't "game" the model to get there.
- The main map shows company rectangles only. A 3D soldier close-up was tried and removed at the owner's request.

## Build, run, test
- `npm install` (esbuild, typescript). `node scripts/build.mjs` → `dist/` (runs `tests/steer.ts` first to recompute per-strip loss scaling into `data/steer.json`; `--no-steer` skips it for quick visual work). `node scripts/serve.mjs 8090`. `npx tsc --noEmit -p .`
- `tests/run.ts`: headless calibration report — every division's casualties must match the record (ratio 1.00) and night positions must fit. Run after any rule or geometry change:
  `node -e "require('esbuild').buildSync({entryPoints:['tests/run.ts'],bundle:true,platform:'node',outfile:'/tmp/run.js'})" && node /tmp/run.js`
- Browser screenshots: Playwright + headless Chrome with swiftshader; the page exposes `window.__app` (cam, r, battle, fly, play, ...).
- Python tools (PIL, numpy, OpenCV, scikit-image, SciPy) regenerate data; their outputs are committed.

## Layout
- `src/battle.ts` simulation: 100 m cells along the British front; German sections per cell (front, support, reserve, intermediates, second line); company strips; per-minute recording. Record steering via `data/record.json` keyframes; loss scaling `k` from `data/steer.json`. German trench depths per cell come from `data/trenches.json` crossings (`tracedDepths`), schematic offsets where no sheet covers.
- `src/render.ts` custom WebGL2 renderer: terrain from Copernicus 30 m DEM, painted 4096 map texture (`paintMap`), ribbons, blocks, bursts. Close-up trial: `setCloseUp(mode)` (1 trench geometry, 2 sharp 0.8 m/px ground patch, 3 both) over `Renderer.CLOSE_BOX` at Thiepval, selected from the "Close-up" menu.
- `src/battleview.ts` draws strips, captured sections, live advance line. `src/main.ts` UI and loop. `src/geo.ts` coordinates (local metres: x east, z south; LAT0 50.06, LON0 2.72) and DEM.
- `data/geography_src.json` hand-built geography → `tools/prep.py` → `web/geography.json` + `src/demdata.ts`. prep.py overrides the British front and Thiepval Wood from `data/britishfront.json`.
- `data/oob_british.json`, `data/plan.json` (sector conditions), `data/record.json` (keyframes per division).

## Trench maps (refs/nls, tools/)
- Screenshots of NLS 1:20,000 trench maps (57D.SE, 57D.NE, 62D.NE) in `refs/nls/`, the 1:5000 Schwaben sheet in `refs/thiepval/`.
- `tools/sheets.py` georeferences each screenshot from a labelled grid corner (trench-map lettered/numbered squares, yards), refined by a grid-darkness optimiser → `data/sheetfits.json`. Validated against CWGC landmarks.
- `tools/trenches.py` extracts red German trenches → `data/trenches.json` (~2,200 lines). `tools/british.py` follows the blue "British front line" → `data/britishfront.json` (Gommecourt kept from the sketch; Ancre to Thiepval Wood from the 1:5000 sheet; stops at Mansel Copse). `tools/thiepval.py` the 1:5000 extraction (slow).
- Gaps: about 500 m at Gommecourt (screenshot 04, 1:10,000, could fill it once its corners are labelled); no sheet for Montauban–Maricourt.

## Proposed next steps (agreed order, not started)
1. Redraw the green German front-line ribbon from the traced front trench.
2. Style fire trenches (traverses) and communication trenches (narrower, zigzag) differently.
3. Show captured trenches by colouring the actual traced trench segments instead of rectangles.
4. Wire belts in front of German (and British) lines.
5. Close-up for the whole front: trench geometry plus a sharp ground patch repainted around the camera; shell holes tied to bombardment intensity and mine craters; company blocks thinner or fading when zoomed in.
- Needs the owner: a late-June sheet for Gommecourt (56th Division's new forward trench), a Montauban sheet.
- Known limit: 30 m DEM smooths Y Ravine, the Sunken Lane and the Thiepval ravines.

## Commits
End commit messages with the attribution lines the session asks for.
