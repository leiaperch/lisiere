import './styles.css';
import gsap from 'gsap';
import * as THREE from 'three';
import { World } from './world/world';
import { state } from './world/light';
import { routeProfile } from './world/terrain';
import { START, TOTAL_LENGTH } from './world/paths';
import { Ambience } from './sound';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ───────── profil du sentier, commun au chargement et à la vignette ─────────
// Avant la fourche, on ne connaît pas encore la fin du parcours : le profil montre le tronc
// commun prolongé par la branche du littoral, et il est redessiné dès qu'un chemin est pris.
const SAMPLES = 90;
const METERS_PER_UNIT = 8;
let route = [START, 'cote'];
let profile = routeProfile(route, SAMPLES);
let hMin = Math.min(...profile);
let hMax = Math.max(...profile);
const trailKm = (TOTAL_LENGTH * METERS_PER_UNIT) / 1000;
const altitude = (h: number) => Math.round(318 + h * 6);

function setRoute(branch: string) {
  route = [START, branch];
  profile = routeProfile(route, SAMPLES);
  hMin = Math.min(...profile);
  hMax = Math.max(...profile);
}

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

// ───────── défilement → marche, carnet, profil, horloge ─────────
// Cinq étapes, qui ne s'affichent pas en grands titres : elles déclenchent la respiration de
// l'objectif, la note du carnet et l'annonce pour les lecteurs d'écran.
const STEPS = [
  { to: 0.19, name: 'Lisière' },
  { to: 0.38, name: 'Sous-bois' },
  { to: 0.5, name: 'La clairière' },
  { to: 0.56, name: 'La fourche' },
  { to: 1.01, name: 'La suite' },
];
const ENDINGS: Record<string, string> = { cote: 'La dune et l’océan', marais: 'Le marais et l’étang' };

function setupWalk(world: World) {
  const walkSection = $('#walk');
  const live = $('#chapter-live');
  let active = -1;

  const show = (i: number) => {
    if (i === active) return;
    const first = active < 0;
    active = i;
    const name = i === STEPS.length - 1 ? (ENDINGS[route[1]] ?? STEPS[i].name) : STEPS[i].name;
    live.textContent = `Étape ${i + 1} sur ${STEPS.length}, ${name}`;
    if (!first && !reduced) world.breathe();
  };

  const progress = () => {
    const max = walkSection.offsetHeight - window.innerHeight;
    const u = THREE.MathUtils.clamp(window.scrollY / Math.max(max, 1), 0, 1);
    world.setProgress(u);
    if (window.scrollY > 40) $('#hint').classList.add('gone');
  };
  window.addEventListener('scroll', progress, { passive: true });
  progress();

  // profil du sentier en bas à droite
  const line = $('#profile-line');
  const done = $<SVGPathElement & HTMLElement>('#profile-done');
  const dot = $('#profile-dot');
  const drawProfile = () => {
    line.setAttribute('d', profilePath(300, 60, 8));
    done.setAttribute('d', profilePath(300, 60, 8));
  };
  drawProfile();
  const doneLen = done.getTotalLength();
  done.style.strokeDasharray = `${doneLen}`;
  world.onChoose = (branch) => {
    setRoute(branch);
    drawProfile();
  };
  const km = $('#profile-km');
  const alt = $('#profile-alt');
  const clock = $('#clock');
  const temp = $('#temp');
  const root = document.documentElement.style;
  const tint = new THREE.Color();
  const shade = new THREE.Color();
  const white = new THREE.Color('#ffffff');
  let frame = 0;

  const forkHint = $('#fork-hint');
  world.onStuck = (stuck) => forkHint.classList.toggle('gone', !stuck);

  world.onFrame = (t) => {
    const i = STEPS.findIndex((s) => t < s.to);
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
    tint.copy(state.skyHorizon).lerp(white, 0.35);
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

// ───────── son et rencontres ─────────
const HOVER_LABELS = { bird: 'ils vont partir', flower: 'souffler', water: 'ricochet', path: 'par ici' } as const;

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

  // chaque rencontre a son bruit, et le curseur annonce ce qui va se passer
  const cursor = $('#cursor');
  const label = $('#cursor-label');
  world.onHover = (what) => {
    cursor.classList.toggle('acts', !!what);
    if (what) label.textContent = HOVER_LABELS[what];
  };
  const chosen = world.onChoose;
  world.onChoose = (branch) => {
    chosen?.(branch);
    amb.setBranch(branch);
  };
  world.onBirds = () => amb.flutter();
  world.onBlow = () => amb.puff();
  world.onSplash = () => amb.plop();
}

// ───────── mesures affichées en fin de page ─────────
function setupMetrics(world: World) {
  const out = (k: string) => document.querySelector<HTMLElement>(`[data-live="${k}"]`)!;
  const nf = new Intl.NumberFormat('fr-FR');
  out('trees').textContent = nf.format(world.stats.trees);
  out('blades').textContent = nf.format(world.stats.blades);
  out('under').textContent = nf.format(world.stats.undergrowth);
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
