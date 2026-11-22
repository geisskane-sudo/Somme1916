# 1 July 1916 — handoff notes for Claude

A watch-only browser simulation of the British attack on the Somme, 1 July 1916, Gommecourt to Maricourt. Companies advance as red rectangles over a 3D terrain map; the day's results match the historical record per division. Published as a Claude artifact ("1 July 1916 – The British attack on the Somme"); republish `dist/index.html`, `dist/main.js`, `dist/thiepval_map.jpg`, `dist/terrain.png` to the same artifact rather than creating a new one.

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
- `src/render.ts` custom WebGL2 renderer: terrain from Copernicus 30 m DEM, painted 4096 map texture (`paintMap`), ribbons, blocks, bursts. Close-up detail is always on (desktop only, by the owner's choice): every trench on the front is one mesh built at start (`buildTrenchMesh`, ~1.5M vertices): fire trenches with traverses, communication trenches narrower and zigzag. Grass, shell holes and tree crowns are drawn per pixel in the terrain shader from an aux map (`setShelling`: red = chance of a shell hole per 6 m square, from `src/shelling.ts`; green = woods). Captured trench lengths are a red strip mesh (`setCaptured`).
- `src/trenches.ts` the traced network split into fire/communication runs by direction relative to the front; `styled()` centrelines. `src/shelling.ts` shelled bands from the record (division wire-cutting × corps garrison; German shelling of British trenches by corps `gerArt`).
- `Battle.sectionPaths()` maps each section to the traced trench pieces it stands for; `Battle.germanFrontPath()` the German front ribbon from the cells' traced front crossings.
- Roads and villages: `tools/roads.py` → `data/roads.json` (roads found as best paths through a double-line filter response between points known to be on them: the hand-placed main roads, and neighbouring villages; the Albert–Bapaume road fitted as a straight line, read by eye on 57D.SE). `tools/villages.py` → `data/buildings.json` (solid grey building blocks). `Renderer.buildScenery()`: blocks filled with houses (pitched roofs) or ruins by a damage estimate (German side near the front wrecked); tree lines along main roads and orchards round villages, stumps where shelled. Roads are pale strips in the trench mesh.
- Trench mesh and scenery are cut into 1 km blocks (`chunked`) and only blocks in the view are drawn (`drawChunked`, frustum test on each block's box); nothing is rebuilt while moving.
- Wrecked villages (`ruinedVillages()`: places where `damage()` ≥ 0.55): rubble on the ground (aux blue channel: house plots, streets, radial fade; brick and chalk fragments in the shader) and 3D rubble heaps and broken wall stubs in `buildScenery`.
- Shell bursts (`effects` in main.ts) follow the simulation per 100 m stretch: German guns by `Battle.gerArt(cell, t)`, British by `bombardment()` lifting deeper after zero. Bursts are true size at any zoom.
- Edge smoothing menu (`#smooth=full|light|fast`, saved in local storage): MSAA on/off and render scale; changing it reloads the page.
- `src/battleview.ts` draws strips, captured trenches, the advance line (median + smoothed line through the foremost parties and held trenches, closing back to the British front) and German-held trenches behind it (`setPockets`, only near held trenches).
- Mine craters (`Renderer.setMines`/`craterOn`): a lit bowl-and-lip mesh per mine; the terrain and trench shaders discard inside active craters (`uHoles`). `src/main.ts` UI and loop. `src/geo.ts` coordinates (local metres: x east, z south; LAT0 50.06, LON0 2.72) and DEM.
- `data/geography_src.json` hand-built geography → `tools/prep.py` → `web/geography.json` + `src/demdata.ts`. prep.py overrides the British front and Thiepval Wood from `data/britishfront.json`.
- `data/oob_british.json`, `data/plan.json` (sector conditions), `data/record.json` (keyframes per division).

## Trench maps (refs/nls, tools/)
- Screenshots of NLS 1:20,000 trench maps (57D.SE, 57D.NE, 62D.NE) in `refs/nls/`, the 1:5000 Schwaben sheet in `refs/thiepval/`.
- `tools/sheets.py` georeferences each screenshot from a labelled grid corner (trench-map lettered/numbered squares, yards), refined by a grid-darkness optimiser → `data/sheetfits.json`. Validated against CWGC landmarks.
- `tools/trenches.py` extracts red German trenches → `data/trenches.json` (~2,200 lines). `tools/british.py` follows the blue "British front line" → `data/britishfront.json` (Gommecourt kept from the sketch; Ancre to Thiepval Wood from the 1:5000 sheet; stops at Mansel Copse). `tools/thiepval.py` the 1:5000 extraction (slow).
- Gaps: about 500 m at Gommecourt (screenshot 04, 1:10,000, could fill it once its corners are labelled); no sheet for Montauban–Maricourt.

## Next steps
- Done 22 Nov: German front ribbon from the trace; fire/communication trench styles; captured trenches on the real trenches; whole-front close-up; shell holes from the record; thin company lines up close.
- Not done: wire belts in front of German (and British) lines.
- The 57D.SE screenshots miss a strip between St Pierre Divion and Thiepval Wood; `tools/trenches.py` fills it from the 1:5000 sheet.
- Needs the owner: a late-June sheet for Gommecourt (56th Division's new forward trench), a Montauban sheet.
- Fine terrain (22 Nov): `tools/rgealti.py <folder of .asc tiles>` → `web/terrain.png` (copied to dist; fetched at start and checked against a checksum, the map works without it; heights packed as red/green bytes because the artifact host serves only standard file types) + `src/finedem.ts` (block list): IGN RGE ALTI 5 m (Licence Ouverte) on a 5 m grid in 1 km blocks within 1.7 km of either front line where the tiles have data (127 blocks, 1.8 MB PNG), blended into the coarse grid over 150 m wherever fine data stops. `Dem.height()` uses it; the renderer draws each block from a height+slope buffer with a shared index buffer (vertex position from gl_VertexID), and the coarse mesh is cut away under fine blocks via a block mask texture. The owner has the Somme (D080) tiles 0665–0690 × 6985–7010 (not in git: too big); Pas-de-Calais (D062) still to come for Gommecourt–Serre. Elsewhere the coarse grid is Copernicus 30 m, 2×2 averaged (~60 m). Publish terrain.png with the other dist files.

## Commits
End commit messages with the attribution lines the session asks for.
