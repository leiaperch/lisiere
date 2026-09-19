import './styles.css';
import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';
import * as THREE from 'three';
import { World } from './world/world';
import { state } from './world/light';
import { TRAIL, heightAt, trailPoint } from './world/terrain';
import { Ambience } from './sound';

gsap.registerPlugin(SplitText);

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ce que le promeneur note à chaque chapitre
const NOTES = [
  { species: 'Pinson des arbres, deux chants', place: 'lisière, prairie' },
  { species: 'Pic épeiche, au loin', place: 'sous-bois de pins' },
  { species: 'Chevreuil, bord nord', place: 'clairière' },
  { species: 'Lucioles, une trentaine', place: 'herbes hautes' },
  { species: 'Chouette hulotte', place: 'rive du lac' },
];

// ───────── profil du sentier, commun au chargement et à la carte ─────────
const SAMPLES = 90;
const profile = Array.from({ length: SAMPLES }, (_, i) => {
  const p = trailPoint(i / (SAMPLES - 1));
  return heightAt(p.x, p.z, 0);
});
const hMin = Math.min(...profile);
const hMax = Math.max(...profile);
const METERS_PER_UNIT = 8;
const trailKm = (TRAIL.getLength() * METERS_PER_UNIT) / 1000;
const altitude = (h: number) => Math.round(318 + h * 6);

