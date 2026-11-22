// 1 July 1916 — whole-front viewer: clock, effects tied to the timetable, labels, controls and info panels.
import events from '../data/events.json';
import { GEO, Dem, toXZ, toLL, pts, resample, offsetAway, project, at, hhmm, parseTime, type P } from './geo';
import { buildUnits, type Battalion } from './units';
import { Renderer, Camera, type Burst } from './render';
import { Battle } from './battle';
import { BattleView } from './battleview';
import { loadSheet } from './closeground';
import { shellBands, bombardment } from './shelling';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const T0 = 6 * 60, T1 = 22 * 60 + 30, ZERO = 7 * 60 + 30;

function boot() {
  const dem = new Dem();
  const { units, divs, corps } = buildUnits();
  const canvas = $('gl') as HTMLCanvasElement;
  // edge smoothing setting: kept in the address (#smooth=light) and, where allowed, in local storage
  const hashQ = /smooth=(full|light|fast)/.exec(location.hash)?.[1];
  let quality = hashQ ?? 'full'; if (!hashQ) try { quality = localStorage.getItem('smooth') ?? 'full'; } catch { /* no storage */ }
  const r = new Renderer(canvas, dem, units, quality);
  const cam = new Camera(dem);
  const battle = new Battle(units, divs); battle.begin();
  const bv = new BattleView(battle, r, units);
  r.setGermanFront(battle.germanFrontPath());
  r.setShelling(shellBands(battle));
  r.showBattalions = false;
  let sheetReady = false; loadSheet(r).then(() => (sheetReady = true)).catch(() => {});
  let simDone = false;
  const L = r.lines;
  const G = resample(L.german, 30), Bf = resample(L.british, 30), S2 = resample(L.second, 30);
  const gSupport = offsetAway(G, 220, Bf), nml = Bf.map((p, i) => { const q = project(G, p); return { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 }; });
  const len = (p: P[]) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z); return s; };

  // ---------------- views ----------------
  const front = (() => { const a = toXZ([50.075, 2.705]); return a; })();
  const whole = () => { const asp = innerWidth / Math.max(1, innerHeight); cam.gx = front.x; cam.gz = front.z; cam.gdist = 25000 * Math.max(1, Math.min(2.6, 1.05 / asp)); cam.gyaw = asp < 1 ? -0.25 : -0.7; cam.gpitch = 0.9; };
  whole(); cam.tx = cam.gx; cam.tz = cam.gz; cam.dist = cam.gdist; cam.yaw = cam.gyaw; cam.pitch = cam.gpitch;
  const fly = (x: number, z: number, d: number) => { cam.gx = x; cam.gz = z; cam.gdist = d; cam.gpitch = Math.max(0.55, Math.min(0.95, 0.4 + d / 20000)); };

  // ---------------- clock ----------------
  let t = T0, prevT = T0, speed = 60, playing = false;
  const SPEEDS = [1, 10, 60, 300];
  const speedBtns = $('speeds');
  speedBtns.innerHTML = SPEEDS.map(s => `<button data-s="${s}">${s === 1 ? 'real time' : s + '×'}</button>`).join('');
  const setSpeed = (s: number) => { speed = s; for (const b of Array.from(speedBtns.children) as HTMLElement[]) b.classList.toggle('on', Number(b.dataset.s) === s); };
  for (const b of Array.from(speedBtns.children) as HTMLElement[]) b.onclick = () => setSpeed(Number(b.dataset.s));
  setSpeed(60);
  const play = (p: boolean) => { playing = p; $('play').textContent = p ? '❚❚' : '▶'; };
  $('play').onclick = () => { if (t >= T1) t = T0; play(!playing); };
  const slider = $('slider') as HTMLInputElement;
  slider.min = String(T0); slider.max = String(T1); slider.step = '1';
  slider.oninput = () => { t = Math.min(Number(slider.value), bv.available); prevT = t; r.bursts.length = 0; };

  // ---------------- timetable ----------------
  const corpsByName = new Map(corps.map(c => [c.name, c]));
  const sectorCorps = (s: string) => { const m = /\b(VIII|VII|XIII|XV|III|X)\b/.exec(s); return m ? corpsByName.get(`${m[1]} Corps`) : undefined; };
  const mines = GEO.mines.map(m => ({ ...m, t: parseTime(m.time) ?? ZERO, p: toXZ(m.ll), fired: false }));
  type Ev = { t: number; text: string; corps?: string; x?: number; z?: number; sim?: boolean };
  r.setMines(mines.map(m => ({ x: m.p.x, z: m.p.z, d: m.crater_m })));
  const evs: Ev[] = [];
  for (const e of events.timeline) { const tt = parseTime(e.time); if (tt === null) continue; const c = sectorCorps(e.sector); evs.push({ t: tt, text: e.event, corps: c?.name, x: c?.x, z: c?.z }); }
  for (const m of mines) evs.push({ t: m.t, text: `${m.name} mine blown${m.charge_lb ? ` (${m.charge_lb.toLocaleString()} lb of ammonal)` : ''}${m.note ? ' — ' + m.note : ''}`, x: m.p.x, z: m.p.z });
  evs.sort((a, b) => a.t - b.t);

  // ---------------- effects ----------------
  const rnd = Math.random;
  const ground = (x: number, z: number) => dem.height(x, z);
  const shell = (x: number, z: number, big: number, german: boolean) => {
    const y = ground(x, z);                     // drawn at true size: no longer enlarged when zoomed out
    r.bursts.push({ x, y: y + 4, z, size: 30 * big, r: 1, g: 0.8, b: 0.45, a: 1, vy: 0, grow: -60, life: 0.18, age: 0, glow: true });
    const c = german ? 0.32 : 0.45;
    r.bursts.push({ x: x + (rnd() - 0.5) * 8, y: y + 10, z, size: 28 * big, r: c + 0.05, g: c, b: c - 0.03, a: 0.65, vy: 4 + rnd() * 4, grow: 18 * big, life: 3 + rnd() * 2, age: 0, glow: false });
  };
  /** random point on a polyline near the camera target */
  const near = (p: P[], spread = 0) => {
    const s0 = project(p, { x: cam.tx, z: cam.tz }).s, R = cam.dist * 1.5, total = len(p);
    const s = Math.max(0, Math.min(total, s0 + (rnd() * 2 - 1) * R));
    const q = at(p, s);
    return { x: q.x + (rnd() - 0.5) * spread - q.tz * (rnd() - 0.5) * spread, z: q.z + (rnd() - 0.5) * spread + q.tx * (rnd() - 0.5) * spread };
  };
  // Shellfire follows the simulation, stretch by stretch: the German guns by each corps' German artillery
  // over the day (Battle.gerArt: silent before zero, full within minutes of it, then by corps), on the British
  // front and assembly trenches and on no man's land; the British bombardment by each division's weight
  // (wire cut, garrison wrecked), on the German front system until zero and then lifting deeper.
  const bomb = battle.cells.map(c => bombardment(c.div, c.corps));
  const effects = (dtReal: number) => {
    if (!playing && prevT === t) return;
    const cells = battle.cells, R = Math.max(600, cam.dist * 1.5);
    let c0 = 0, bd = Infinity; cells.forEach((c, i) => { const d = Math.hypot(c.bx - cam.tx, c.bz - cam.tz); if (d < bd) { bd = d; c0 = i; } });
    const span = Math.ceil(R / 100), lo = Math.max(0, c0 - span), hi = Math.min(cells.length - 1, c0 + span);
    const pick = () => cells[lo + Math.floor(rnd() * (hi - lo + 1))];
    const pos = (c: typeof cells[0], d: number, spread: number) => { const a = (rnd() - 0.5) * 100, e = (rnd() - 0.5) * spread; return { x: c.bx - c.az * a + c.ax * (d + e), z: c.bz + c.ax * a + c.az * (d + e) }; };
    const tries = (n: number, fn: () => void) => { let k = n; while (k > 1 || rnd() < k) { fn(); k--; } };
    const base = 70 * dtReal;
    // German guns
    tries(base * 1.4, () => {
      const c = pick(), A = battle.gerArt(c, t); if (rnd() >= A) return;
      const onTrenches = t < ZERO + 10 ? 0.85 : 0.5;
      const q = rnd() < onTrenches ? pos(c, -60 - rnd() * 180, 60) : pos(c, 30 + rnd() * Math.max(10, c.w - 60), 20);
      shell(q.x, q.z, 1.1, true);
    });
    // British guns
    const lift = (t - ZERO) / 60;               // hours since zero
    tries(base * 1.2, () => {
      const c = pick(), I = 0.25 + 0.75 * bomb[c.i];
      let k: number, d: number;
      if (t < 6 * 60 + 25) { k = 0.25; d = c.w + rnd() * 450; }
      else if (t < ZERO) { k = 1; d = c.w - 20 + rnd() * 470; }
      else { k = Math.max(0.12, 0.9 - lift * 0.35); d = c.w + 300 + Math.min(1600, (t - ZERO) * 12) + (rnd() - 0.5) * 300; }
      if (rnd() >= k * I) return;
      const q = pos(c, d, 30); shell(q.x, q.z, 1.2, false);
    });
    // Very lights at night
    if (t > 21 * 60 + 40) tries(0.06 * base, () => { const q = near(nml, 300); r.bursts.push({ x: q.x, y: ground(q.x, q.z) + 60, z: q.z, size: 14, r: 1, g: 1, b: 0.85, a: 1, vy: 8, grow: 0, life: 5, age: 0, glow: true }); });
  };
  const mineBlast = (m: typeof mines[0]) => {
    const { x, z } = m.p, y = ground(x, z), big = Math.max(0.4, Math.sqrt((m.charge_lb || 8000) / 40000));
    r.bursts.push({ x, y: y + 20, z, size: 260 * big, r: 1, g: 0.85, b: 0.5, a: 1, vy: 0, grow: -300, life: 0.6, age: 0, glow: true });
    for (let i = 0; i < 260 * big; i++) {
      const a = rnd() * 6.283, rr = rnd() * 40 * big, chalk = rnd() < 0.55;
      r.bursts.push({ x: x + Math.cos(a) * rr, y: y + 5, z: z + Math.sin(a) * rr, size: 25 + rnd() * 45 * big,
        r: chalk ? 0.86 : 0.5, g: chalk ? 0.84 : 0.43, b: chalk ? 0.78 : 0.33, a: 0.9, vy: (60 + rnd() * 260) * big, grow: 14, life: 2.5 + rnd() * 4, age: 0, glow: false });
    }
    for (let i = 0; i < 40; i++) { const a = rnd() * 6.283, rr = 60 + rnd() * 250 * big; r.bursts.push({ x: x + Math.cos(a) * rr, y: y + 15, z: z + Math.sin(a) * rr, size: 60 * big, r: 0.8, g: 0.78, b: 0.72, a: 0.7, vy: 3, grow: 25, life: 9, age: 0, glow: false }); }
    toast(`${hhmm(m.t)} · ${m.name} mine`);
  };

  // ---------------- lighting by time of day ----------------
  const light = (tm: number) => {
    // British clocks were an hour ahead of GMT; solar noon here is about 11:49 GMT
    const ha = ((tm - 60 + 11) - 720) / 4 * Math.PI / 180, dec = 23.1 * Math.PI / 180, lat = 50.06 * Math.PI / 180;
    const sinE = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha), e = Math.asin(sinE);
    const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI; // from north, clockwise
    const day = Math.max(0, Math.min(1, (e * 180 / Math.PI + 4) / 12));
    const ce = Math.cos(Math.max(e, 0.03));
    const sun = [Math.sin(az) * ce, Math.max(Math.sin(e), 0.03), -Math.cos(az) * ce];
    const warm = 1 - Math.min(1, Math.max(0, e * 180 / Math.PI / 25));
    const mix = (a: number[], b: number[], f: number) => a.map((v, i) => v + (b[i] - v) * f);
    return {
      sun, sunCol: mix([0.05, 0.06, 0.1], mix([1.0, 0.93, 0.82], [1.05, 0.72, 0.45], warm), day),
      sky: mix([0.07, 0.08, 0.14], [0.42, 0.46, 0.52], day),
      fog: mix([0.05, 0.06, 0.1], mix([0.74, 0.78, 0.84], [0.85, 0.74, 0.62], warm * 0.7), day),
    };
  };

  // ---------------- labels ----------------
  type Lab = { el: HTMLDivElement; x: number; z: number; y?: number; kind: string; min: number; max: number; pri: number; onclick?: () => void };
  const layer = $('labels'), labs: Lab[] = [];
  const mk = (text: string, cls: string, x: number, z: number, min: number, max: number, pri: number, onclick?: () => void) => {
    const el = document.createElement('div'); el.className = 'lab ' + cls; el.textContent = text; layer.appendChild(el);
    if (onclick) { el.onclick = onclick; el.classList.add('click'); }
    const l: Lab = { el, x, z, kind: cls, min, max, pri, onclick }; labs.push(l); return l;
  };
  for (const c of corps) mk(c.name, 'corps', c.x, c.z, 7000, 1e9, 9, () => { fly(c.x, c.z, 6500); showCorps(c.name); });
  for (const d of divs) { const p = offsetPt(d.x, d.z, 900); mk(d.name.replace(' Division', ' Div').replace(/ \(.*?\)/, ''), 'div', p.x, p.z, 1500, 16000, 7, () => { fly(d.x, d.z, 3500); showDiv(d.name); }); }
  for (const p of GEO.places) { const q = toXZ(p.ll); mk(p.name, 'place ' + p.side, q.x, q.z, 0, 40000, 8); }
  for (const f of GEO.features) { const q = toXZ(f.ll); mk(f.name, 'feat', q.x, q.z, 0, 6000, 6); }
  for (const g of GEO.germanUnits) { const q = toXZ(g.ll); mk(g.name, 'ger', q.x, q.z, 0, 9000, 5); }
  for (const m of mines) mk('✹ ' + m.name, 'mine', m.p.x, m.p.z, 0, 14000, 6, () => showMine(m));
  const bnLabs = units.map(u => mk(short(u.name), 'bn w' + u.wave, u.x, u.z, 0, 3200, 3, () => showBn(u)));
  const moveBnLabels = () => bnLabs.forEach((l, i) => { const p = bv.bnPos[i]; if (Math.abs(p.x - l.x) + Math.abs(p.z - l.z) > 1) { l.x = p.x; l.z = p.z; l.y = undefined; } });
  function offsetPt(x: number, z: number, d: number) { const q = project(Bf, { x, z }); let nx = -q.tz, nz = q.tx; const g = project(G, q); if ((g.x - q.x) * nx + (g.z - q.z) * nz > 0) { nx = -nx; nz = -nz; } return { x: q.x + nx * d, z: q.z + nz * d }; }
  function short(n: string) { return n.replace("King's Own Yorkshire Light Infantry", 'KOYLI').replace('Northumberland Fusiliers', 'NF').replace('Royal Inniskilling Fusiliers', 'Innisks').replace('Royal Irish Rifles', 'RIR').replace('Royal Irish Fusiliers', 'R Ir F').replace('Highland Light Infantry', 'HLI').replace('York and Lancaster', 'Y&L').replace("King's Own Scottish Borderers", 'KOSB').replace('Lancashire Fusiliers', 'Lancs Fus').replace('Royal Dublin Fusiliers', 'Dublin Fus').replace('Sherwood Foresters', 'Sherwoods'); }
  const placeLabels = () => {
    const placed: number[][] = [], ds = canvas.width / Math.max(1, canvas.clientWidth);
    const vis = labs.map(l => {
      const y = (l.y ??= ground(l.x, l.z) + 25);
      const p = cam.dist >= l.min && cam.dist <= l.max ? cam.project(l.x, y, l.z) : null;
      return { l, p };
    }).filter(v => v.p && v.p.on).sort((a, b) => b.l.pri - a.l.pri || a.p!.d - b.p!.d);
    const shown = new Set<Lab>();
    let bnCount = 0;
    for (const { l, p } of vis) {
      if (l.kind.startsWith('bn') && ++bnCount > 90) continue;
      const w = l.el.textContent!.length * 6.6 + 10, h = 16, x = p!.x / ds - w / 2, y = p!.y / ds - h;
      if (placed.some(q => x < q[0] + q[2] && x + w > q[0] && y < q[1] + q[3] && y + h > q[1])) continue;
      placed.push([x, y, w, h]); shown.add(l);
      l.el.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    }
    for (const l of labs) l.el.style.display = shown.has(l) ? '' : 'none';
  };

  // ---------------- info panels ----------------
  const info = $('info');
  const show = (html: string) => { openBn = null; openDiv = null; info.innerHTML = `<button class="x" id="info-x">×</button>${html}`; info.classList.remove('hidden'); $('info-x').onclick = () => info.classList.add('hidden'); };
  function showBn(u: Battalion) {
    const d = divs.find(x => x.name === u.division);
    show(`<h3>${esc(u.name)}</h3>${u.nick ? `<div class="nick">${esc(u.nick)}</div>` : ''}
      <p>${esc(u.brigade)} · ${esc(u.division)}<br>${esc(u.corps)}, ${esc(u.army)}</p>
      <p>${u.wave === 1 ? 'Leading wave' : u.wave === 2 ? 'Following wave' : 'Support / reserve brigade'}${u.involved ? '' : ' · not heavily involved on 1 July'}</p>
      ${bnLive(u)}
      ${u.cas ? `<p class="cas">Recorded casualties on 1 July: <b>${u.cas.total}</b> (${u.cas.officers} officers, ${u.cas.men} men)</p>` : '<p class="dim">Recorded battalion casualties are in the data only for battalions that lost over 500.</p>'}
      ${d?.cas ? `<p class="dim">Division: ${d.cas.casualties.toLocaleString()} casualties, ${d.cas.killed.toLocaleString()} killed.</p>` : ''}
      <p class="dim">Start position approximate: placed along the division's frontage from the order of battle.</p>`);
    openBn = u;
  }
  let openBn: Battalion | null = null, openDiv: string | null = null;
  function bnLive(u: Battalion) {
    const bi = units.indexOf(u), cs = bv.companies(bi, t);
    if (!cs.length) return '';
    const men = cs.reduce((a, c) => a + c.men, 0), men0 = cs.reduce((a, c) => a + c.men0, 0);
    return `<div id="live"><p><b>At ${hhmm(t)}</b> · ${Math.round(men)} of ${Math.round(men0)} men · ${Math.round(men0 - men)} casualties</p>
      <table class="coys">${cs.map(c => `<tr><td>${c.name} Coy</td><td>${Math.round(c.men)}</td><td>${c.stateName}</td></tr>`).join('')}</table></div>`;
  }
  function divLive(name: string) {
    const v = bv.divCas(name, t); if (v === null) return '';
    const cells = battle.cells.filter(c => c.div === name);
    let held = 0, deep = 0; for (const c of cells) { let d = -1; for (const id of c.secs) if (bv.owner(id, t)) d = battle.secs[id].depth - c.w; if (d >= 0) { held++; deep = Math.max(deep, d); } }
    return `<div id="live"><p><b>At ${hhmm(t)}</b>: ${Math.round(v).toLocaleString()} casualties · ${cells.length ? Math.round(held / cells.length * 100) : 0}% of the frontage in German trenches${held ? `, up to ${Math.round(deep / 10) * 10} m deep` : ''}</p></div>`;
  }
  const refreshLive = () => { const el = document.getElementById('live'); if (!el || info.classList.contains('hidden')) return; const html = openBn ? bnLive(openBn) : openDiv ? divLive(openDiv) : ''; if (html) el.outerHTML = html; };
  function showDiv(name: string) {
    const d = divs.find(x => x.name === name)!; const bns = units.filter(u => u.division === name);
    show(`<h3>${esc(d.name)}</h3><p>${esc(d.corps)} · ${esc(d.commander)} · ${({ REG: 'Regular', NA: 'New Army', TF: 'Territorial' } as any)[d.type] ?? d.type}</p>
      ${divLive(d.name)}
      ${d.cas ? `<p class="cas">Recorded: <b>${d.cas.casualties.toLocaleString()}</b> casualties, ${d.cas.killed.toLocaleString()} killed</p><p>By nightfall: ${esc(d.cas.nightLine)}</p>` : ''}
      ${d.note ? `<p class="dim">${esc(d.note)}</p>` : ''}<p class="dim">${bns.length} battalions shown.</p>`);
    openDiv = name; openBn = null;
  }
  function showCorps(name: string) {
    const c = corpsByName.get(name)!;
    show(`<h3>${esc(c.name)}</h3><p>${esc(c.army)} · ${esc(c.commander)}</p><p>${c.divisions.map(d => `<a data-d="${esc(d)}">${esc(d)}</a>`).join('<br>')}</p>`);
    for (const a of Array.from(info.querySelectorAll('a[data-d]')) as HTMLElement[]) a.onclick = () => { const d = divs.find(x => x.name === a.dataset.d)!; fly(d.x, d.z, 3500); showDiv(d.name); };
  }
  function showMine(m: typeof mines[0]) {
    show(`<h3>${esc(m.name)} mine</h3><p>Fired at ${m.time}${m.charge_lb ? ` · ${m.charge_lb.toLocaleString()} lb of ammonal` : ''}</p>${m.note ? `<p class="dim">${esc(m.note)}</p>` : ''}
      <button id="m-go">Watch it go up</button>`);
    $('m-go').onclick = () => { fly(m.p.x, m.p.z, 2600); t = m.t - 1.5; prevT = t; slider.value = String(t); r.bursts.length = 0; setSpeed(10); play(true); };
  }

  // ---------------- events panel and toasts ----------------
  const evEl = $('events');
  let lastEvCount = -1;
  const updateEvents = () => {
    const sim: Ev[] = battle.events.filter(e => e.t <= t).map(e => ({ t: e.t, text: e.text, x: e.x, z: e.z, sim: true }));
    const past = [...evs.filter(e => e.t <= t), ...sim].sort((a, b) => a.t - b.t);
    if (past.length === lastEvCount) return;
    if (playing && past.length > lastEvCount && lastEvCount >= 0) { const e = past[past.length - 1]; if (!e.text.includes(' mine') && t - e.t < 3) toast(`${hhmm(e.t)} · ${e.text}`); }
    lastEvCount = past.length;
    const list = past.slice(-7).reverse();
    evEl.innerHTML = list.length ? list.map((e, i) => `<div class="ev${e.sim ? ' sim' : ''}" data-i="${i}"><span>${hhmm(e.t)}</span>${e.corps ? `<b>${esc(e.corps)}</b> ` : ''}${esc(e.text)}</div>`).join('') : '<div class="ev dim">The final bombardment is under way. Zero hour is 07:30.</div>';
    (Array.from(evEl.querySelectorAll('.ev[data-i]')) as HTMLElement[]).forEach(el => { const e = list[Number(el.dataset.i)]; if (e.x !== undefined) { el.classList.add('click'); el.onclick = () => fly(e.x!, e.z!, e.corps ? 6500 : 2500); } });
  };
  let toastT = 0;
  function toast(s: string) { const el = $('toast'); el.textContent = s; el.classList.add('on'); toastT = 4; }

  // ---------------- input ----------------
  const ptrs = new Map<number, { x: number; y: number }>();
  let downAt: { x: number; y: number; t: number } | null = null, moved = 0, lastPinch: { d: number; a: number; cy: number } | null = null, rotating = false;
  const panBy = (dx: number, dy: number) => {
    const s = cam.dist * 2 * Math.tan(cam.fov / 2) / canvas.clientHeight;
    const rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw), fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
    const k = 1 / Math.max(0.35, Math.sin(cam.pitch));
    cam.gx += (-rx * dx + fx * dy * k) * s; cam.gz += (-rz * dx + fz * dy * k) * s;
  };
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    rotating = e.button === 2 || e.ctrlKey || e.shiftKey;
    if (ptrs.size === 1) { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; moved = 0; } else { downAt = null; lastPinch = null; }
  });
  canvas.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (ptrs.size === 1) {
      if (rotating) { cam.gyaw -= dx * 0.005; cam.gpitch += dy * 0.004; } else panBy(dx, dy);
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x), cy = (a.y + b.y) / 2;
      if (lastPinch) { cam.gdist *= lastPinch.d / d; cam.gyaw -= ang - lastPinch.a; cam.gpitch += (cy - lastPinch.cy) * 0.004; }
      lastPinch = { d, a: ang, cy };
    }
  });
  const up = (e: PointerEvent) => {
    ptrs.delete(e.pointerId); lastPinch = null;
    if (downAt && moved < 6 && performance.now() - downAt.t < 500) clickAt(e.clientX, e.clientY);
    downAt = null;
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const f = Math.exp(e.deltaY * 0.0014);
    const g = cam.pick(e.clientX * canvas.width / canvas.clientWidth, e.clientY * canvas.height / canvas.clientHeight, dem);
    if (g && f < 1) { cam.gx += (g.x - cam.gx) * (1 - f) * 0.9; cam.gz += (g.z - cam.gz) * (1 - f) * 0.9; }
    cam.gdist *= f;
  }, { passive: false });
  const keys = new Set<string>();
  window.addEventListener('keydown', e => {
    if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
    keys.add(e.key.toLowerCase());
    if (e.key === ' ') { e.preventDefault(); $('play').click(); }
    if (e.key === 'Escape') info.classList.add('hidden');
  });
  window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());
  function clickAt(cx: number, cy: number) {
    const g = cam.pick(cx * canvas.width / canvas.clientWidth, cy * canvas.height / canvas.clientHeight, dem);
    if (!g) return;
    const slack = Math.max(15, cam.dist * 0.004);
    const si = bv.pick(g.x, g.z, t, slack);
    if (si >= 0) return showBn(units[battle.strips[si].bn]);
    const m = mines.find(m => Math.hypot(m.p.x - g.x, m.p.z - g.z) < Math.max(120, cam.dist * 0.01)); if (m) return showMine(m);
    const ll = toLL(g.x, g.z);
    show(`<p class="dim">${ll[0].toFixed(4)}° N, ${ll[1].toFixed(4)}° E · ${Math.round(ground(g.x, g.z))} m above sea level</p>`);
  }

  // ---------------- buttons ----------------
  $('b-whole').onclick = whole;
  const sel = $('goto') as HTMLSelectElement;
  sel.innerHTML = '<option value="">Go to…</option>' + corps.map(c => `<option>${esc(c.name)}</option>`).join('') + divs.map(d => `<option value="d:${esc(d.name)}">— ${esc(d.name)}</option>`).join('');
  sel.onchange = () => {
    const v = sel.value; sel.value = '';
    if (v.startsWith('d:')) { const d = divs.find(x => x.name === v.slice(2))!; fly(d.x, d.z, 3500); showDiv(d.name); }
    else if (v) { const c = corpsByName.get(v)!; fly(c.x, c.z, 6500); showCorps(c.name); }
  };
  $('b-help').onclick = () => $('help').classList.toggle('hidden');
  { const sel = document.createElement('select'); sel.id = 'smooth'; sel.title = 'Edge smoothing (reloads the page)';
    for (const [v, t] of [['full', 'Smoothing: full'], ['light', 'Smoothing: light'], ['fast', 'Smoothing: fast']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
    sel.value = quality; $('b-help').before(sel);
    sel.onchange = () => { try { localStorage.setItem('smooth', sel.value); } catch { /* no storage */ } location.hash = 'smooth=' + sel.value; location.reload(); };
  }
  $('b-map').onclick = () => {
    r.mapOpacity = r.mapOpacity > 0 ? 0 : 0.85; $('b-map').classList.toggle('on', r.mapOpacity > 0);
    if (r.mapOpacity > 0) { if (!sheetReady) toast('The 1916 map is still loading'); fly(-2350, 150, 2600); toast('1:5000 trench map, Schwaben Redoubt and Thiepval (trenches corrected to 20 October 1916)'); }
  };
  $('help').onclick = e => { if ((e.target as HTMLElement).id === 'help' || (e.target as HTMLElement).tagName === 'BUTTON') $('help').classList.add('hidden'); };
  $('begin').onclick = () => { $('intro').classList.add('hidden'); play(true); };

  // ---------------- main loop ----------------
  let last = performance.now(), liveT = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const k = keys, pan = 420 * dt;
    if (k.has('w') || k.has('arrowup')) panBy(0, pan); if (k.has('s') || k.has('arrowdown')) panBy(0, -pan);
    if (k.has('a') || k.has('arrowleft')) panBy(pan, 0); if (k.has('d') || k.has('arrowright')) panBy(-pan, 0);
    if (k.has('q')) cam.gyaw += dt; if (k.has('e')) cam.gyaw -= dt;
    if (k.has('r')) cam.gpitch -= dt * 0.7; if (k.has('f')) cam.gpitch += dt * 0.7;
    if (k.has('=') || k.has('+')) cam.gdist *= Math.exp(-dt * 1.5); if (k.has('-')) cam.gdist *= Math.exp(dt * 1.5);
    if (!simDone) simDone = battle.advance(9);
    prevT = t;
    if (playing) { t = Math.min(T1, bv.available, t + dt * speed / 60); if (t >= T1) play(false); }
    for (const m of mines) if (prevT < m.t && t >= m.t && t - m.t < 4) mineBlast(m);
    effects(dt);
    // mine craters once a mine has gone up
    const decals: number[] = [];
    mines.forEach((m, i) => (r.craterOn[i] = t >= m.t));
    bv.draw(t, cam); moveBnLabels(); r.render(cam, light(t), decals, dt);
    $('clock').textContent = `${hhmm(t)}`;
    const tot = bv.totals(t);
    $('score').innerHTML = t < 7 * 60 + 20 ? '' : `Casualties · British <b>${Math.round(tot.b).toLocaleString()}</b> · German <b>${Math.round(tot.g).toLocaleString()}</b>`;
    if ((liveT -= dt) < 0) { liveT = 1; refreshLive(); }
    $('phase').textContent = !simDone && t >= bv.available - 0.5 && t < T1 ? `Simulating… ${hhmm(bv.available)}` : t < 6 * 60 + 25 ? 'Final morning of the bombardment' : t < 7 * 60 + 20 ? 'Intense bombardment' : t < ZERO ? 'Mines · troops moving into no man\'s land' : t < ZERO + 3 ? 'Zero hour' : t < 21 * 60 ? 'The attack' : 'Nightfall';
    if (document.activeElement !== slider) slider.value = String(t);
    updateEvents();
    placeLabels();
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').classList.remove('on'); }
    requestAnimationFrame(frame);
  };
  $('loading').classList.add('hidden');
  $('intro').classList.remove('hidden');
  requestAnimationFrame(frame);
  (window as any).__app = { cam, r, units, divs, corps, battle, bv, get simDone() { return simDone; }, get t() { return t; }, set t(v: number) { t = v; prevT = v; }, play, setSpeed, fly };
}

window.addEventListener('error', e => { const el = $('error'); el.classList.remove('hidden'); el.textContent = 'Error: ' + e.message; });
setTimeout(() => { try { boot(); } catch (err) { $('loading').classList.add('hidden'); const el = $('error'); el.classList.remove('hidden'); el.textContent = 'Failed to start: ' + (err instanceof Error ? err.message : String(err)); console.error(err); } }, 20);
