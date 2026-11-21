// 1 July 1916 — whole-front viewer: clock, effects tied to the timetable, labels, controls and info panels.
import events from '../data/events.json';
import { GEO, Dem, toXZ, toLL, pts, resample, offsetAway, project, at, hhmm, parseTime, type P } from './geo';
import { buildUnits, type Battalion } from './units';
import { Renderer, Camera, type Burst } from './render';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const T0 = 6 * 60, T1 = 22 * 60 + 30, ZERO = 7 * 60 + 30;

function boot() {
  const dem = new Dem();
  const { units, divs, corps } = buildUnits();
  const canvas = $('gl') as HTMLCanvasElement;
  const r = new Renderer(canvas, dem, units);
  const cam = new Camera(dem);
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
  slider.oninput = () => { t = Number(slider.value); prevT = t; r.bursts.length = 0; };

  // ---------------- timetable ----------------
  const corpsByName = new Map(corps.map(c => [c.name, c]));
  const sectorCorps = (s: string) => { const m = /\b(VIII|VII|XIII|XV|III|X)\b/.exec(s); return m ? corpsByName.get(`${m[1]} Corps`) : undefined; };
  const mines = GEO.mines.map(m => ({ ...m, t: parseTime(m.time) ?? ZERO, p: toXZ(m.ll), fired: false }));
  type Ev = { t: number; text: string; corps?: string; x?: number; z?: number };
  const evs: Ev[] = [];
  for (const e of events.timeline) { const tt = parseTime(e.time); if (tt === null) continue; const c = sectorCorps(e.sector); evs.push({ t: tt, text: e.event, corps: c?.name, x: c?.x, z: c?.z }); }
  for (const m of mines) evs.push({ t: m.t, text: `${m.name} mine blown${m.charge_lb ? ` (${m.charge_lb.toLocaleString()} lb of ammonal)` : ''}${m.note ? ' — ' + m.note : ''}`, x: m.p.x, z: m.p.z });
  evs.sort((a, b) => a.t - b.t);

  // ---------------- effects ----------------
  const rnd = Math.random;
  const ground = (x: number, z: number) => dem.height(x, z);
  const shell = (x: number, z: number, big: number, german: boolean) => {
    const y = ground(x, z); big *= Math.max(1, cam.dist / 3500);
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
  const intensity = (tm: number) => ({
    // British fire on the German front system: last morning of the bombardment, the intense hour, then lifting
    bFront: tm < 6 * 60 + 25 ? 0.25 : tm < ZERO ? 1 : 0,
    bDeep: tm < ZERO ? 0.2 : tm < 10 * 60 ? 0.9 * (1 - (tm - ZERO) / 200) + 0.2 : 0.15,
    // German defensive barrage on no man's land and the British trenches
    gNml: tm < 7 * 60 + 25 ? 0.05 : tm < 9 * 60 ? 0.9 : tm < 13 * 60 ? 0.45 : 0.2,
    gBrit: tm < 7 * 60 + 25 ? 0.08 : tm < 10 * 60 ? 0.5 : 0.2,
  });
  const effects = (dtReal: number) => {
    if (!playing && prevT === t) return;
    const k = intensity(t), base = 70 * dtReal;           // bursts per real second at full intensity
    const spawn = (rate: number, fn: () => void) => { let n = rate * base; while (n > 1 || rnd() < n) { fn(); n--; } };
    const lift = Math.min(1, Math.max(0, (t - ZERO) / 120));
    spawn(k.bFront, () => { const q = near(G, 120); shell(q.x, q.z, 1, false); });
    spawn(k.bFront * 0.5, () => { const q = near(gSupport, 200); shell(q.x, q.z, 1.2, false); });
    spawn(k.bDeep, () => { const q = near(lift > 0 ? (lift > 0.5 ? S2 : gSupport) : S2, 300); shell(q.x, q.z, 1.3, false); });
    spawn(k.gNml, () => { const q = near(nml, 160); shell(q.x, q.z, 1, true); });
    spawn(k.gBrit, () => { const q = near(Bf, 220); shell(q.x, q.z, 1.1, true); });
    // Very lights at night
    if (t > 21 * 60 + 40) spawn(0.06, () => { const q = near(nml, 300); r.bursts.push({ x: q.x, y: ground(q.x, q.z) + 60, z: q.z, size: 14, r: 1, g: 1, b: 0.85, a: 1, vy: 8, grow: 0, life: 5, age: 0, glow: true }); });
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
  const show = (html: string) => { info.innerHTML = `<button class="x" id="info-x">×</button>${html}`; info.classList.remove('hidden'); $('info-x').onclick = () => info.classList.add('hidden'); };
  function showBn(u: Battalion) {
    const d = divs.find(x => x.name === u.division);
    show(`<h3>${esc(u.name)}</h3>${u.nick ? `<div class="nick">${esc(u.nick)}</div>` : ''}
      <p>${esc(u.brigade)} · ${esc(u.division)}<br>${esc(u.corps)}, ${esc(u.army)}</p>
      <p>${u.wave === 1 ? 'Leading wave' : u.wave === 2 ? 'Following wave' : 'Support / reserve brigade'}${u.involved ? '' : ' · not heavily involved on 1 July'}</p>
      ${u.cas ? `<p class="cas">Casualties on 1 July: <b>${u.cas.total}</b> (${u.cas.officers} officers, ${u.cas.men} men)</p>` : '<p class="dim">Battalion casualty figure not yet in the data (only those over 500 are).</p>'}
      ${d?.cas ? `<p class="dim">Division: ${d.cas.casualties.toLocaleString()} casualties, ${d.cas.killed.toLocaleString()} killed.</p>` : ''}
      <p class="dim">Position approximate: placed along the division's frontage from the order of battle.</p>`);
  }
  function showDiv(name: string) {
    const d = divs.find(x => x.name === name)!; const bns = units.filter(u => u.division === name);
    show(`<h3>${esc(d.name)}</h3><p>${esc(d.corps)} · ${esc(d.commander)} · ${({ REG: 'Regular', NA: 'New Army', TF: 'Territorial' } as any)[d.type] ?? d.type}</p>
      ${d.cas ? `<p class="cas">1 July: <b>${d.cas.casualties.toLocaleString()}</b> casualties, ${d.cas.killed.toLocaleString()} killed</p><p>By nightfall: ${esc(d.cas.nightLine)}</p>` : ''}
      ${d.note ? `<p class="dim">${esc(d.note)}</p>` : ''}<p class="dim">${bns.length} battalions shown.</p>`);
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
    const past = evs.filter(e => e.t <= t);
    if (past.length === lastEvCount) return;
    if (playing && past.length > lastEvCount && lastEvCount >= 0) { const e = past[past.length - 1]; if (!e.text.includes(' mine blown')) toast(`${hhmm(e.t)} · ${e.text}`); }
    lastEvCount = past.length;
    const list = past.slice(-7).reverse();
    evEl.innerHTML = list.length ? list.map((e, i) => `<div class="ev" data-i="${i}"><span>${hhmm(e.t)}</span>${e.corps ? `<b>${esc(e.corps)}</b> ` : ''}${esc(e.text)}</div>`).join('') : '<div class="ev dim">The final bombardment is under way. Zero hour is 07:30.</div>';
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
    let best: Battalion | null = null, bd = Infinity;
    for (const u of units) {
      const dx = g.x - u.x, dz = g.z - u.z, a = Math.abs(dx * u.tx + dz * u.tz) - u.w / 2, b = Math.abs(dx * u.nx + dz * u.nz) - u.d / 2;
      const d = Math.max(a, b); if (d < bd) { bd = d; best = u; }
    }
    const slack = Math.max(15, cam.dist * 0.004);
    if (best && bd < slack) return showBn(best);
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
  $('help').onclick = e => { if ((e.target as HTMLElement).id === 'help' || (e.target as HTMLElement).tagName === 'BUTTON') $('help').classList.add('hidden'); };
  $('begin').onclick = () => { $('intro').classList.add('hidden'); play(true); };

  // ---------------- main loop ----------------
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const k = keys, pan = 420 * dt;
    if (k.has('w') || k.has('arrowup')) panBy(0, pan); if (k.has('s') || k.has('arrowdown')) panBy(0, -pan);
    if (k.has('a') || k.has('arrowleft')) panBy(pan, 0); if (k.has('d') || k.has('arrowright')) panBy(-pan, 0);
    if (k.has('q')) cam.gyaw += dt; if (k.has('e')) cam.gyaw -= dt;
    if (k.has('r')) cam.gpitch -= dt * 0.7; if (k.has('f')) cam.gpitch += dt * 0.7;
    if (k.has('=') || k.has('+')) cam.gdist *= Math.exp(-dt * 1.5); if (k.has('-')) cam.gdist *= Math.exp(dt * 1.5);
    prevT = t;
    if (playing) { t = Math.min(T1, t + dt * speed / 60); if (t >= T1) play(false); }
    for (const m of mines) if (prevT < m.t && t >= m.t && t - m.t < 4) mineBlast(m);
    effects(dt);
    // crater decals once a mine has gone up
    const decals: number[] = [];
    for (const m of mines) if (t >= m.t) { const R = m.crater_m * 0.8 + 6; r.quad(decals, m.p.x, m.p.z, R, 0, 0, R, [0.33, 0.29, 0.24, 0.95], 1, 2); r.quad(decals, m.p.x, m.p.z, R * 2.4, 0, 0, R * 2.4, [0.86, 0.84, 0.78, 0.55], 1, 1.5); }
    r.render(cam, light(t), decals, dt);
    $('clock').textContent = `${hhmm(t)}`;
    $('phase').textContent = t < 6 * 60 + 25 ? 'Final morning of the bombardment' : t < 7 * 60 + 20 ? 'Intense bombardment' : t < ZERO ? 'Mines · troops moving into no man\'s land' : t < ZERO + 3 ? 'Zero hour' : t < 21 * 60 ? 'The attack' : 'Nightfall';
    if (document.activeElement !== slider) slider.value = String(t);
    updateEvents();
    placeLabels();
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').classList.remove('on'); }
    requestAnimationFrame(frame);
  };
  $('loading').classList.add('hidden');
  $('intro').classList.remove('hidden');
  requestAnimationFrame(frame);
  (window as any).__app = { cam, r, units, divs, corps, get t() { return t; }, set t(v: number) { t = v; prevT = v; }, play, setSpeed, fly };
}

window.addEventListener('error', e => { const el = $('error'); el.classList.remove('hidden'); el.textContent = 'Error: ' + e.message; });
setTimeout(() => { try { boot(); } catch (err) { $('loading').classList.add('hidden'); const el = $('error'); el.classList.remove('hidden'); el.textContent = 'Failed to start: ' + (err instanceof Error ? err.message : String(err)); console.error(err); } }, 20);
