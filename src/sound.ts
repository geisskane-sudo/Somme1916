// Sound: off by default. Recorded effects (snd/, from the owner's Western Front project) placed in the world and
// heard from the camera: far away a shell is quiet, late (speed of sound, at real time only) and muffled
// (low-pass by distance), so a zoomed-out view hears a low distant drumfire; close in it is loud and sharp.
type V3 = { x: number; y: number; z: number };
const FILES = { guns: 'snd/guns_loop.mp3', boom1: 'snd/boom1.mp3', boom2: 'snd/boom2.mp3', boom3: 'snd/boom3.mp3', mg: 'snd/mg_burst.mp3', small: 'snd/smallarms.mp3', incoming: 'snd/incoming.mp3' };
type Key = keyof typeof FILES;

export class Sound {
  on = false;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private buf: Partial<Record<Key, AudioBuffer>> = {};
  private beds: Partial<Record<'guns' | 'small', { g: GainNode; f: BiquadFilterNode }>> = {};
  private eye: V3 = { x: 0, y: 0, z: 0 }; private right = { x: 1, z: 0 }; private dist = 5000;
  private budget = 0;          // shells heard per second are capped; the rest feed the drumfire bed
  private heard = 0;           // recent shell activity, for the bed
  realTime = false;

  toggle() { if (!this.ctx) this.init(); this.on = !this.on; const c = this.ctx!; if (this.on && c.state === 'suspended') void c.resume();
    this.master.gain.setTargetAtTime(this.on ? 0.9 : 0, c.currentTime, 0.15); return this.on; }

  private init() {
    const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const c = (this.ctx = new C());
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; comp.connect(c.destination);
    this.master = c.createGain(); this.master.gain.value = 0; this.master.connect(comp);
    for (const [k, u] of Object.entries(FILES) as [Key, string][])
      fetch(u).then(r => { if (!r.ok) throw new Error(u); return r.arrayBuffer(); })
        .then(a => c.decodeAudioData(a)).then(b => { this.buf[k] = b; if (k === 'guns' || k === 'small') this.bed(k); })
        .catch(e => console.warn('sound not loaded', u, e));
  }
  private bed(k: 'guns' | 'small') {
    const c = this.ctx!, s = c.createBufferSource(); s.buffer = this.buf[k]!; s.loop = true;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 800; const g = c.createGain(); g.gain.value = 0;
    s.connect(f); f.connect(g); g.connect(this.master); s.start(0, Math.random() * this.buf[k]!.duration); this.beds[k] = { g, f };
  }
  /** a one-shot heard from the camera: gain, distance cut-off, pan, delay */
  private shot(k: Key, p: V3, loud: number, rate = 1) {
    const c = this.ctx; if (!c || !this.on || !this.buf[k]) return;
    const dx = p.x - this.eye.x, dy = p.y - this.eye.y, dz = p.z - this.eye.z, d = Math.max(1, Math.hypot(dx, dy, dz));
    const g = loud * Math.min(1, Math.pow(220 / d, 1.15)); if (g < 0.004) return;
    const s = c.createBufferSource(); s.buffer = this.buf[k]!; s.playbackRate.value = rate * (0.9 + Math.random() * 0.2);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = Math.max(220, Math.min(16000, 16000 * Math.pow(250 / d, 0.9)));
    const gn = c.createGain(); gn.gain.value = g;
    const pn = c.createStereoPanner(); pn.pan.value = Math.max(-0.9, Math.min(0.9, (dx * this.right.x + dz * this.right.z) / d));
    s.connect(f); f.connect(gn); gn.connect(pn); pn.connect(this.master);
    s.start(c.currentTime + (this.realTime ? Math.min(4, d / 343) : 0) + Math.random() * 0.05);
  }

  /** where the listener is, once a frame */
  listen(eye: V3, yaw: number, dist: number, playing: boolean, dt: number, fight: number, night: boolean) {
    this.eye = eye; this.right = { x: Math.cos(yaw), z: -Math.sin(yaw) }; this.dist = dist;
    this.budget = Math.min(8, this.budget + dt * 7); this.heard *= Math.exp(-dt / 2);
    const c = this.ctx; if (!c) return;
    const near = Math.max(0, Math.min(1, (3500 - dist) / 3000));       // 1 close in, 0 from 3.5 km up
    const g = this.beds.guns, sm = this.beds.small, T = c.currentTime;
    if (g) {                                                             // the drumfire: always there, low and far
      const lvl = playing ? Math.min(0.55, 0.08 + this.heard * 0.02) * (night ? 0.4 : 1) : 0;
      g.g.gain.setTargetAtTime(lvl, T, 0.6); g.f.frequency.setTargetAtTime(350 + 900 * near, T, 0.6);
    }
    if (sm) {                                                            // rifle fire where the companies are fighting
      const lvl = playing ? Math.min(0.5, fight * 0.5) * (0.15 + 0.85 * near) : 0;
      sm.g.gain.setTargetAtTime(lvl, T, 0.4); sm.f.frequency.setTargetAtTime(600 + 7000 * near, T, 0.4);
    }
  }
  shell(p: V3, big: number, german: boolean) {
    this.heard += big;
    if (this.budget < 1) return; this.budget -= 1;
    const k = (['boom1', 'boom2', 'boom3'] as const)[Math.floor(Math.random() * 3)];
    this.shot(k, p, 0.8 * big, german ? 0.95 : 1.05);
    if (german && this.dist < 900 && Math.random() < 0.04) this.shot('incoming', p, 0.25);
  }
  machineGun(p: V3, loud = 0.6) { this.shot('mg', p, loud); }
  mine(p: V3, lb: number) {
    const big = Math.max(0.5, Math.sqrt(lb / 40000));
    for (const [k, r] of [['boom1', 0.45], ['boom2', 0.55], ['boom3', 0.38]] as const) this.shot(k, p, 2.2 * big, r);
    this.heard += 40 * big;
  }
}
