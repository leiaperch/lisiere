import * as THREE from 'three';

// Le temps de la balade : de 19 h 40 (soleil bas, doré) à 21 h 10 (nuit, lune levée).
// Chaque clé décrit la lumière d'un moment ; la scène et la page interpolent entre elles.

export interface LightKey {
  t: number; // position dans la balade, 0 → 1
  clock: number; // minutes depuis minuit
  sunElevation: number; // degrés au-dessus de l'horizon
  sunAzimuth: number; // degrés, 0 = devant (−Z), positif vers la droite
  sun: string; // couleur de la lumière directe
  sunPower: number;
  skyTop: string;
  skyHorizon: string;
  fog: string;
  fogDensity: number;
  ambient: number;
  exposure: number;
  grade: string; // teinte appliquée aux ombres par l'étalonnage
  fireflies: number;
  lantern: number;
  moon: number;
  temperature: number; // °C affichés dans le carnet
}

export const KEYS: LightKey[] = [
  { t: 0.0, clock: 19 * 60 + 40, sunElevation: 11, sunAzimuth: -28, sun: '#ffc27a', sunPower: 3.2, skyTop: '#4f7fb8', skyHorizon: '#ffcf8a', fog: '#b98458', fogDensity: 0.0042, ambient: 0.55, exposure: 1.0, grade: '#3a2a1a', fireflies: 0, lantern: 0, moon: 0, temperature: 21 },
  { t: 0.24, clock: 19 * 60 + 58, sunElevation: 5, sunAzimuth: -22, sun: '#ffab5c', sunPower: 3.4, skyTop: '#44699f', skyHorizon: '#ffb070', fog: '#9c6c4a', fogDensity: 0.0075, ambient: 0.45, exposure: 1.02, grade: '#2e2418', fireflies: 0, lantern: 0, moon: 0, temperature: 19 },
  { t: 0.48, clock: 20 * 60 + 20, sunElevation: 1.2, sunAzimuth: -14, sun: '#ff8a5a', sunPower: 2.4, skyTop: '#394b80', skyHorizon: '#f08c72', fog: '#7c5a66', fogDensity: 0.01, ambient: 0.38, exposure: 1.05, grade: '#2a2030', fireflies: 0.1, lantern: 0, moon: 0.1, temperature: 17 },
  { t: 0.72, clock: 20 * 60 + 45, sunElevation: -4, sunAzimuth: -8, sun: '#8a8fd6', sunPower: 0.5, skyTop: '#16204a', skyHorizon: '#50609a', fog: '#2c3560', fogDensity: 0.012, ambient: 0.36, exposure: 1.1, grade: '#141a33', fireflies: 1, lantern: 0.7, moon: 0.5, temperature: 15 },
  { t: 1.0, clock: 21 * 60 + 10, sunElevation: -10, sunAzimuth: 0, sun: '#6b78c9', sunPower: 0.15, skyTop: '#060a1a', skyHorizon: '#18214a', fog: '#121a36', fogDensity: 0.01, ambient: 0.28, exposure: 1.18, grade: '#0a0f24', fireflies: 0.8, lantern: 1, moon: 1, temperature: 13 },
];

// Uniformes partagés par tous les matériaux de la forêt
export const world = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 0.2, -1).normalize() },
  uSunColor: { value: new THREE.Color() },
  uSkyTop: { value: new THREE.Color() },
  uSkyHorizon: { value: new THREE.Color() },
  uFogColor: { value: new THREE.Color() },
  uFogDensity: { value: 0.015 },
  uAmbient: { value: 0.5 },
  uMoonDir: { value: new THREE.Vector3(0.35, 0.25, -1).normalize() },
  uMoon: { value: 0 },
  uLantern: { value: new THREE.Vector4(0, -100, 0, 0) }, // xyz position, w intensité
  uWind: { value: 1 },
  uShadowMap: { value: null as THREE.Texture | null },
  uShadowBounds: { value: new THREE.Vector4(-160, -260, 320, 320) }, // x, z, largeur, profondeur
  uShadowStrength: { value: 1 },
  // ombres portées calculées en direct depuis le soleil (voir shadow.ts)
  uShadowMapSun: { value: null as THREE.Texture | null },
  uSunMatrix: { value: new THREE.Matrix4() },
  uSunShadowStrength: { value: 0 },
};

export interface LightState {
  clock: number;
  temperature: number;
  fireflies: number;
  lantern: number;
  moon: number;
  exposure: number;
  grade: THREE.Color;
  fog: THREE.Color;
  skyHorizon: THREE.Color;
  skyTop: THREE.Color;
  sunElevation: number;
}

const ca = new THREE.Color();
const cb = new THREE.Color();
const mix = (a: string, b: string, k: number, out: THREE.Color) => out.copy(ca.set(a)).lerp(cb.set(b), k);

export const state: LightState = {
  clock: KEYS[0].clock,
  temperature: KEYS[0].temperature,
  fireflies: 0,
  lantern: 0,
  moon: 0,
  exposure: 1,
  grade: new THREE.Color(),
  fog: new THREE.Color(),
  skyHorizon: new THREE.Color(),
  skyTop: new THREE.Color(),
  sunElevation: KEYS[0].sunElevation,
};