function profilePath(w: number, h: number, pad: number, flat = false) {
  return profile
    .map((v, i) => {
      const x = (i / (SAMPLES - 1)) * w;
      const y = flat ? h / 2 : pad + (1 - (v - hMin) / (hMax - hMin || 1)) * (h - pad * 2);
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

async function boot() {
  const loaderPath = $<SVGPathElement & HTMLElement>('#loader-path');
  loaderPath.setAttribute('d', profilePath(1000, 200, 30));
  const len = loaderPath.getTotalLength();
  loaderPath.style.strokeDasharray = `${len}`;
  loaderPath.style.strokeDashoffset = `${len}`;
  const pct = $('#loader-pct');
  const label = $('#loader-label');
  const drawn = { p: 0 };
  const draw = (p: number) =>
    gsap.to(drawn, {
      p,
      duration: 0.6,
      ease: 'power2.out',
      onUpdate: () => {
        loaderPath.style.strokeDashoffset = `${len * (1 - drawn.p)}`;
        pct.textContent = String(Math.round(drawn.p * 100));
      },
    });

  const world = new World($('#stage'));
  await world.build((p, text) => {
    draw(p);
    label.textContent = text;
  });
  if (import.meta.env.DEV) Object.assign(window, { __lisiere: { world, state, gsap } });
  await draw(1);

  // le sentier dessiné s'aplatit en ligne d'horizon, puis la scène s'ouvre depuis cette ligne
  const intro = gsap.timeline();
  intro.to(loaderPath, { attr: { d: profilePath(1000, 200, 30, true) }, duration: reduced ? 0 : 1.1, ease: 'power3.inOut' });
  intro.to('.loader-title, .loader-step', { opacity: 0, y: -10, duration: 0.5, stagger: 0.08 }, 0);
  intro.add(() => $('#stage').classList.add('open'), '-=0.2');
  intro.add(() => $('#loader').classList.add('gone'), '+=0.5');

  setupWalk(world);
  setupCursor();
  setupSound(world);
  setupMetrics(world);
}

// ───────── défilement → marche, chapitres, carnet, profil, horloge ─────────
function setupWalk(world: World) {
  const walk = $('#walk');
  const chapters = [...document.querySelectorAll<HTMLElement>('.chapter')];
  const splits = chapters.map((c) => {
    const title = c.querySelector('.chapter-title')!;
    const text = c.querySelector('.chapter-text')!;
    const st = new SplitText(title, { type: 'chars,lines', mask: 'lines', linesClass: 'line-mask' });
    const sx = new SplitText(text, { type: 'lines', mask: 'lines', linesClass: 'line-mask' });
    return { title: st, text: sx, num: c.querySelector('.chapter-num')! };
  });
  let active = -1;
  let seenNotes = 0;
  const notes = $('#notes');

  const show = (i: number) => {
    if (i === active) return;
    const prev = active;
    active = i;
    if (prev >= 0) {
      const p = splits[prev];
      gsap.to([p.title.chars, p.text.lines, p.num], {
        yPercent: -110,
        opacity: 0,
        duration: 0.5,
        ease: 'power2.in',
        stagger: 0.012,
        onComplete: () => {
          if (active !== prev) chapters[prev].classList.remove('on');
        },
      });
    }
    chapters[i].classList.add('on');
    const s = splits[i];
    gsap.killTweensOf([s.title.chars, s.text.lines, s.num]);
    gsap.fromTo(s.num, { yPercent: 100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.8, ease: 'power3.out', delay: 0.25 });
    gsap.fromTo(s.title.chars, { yPercent: 115, opacity: 1 }, { yPercent: 0, opacity: 1, duration: 1.1, ease: 'expo.out', stagger: 0.035, delay: 0.3 });
    gsap.fromTo(s.text.lines, { yPercent: 105, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 1, ease: 'power3.out', stagger: 0.08, delay: 0.55 });
    if (prev >= 0 && !reduced) world.breathe();

    // le carnet garde la trace de chaque chapitre atteint, écrit à la main
    while (seenNotes <= i) {
      const n = NOTES[seenNotes];
      const li = document.createElement('li');
      li.innerHTML = `${clockText(state.clock)} · ${n.species}<small>${n.place}, ${Math.round(state.temperature)} °C</small>`;
      notes.append(li);
      gsap.to(li, { clipPath: 'inset(0 0% 0 0)', duration: reduced ? 0 : 1.6, ease: 'none', delay: 0.6 + (i - seenNotes) * 0.2 });
      notes.querySelectorAll('li').forEach((el, k, all) => el.classList.toggle('past', k < all.length - 1));
      seenNotes++;
    }
  };

  const progress = () => {
    const max = walk.offsetHeight - window.innerHeight;
    const u = THREE.MathUtils.clamp(window.scrollY / Math.max(max, 1), 0, 1);
    world.setProgress(u);
    if (window.scrollY > 40) $('#hint').classList.add('gone');
    return u;
  };
  window.addEventListener('scroll', progress, { passive: true });
  progress();

  // profil du sentier en bas à droite
  const line = $('#profile-line');
  const done = $<SVGPathElement & HTMLElement>('#profile-done');
  const dot = $('#profile-dot');
  line.setAttribute('d', profilePath(300, 60, 8));
  done.setAttribute('d', profilePath(300, 60, 8));
  const doneLen = done.getTotalLength();
  done.style.strokeDasharray = `${doneLen}`;
  const km = $('#profile-km');
  const alt = $('#profile-alt');
  const clock = $('#clock');
  const temp = $('#temp');
  const root = document.documentElement.style;
  const tint = new THREE.Color();
  const shade = new THREE.Color();
  let frame = 0;

  world.onFrame = (t) => {
    // chapitre en cours
    const i = chapters.findIndex((c) => t >= Number(c.dataset.from) && t < Number(c.dataset.to));
    if (i >= 0) show(i);
    if (frame++ % 3) return;

    done.style.strokeDashoffset = `${doneLen * (1 - t)}`;
    const k = t * (SAMPLES - 1);
    const h = profile[Math.floor(k)] + (profile[Math.min(Math.ceil(k), SAMPLES - 1)] - profile[Math.floor(k)]) * (k % 1);
    dot.setAttribute('cx', (t * 300).toFixed(1));
    dot.setAttribute('cy', (8 + (1 - (h - hMin) / (hMax - hMin || 1)) * 44).toFixed(1));
    km.textContent = `${(t * trailKm).toFixed(1).replace('.', ',')} km`;
    alt.textContent = `${altitude(h)} m`;
    clock.textContent = clockText(state.clock);
    temp.textContent = `${Math.round(state.temperature)} °C`;

    // l'interface prend la lumière du moment : traits dorés au coucher, bleutés la nuit
    tint.copy(state.skyHorizon).lerp(new THREE.Color('#ffffff'), 0.35);
    shade.copy(state.grade).multiplyScalar(0.8);
    root.setProperty('--tint', `#${tint.getHexString()}`);
    root.setProperty('--shade', `rgba(${Math.round(shade.r * 255)}, ${Math.round(shade.g * 255)}, ${Math.round(shade.b * 255)}, 0.6)`);
    root.setProperty('--lantern', state.lantern.toFixed(2));
  };
}

const clockText = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `${h} h ${String(m).padStart(2, '0')}`;
};

// ───────── curseur : un point, qui devient lanterne à la nuit ─────────
function setupCursor() {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  document.documentElement.classList.add('has-cursor');
  const el = $('#cursor');
  const pos = { x: -100, y: -100 };
  const setX = gsap.quickTo(el, 'x', { duration: 0.35, ease: 'power3.out' });
  const setY = gsap.quickTo(el, 'y', { duration: 0.35, ease: 'power3.out' });
  window.addEventListener('pointermove', (e) => {
    pos.x = e.clientX;
    pos.y = e.clientY;
    setX(pos.x);
    setY(pos.y);
    el.classList.toggle('link', !!(e.target as HTMLElement).closest('a, button'));
  });
}

// ───────── son ─────────
function setupSound(world: World) {
  const amb = new Ambience();
  const btn = $('#sound');
  btn.addEventListener('click', async () => {
    const on = await amb.toggle();
    btn.setAttribute('aria-pressed', String(on));
  });
  const prev = world.onFrame;
  world.onFrame = (t) => {
    prev?.(t);
    amb.setProgress(t);
  };
}

// ───────── mesures affichées en fin de page ─────────
function setupMetrics(world: World) {
  const out = (k: string) => document.querySelector<HTMLElement>(`[data-live="${k}"]`)!;
  const nf = new Intl.NumberFormat('fr-FR');
  out('trees').textContent = nf.format(world.stats.trees);
  out('blades').textContent = nf.format(world.stats.blades);
  let last = performance.now();
  let frames = world.stats.frames;
  setInterval(() => {
    const now = performance.now();
    const fps = ((world.stats.frames - frames) * 1000) / (now - last);
    last = now;
    frames = world.stats.frames;
    out('calls').textContent = nf.format(world.stats.calls);
    out('fps').textContent = String(Math.round(fps));
  }, 1000);
}

boot().catch((err) => {
  console.error(err);
  $('#loader-label').textContent = "La scène n'a pas pu démarrer sur ce navigateur (WebGL 2 requis).";
});
