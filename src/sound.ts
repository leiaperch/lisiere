// Ambiance sonore synthétisée en direct (Web Audio), sans aucun fichier :
// vent dans les feuilles, oiseaux au coucher du soleil, grillons à l'heure bleue,
// chouette et clapotis au bord du lac. Chaque couche suit l'avancée de la balade.
//
// Par-dessous court une musique, synthétisée elle aussi. Elle n'a ni mesure ni boucle : une pédale
// de ré et de la, tenue du début à la fin, et des notes isolées prises dans la pentatonique de ré
// mineur, espacées de plusieurs secondes. Aucune de ces notes ne peut jurer avec les autres, ce
// qui permet de les tirer au sort sans jamais tomber sur une fausse note — et l'absence de pulsion
// fait qu'on ne l'attend pas, ce qui est exactement ce qu'on demande à une musique de fond.

export class Ambience {
  private ctx?: AudioContext;
  private master!: GainNode;
  private layers: Record<'wind' | 'birds' | 'crickets' | 'night' | 'water' | 'music', GainNode> = {} as never;
  private padFilter!: BiquadFilterNode;
  private windFilter!: BiquadFilterNode;
  private waterFilter!: BiquadFilterNode;
  private lapDepth!: GainNode;
  private lapLfo!: OscillatorNode;
  private branch: string | null = null;
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
    set(this.layers.water, ramp(t, this.branch === 'cote' ? 0.6 : 0.82, 1));
    // la musique entre après les premiers pas, se retire un peu quand les grillons prennent le
    // dessus, et revient pour l'arrivée
    set(this.layers.music, ramp(t, 0.04, 0.2) * 0.55 - ramp(t, 0.45, 0.7) * 0.2 + ramp(t, 0.86, 1) * 0.3);
    // la pédale s'assombrit à mesure que le jour tombe
    this.padFilter.frequency.setTargetAtTime(900 - t * 480, now, 3);
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
    bus('music', 0.75);

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
    const wf = (this.waterFilter = ctx.createBiquadFilter());
    wf.type = 'bandpass';
    wf.frequency.value = 900;
    wf.Q.value = 0.8;
    const lap = ctx.createGain();
    lap.gain.value = 0.2;
    const lapLfo = (this.lapLfo = ctx.createOscillator());
    lapLfo.frequency.value = 0.4;
    const lapAmt = (this.lapDepth = ctx.createGain());
    lapAmt.gain.value = 0.18;
    lapLfo.connect(lapAmt).connect(lap.gain);
    water.connect(wf).connect(lap).connect(this.layers.water);
    water.start();
    lapLfo.start();

    this.pad();
    // une note toutes les cinq à onze secondes : assez rare pour qu'on ne la guette pas
    this.every(() => this.note(), 5000, 11000);