// Place la lumière à l'instant t de la balade
export function setDaylight(t: number) {
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const k = THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1);
  const lerp = (x: number, y: number) => x + (y - x) * k;

  const elev = THREE.MathUtils.degToRad(lerp(a.sunElevation, b.sunElevation));
  const azim = THREE.MathUtils.degToRad(lerp(a.sunAzimuth, b.sunAzimuth));
  world.uSunDir.value.set(Math.sin(azim) * Math.cos(elev), Math.sin(elev), -Math.cos(azim) * Math.cos(elev)).normalize();
  mix(a.sun, b.sun, k, world.uSunColor.value).multiplyScalar(lerp(a.sunPower, b.sunPower));
  mix(a.skyTop, b.skyTop, k, world.uSkyTop.value);
  mix(a.skyHorizon, b.skyHorizon, k, world.uSkyHorizon.value);
  mix(a.fog, b.fog, k, world.uFogColor.value);
  world.uFogDensity.value = lerp(a.fogDensity, b.fogDensity);
  world.uAmbient.value = lerp(a.ambient, b.ambient);
  world.uMoon.value = lerp(a.moon, b.moon);
  // les ombres longues n'existent que tant que le soleil éclaire
  world.uShadowStrength.value = THREE.MathUtils.smoothstep(lerp(a.sunElevation, b.sunElevation), -1, 4);

  state.clock = lerp(a.clock, b.clock);
  state.temperature = lerp(a.temperature, b.temperature);
  state.fireflies = lerp(a.fireflies, b.fireflies);
  state.lantern = lerp(a.lantern, b.lantern);
  state.moon = lerp(a.moon, b.moon);
  state.exposure = lerp(a.exposure, b.exposure);
  state.sunElevation = lerp(a.sunElevation, b.sunElevation);
  mix(a.grade, b.grade, k, state.grade);
  state.fog.copy(world.uFogColor.value);
  state.skyHorizon.copy(world.uSkyHorizon.value);
  state.skyTop.copy(world.uSkyTop.value);
}

// ───────────── GLSL partagé ─────────────

export const glslNoise = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1,0)), u.x), mix(hash12(i + vec2(0,1)), hash12(i + vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

export const glslWorld = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uAmbient;
uniform vec3 uMoonDir;
uniform float uMoon;
uniform vec4 uLantern;
uniform float uWind;
uniform sampler2D uShadowMap;
uniform vec4 uShadowBounds;
uniform float uShadowStrength;
uniform sampler2D uShadowMapSun;
uniform mat4 uSunMatrix;
uniform float uSunShadowStrength;

// Ciel : dégradé vertical, halo du soleil, lueur de lune
vec3 skyColor(vec3 dir){
  float h = clamp(dir.y, -0.2, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyTop, pow(max(h, 0.0), 0.55));
  float sun = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * (pow(sun, 8.0) * 0.08 + pow(sun, 64.0) * 0.25);
  float moon = max(dot(dir, uMoonDir), 0.0);
  col += vec3(0.55, 0.62, 0.85) * uMoon * pow(moon, 24.0) * 0.35;
  return col;
}

// Brouillard qui retient la lumière : plus dense au ras du sol, doré vers le soleil (diffusion vers l'avant)
vec3 applyFog(vec3 col, vec3 worldPos, vec3 camPos){
  vec3 d = worldPos - camPos;
  float dist = length(d);
  vec3 dir = d / dist;
  float heightFalloff = exp(-max(worldPos.y + 1.0, 0.0) * 0.12);
  float amount = 1.0 - exp(-dist * uFogDensity * (0.35 + heightFalloff * 1.2));
  float forward = pow(max(dot(dir, uSunDir), 0.0), 10.0);
  vec3 fogCol = uFogColor + uSunColor * (forward * 0.55 + pow(max(dot(dir, uSunDir), 0.0), 60.0) * 0.8);
  return mix(col, fogCol, clamp(amount, 0.0, 1.0));
}

// Ombres longues des arbres, peintes une fois sur une texture vue du ciel
float groundShadow(vec3 worldPos){
  vec2 uv = (worldPos.xz - uShadowBounds.xy) / uShadowBounds.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  float s = texture2D(uShadowMap, uv).r;
  return mix(1.0, s, uShadowStrength);
}

// Ombre portée du soleil : profondeur vue depuis le soleil, comparée à celle du point éclairé.
// Hors de la zone couverte (quelques dizaines de mètres), on retombe sur les ombres peintes.
float sunShadow(vec3 worldPos, float ndl){
  float painted = groundShadow(worldPos);
  if (uSunShadowStrength <= 0.001) return painted;
  vec4 proj = uSunMatrix * vec4(worldPos, 1.0);
  vec3 uvz = proj.xyz / proj.w * 0.5 + 0.5;
  if (uvz.x < 0.001 || uvz.y < 0.001 || uvz.x > 0.999 || uvz.y > 0.999 || uvz.z > 1.0) return painted;
  float bias = 0.0006 + 0.0022 * (1.0 - clamp(ndl, 0.0, 1.0));
  float texel = 1.0 / 2048.0;
  float lit = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 3 ? 1.0 : -1.0, i < 2 ? 1.0 : -1.0) * texel * 1.3;
    float d = texture2D(uShadowMapSun, uvz.xy + o).r;
    lit += uvz.z - bias > d ? 0.0 : 1.0;
  }
  lit *= 0.25;
  // fondu sur les bords de la zone couverte, pour que la limite ne se voie pas
  vec2 edge = smoothstep(vec2(0.0), vec2(0.08), uvz.xy) * smoothstep(vec2(1.0), vec2(0.92), uvz.xy);
  float inside = edge.x * edge.y * uSunShadowStrength;
  // dans la zone couverte, l'ombre calculée remplace l'ombre peinte (sinon elles s'additionnent)
  return mix(painted, lit, inside);
}

// Lanterne du promeneur : lumière chaude à courte portée qui suit le curseur
vec3 lantern(vec3 worldPos, vec3 n){
  vec3 l = uLantern.xyz - worldPos;
  float d = length(l);
  float att = uLantern.w / (1.0 + d * d * 0.35);
  float lambert = max(dot(n, l / d), 0.0) * 0.8 + 0.2;
  return vec3(1.0, 0.72, 0.42) * att * lambert;
}
`;
