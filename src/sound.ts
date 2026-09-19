// Ambiance sonore synthétisée en direct (Web Audio), sans aucun fichier :
// vent dans les feuilles, oiseaux au coucher du soleil, grillons à l'heure bleue,
// chouette et clapotis au bord du lac. Chaque couche suit l'avancée de la balade.

export class Ambience {
  private ctx?: AudioContext;
  private master!: GainNode;
  private layers: Record<'wind' | 'birds' | 'crickets' | 'night' | 'water', GainNode> = {} as never;
  private windFilter!: BiquadFilterNode;
  private t = 0;
  private timers: number[] = [];
  enabled = false;

  async toggle(on = !this.enabled) {
    this.enabled = on;
    if (on && !this.ctx) this.start();
    if (!this.ctx) return on;
    if (on) await this.ctx.resume();
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(on ? 0.8 : 0, now, 0.4);
    return on;
  }

  // t : avancée de la balade (0 → 1)
  setProgress(t: number) {
    this.t = t;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const ramp = (x: number, a: number, b: number) => Math.min(1, Math.max(0, (x - a) / (b - a)));
    const set = (g: GainNode, v: number) => g.gain.setTargetAtTime(v, now, 0.6);
    set(this.layers.wind, 0.5 - ramp(t, 0.6, 1) * 0.25);
    set(this.layers.birds, 1 - ramp(t, 0.35, 0.62));
    set(this.layers.crickets, ramp(t, 0.5, 0.75));
    set(this.layers.night, ramp(t, 0.78, 0.95));
    set(this.layers.water, ramp(t, 0.82, 1));
    this.windFilter.frequency.setTargetAtTime(420 + (1 - t) * 380, now, 1);
  }

  private start() {
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    // un peu d'espace : réverbération courte synthétique
    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(2.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    verb.connect(wet).connect(this.master);
    this.master.connect(ctx.destination);
    const bus = (name: keyof Ambience['layers'], dry = 1) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      const d = ctx.createGain();
      d.gain.value = dry;
      g.connect(d).connect(this.master);
      g.connect(verb);
      this.layers[name] = g;
      return g;
    };
    bus('wind');
    bus('birds', 0.8);
    bus('crickets', 0.9);
    bus('night', 0.6);
    bus('water', 0.9);

    // vent : bruit rose filtré, dont l'intensité ondule lentement
    const noise = ctx.createBufferSource();
    noise.buffer = this.pinkNoise(4);
    noise.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 700;
    const gust = ctx.createGain();
    gust.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.35;
    lfo.connect(lfoAmt).connect(gust.gain);
    noise.connect(this.windFilter).connect(gust).connect(this.layers.wind);
    noise.start();
    lfo.start();

    // clapotis : bruit filtré passe-bande, par vaguelettes
    const water = ctx.createBufferSource();
    water.buffer = this.pinkNoise(3);
    water.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 900;
    wf.Q.value = 0.8;
    const lap = ctx.createGain();
    lap.gain.value = 0.2;
    const lapLfo = ctx.createOscillator();
    lapLfo.frequency.value = 0.4;
    const lapAmt = ctx.createGain();
    lapAmt.gain.value = 0.18;
    lapLfo.connect(lapAmt).connect(lap.gain);
    water.connect(wf).connect(lap).connect(this.layers.water);
    water.start();
    lapLfo.start();

    // événements ponctuels : chants d'oiseaux, trilles de grillons, chouette
    this.every(() => this.bird(), 900, 2600);
    this.every(() => this.cricket(), 160, 420);
    this.every(() => this.owl(), 7000, 14000);
    this.setProgress(this.t);
  }

  private every(fn: () => void, min: number, max: number) {
    const loop = () => {
      fn();
      this.timers.push(window.setTimeout(loop, min + Math.random() * (max - min)));
    };
    this.timers.push(window.setTimeout(loop, min));
  }

  // chant d'oiseau : suite de notes glissées sur une sinusoïde modulée
  private bird() {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.layers.birds);
    const notes = 2 + Math.floor(Math.random() * 5);
    const base = 2400 + Math.random() * 1800;
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t0 = now + i * (0.09 + Math.random() * 0.05);
      const f = base * (0.85 + Math.random() * 0.4);
      o.frequency.setValueAtTime(f, t0);
      o.frequency.exponentialRampToValueAtTime(f * (Math.random() > 0.5 ? 1.35 : 0.72), t0 + 0.07);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.05, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.08);
      o.connect(g).connect(pan);
      o.start(t0);
      o.stop(t0 + 0.1);
    }
  }

  // grillon : train d'impulsions aiguës
  private cricket() {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 2 - 1;
    pan.connect(this.layers.crickets);
    const f = 4200 + Math.random() * 600;
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t0 = now + i * 0.045;
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.018, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.035);
      o.connect(g).connect(pan);
      o.start(t0);
      o.stop(t0 + 0.04);
    }
  }

  // chouette hulotte : deux « hou » graves, le second tremblé
  private owl() {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() > 0.5 ? 0.7 : -0.7;
    pan.connect(this.layers.night);
    const hoot = (t0: number, dur: number, f: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t0);
      o.frequency.linearRampToValueAtTime(f * 0.93, t0 + dur);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.08, t0 + 0.06);
      g.gain.setValueAtTime(0.08, t0 + dur - 0.1);
      g.gain.linearRampToValueAtTime(0, t0 + dur);
      o.connect(g).connect(pan);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    };
    hoot(now, 0.45, 430);
    hoot(now + 1.1, 0.9, 410);
  }

  private pinkNoise(seconds: number) {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029591;
      b1 = 0.985 * b1 + w * 0.032534;
      b2 = 0.95 * b2 + w * 0.048056;
      d[i] = (b0 + b1 + b2 + w * 0.05) * 0.6;
    }
    return buf;
  }

  private impulse(seconds: number) {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }
}