    // événements ponctuels : chants d'oiseaux, trilles de grillons, chouette
    this.every(() => this.bird(), 900, 2600);
    this.every(() => this.cricket(), 160, 420);
    this.every(() => this.owl(), 7000, 14000);
    this.setProgress(this.t);
    if (this.branch) this.setBranch(this.branch);
  }

  // La branche prise change l'eau que l'on entend : la respiration longue de l'océan d'un côté,
  // le clapot d'un étang et les grenouilles de l'autre.
  setBranch(branch: string) {
    this.branch = branch;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (branch === 'cote') {
      this.waterFilter.frequency.setTargetAtTime(480, now, 2);
      this.waterFilter.Q.setTargetAtTime(0.5, now, 2);
      this.lapLfo.frequency.setTargetAtTime(0.11, now, 2);
      this.lapDepth.gain.setTargetAtTime(0.5, now, 2);
    } else {
      this.waterFilter.frequency.setTargetAtTime(1100, now, 2);
      this.lapLfo.frequency.setTargetAtTime(0.7, now, 2);
      this.lapDepth.gain.setTargetAtTime(0.14, now, 2);
      this.every(() => this.frog(), 2400, 6500);
    }
  }

  // grenouille : deux coups de gorge courts, filtrés bas
  private frog() {
    const ctx = this.ctx;
    if (!ctx || this.t < 0.55) return;
    const now = ctx.currentTime;
    for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
      const at = now + i * (0.16 + Math.random() * 0.08);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(150 + Math.random() * 60, at);
      o.frequency.exponentialRampToValueAtTime(90, at + 0.09);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 700;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.09, at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
      o.connect(f).connect(g).connect(this.layers.night);
      o.start(at);
      o.stop(at + 0.14);
    }
  }

  /**
   * La pédale : ré et la tenus, à trois hauteurs, chaque voix légèrement désaccordée des autres.
   * C'est ce désaccord de quelques centièmes de ton qui fait battre le son lentement, et qui
   * l'empêche de ressembler à une sirène.
   */
  private pad() {
    const ctx = this.ctx!;
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.6;
    this.padFilter.connect(this.layers.music);
    for (const [freq, detune, level] of [
      [73.42, -6, 0.5],  // ré1
      [110.0, 4, 0.34],  // la1
      [146.83, -3, 0.26], // ré2
      [220.0, 7, 0.12],  // la2
    ] as [number, number, number][]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level * 0.14;
      // une respiration très lente, propre à chaque voix : rien ne reste jamais tout à fait fixe
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.03 + Math.random() * 0.05;
      const amt = ctx.createGain();
      amt.gain.value = level * 0.05;
      lfo.connect(amt).connect(g.gain);
      o.connect(g).connect(this.padFilter);
      o.start();
      lfo.start();
    }
  }

  /** une note isolée, prise dans la pentatonique : cloche douce, longue à mourir */
  private note() {
    const ctx = this.ctx;
    if (!ctx || this.t < 0.05) return;
    // ré mineur pentatonique sur deux octaves et demie
    const scale = [146.83, 174.61, 196.0, 220.0, 261.63, 293.66, 349.23, 392.0, 440.0, 523.25];
    // le registre descend avec le jour : clair au départ, grave une fois la nuit tombée
    const top = Math.round(scale.length - 1 - this.t * 4);
    const f = scale[Math.max(0, Math.floor(Math.random() * (top + 1)))];
    const now = ctx.currentTime;
    const dur = 3.4 + Math.random() * 2.6;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.2 - 0.6;
    pan.connect(this.layers.music);
    // fondamentale et octave : l'octave, brève, fait l'attaque de la cloche
    for (const [mult, level, decay] of [
      [1, 0.075, 1],
      [2, 0.03, 0.45],
      [3, 0.012, 0.25],
    ] as [number, number, number][]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(level, now + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur * decay);
      o.connect(g).connect(pan);
      o.start(now);
      o.stop(now + dur + 0.1);
    }
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

  // ───────── bruits des rencontres ─────────

  // envol : battements d'ailes, bruit filtré par bouffées, suivi de deux cris
  flutter() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.pinkNoise(1.2);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 700;
    f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    for (let i = 0; i < 9; i++) {
      const t = now + i * 0.085;
      g.gain.linearRampToValueAtTime(0.16 * (1 - i / 11), t + 0.02);
      g.gain.linearRampToValueAtTime(0.02, t + 0.06);
    }
    g.gain.linearRampToValueAtTime(0, now + 0.95);
    src.connect(f).connect(g).connect(this.layers.birds);
    src.start(now);
    src.stop(now + 1.2);
    this.bird();
    setTimeout(() => this.bird(), 260);
  }

  // souffle sur un pissenlit : petite bouffée d'air
  puff() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.pinkNoise(0.6);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.setValueAtTime(900, now);
    f.frequency.exponentialRampToValueAtTime(2600, now + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.09, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0005, now + 0.5);
    src.connect(f).connect(g).connect(this.layers.wind);
    src.start(now);
    src.stop(now + 0.6);
  }

  // ricochet : « ploc » grave qui monte, puis une trace d'eau
  plop() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, now);
    o.frequency.exponentialRampToValueAtTime(680, now + 0.09);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.22, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    o.connect(g).connect(this.layers.water);
    o.start(now);
    o.stop(now + 0.25);
    const src = ctx.createBufferSource();
    src.buffer = this.pinkNoise(0.5);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.06, now);
    ng.gain.exponentialRampToValueAtTime(0.0005, now + 0.35);
    src.connect(f).connect(ng).connect(this.layers.water);
    src.start(now);
    src.stop(now + 0.4);
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
