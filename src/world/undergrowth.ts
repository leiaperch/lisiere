import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CLEARING, DUNE, LAKE, MARSH, coastMask, fbm, heightAt } from './terrain';
import { type BiomeId, biomeAt, trailDistance } from './paths';
import { CRASTE, crasteDistance } from './craste';
import { underPalombiere } from './palombiere';
import { glslNoise, glslWorld, world } from './light';

// Le sous-bois : fougères, buissons, souches, troncs couchés et rochers. Cinq familles semées
// selon des règles (densité de forêt, distance au sentier), chacune dessinée en une instance.

export type Kind = 'fern' | 'bush' | 'stump' | 'log' | 'rock' | 'reed' | 'oyat' | 'molinie' | 'linaigrette' | 'salicorne';

interface Piece {
  x: number;
  z: number;
  y: number;
  scale: number;
  rot: number;
  tint: number;
}

let seed = 91;
const rand = () => {
  seed = (seed * 48271) % 2147483647;
  return (seed - 1) / 2147483646;
};

// ───────────── géométries ─────────────

function fern() {
  // une fougère : six frondes en éventail, chacune faite de folioles opposées
  const parts: THREE.BufferGeometry[] = [];
  for (let f = 0; f < 6; f++) {
    const frond: THREE.BufferGeometry[] = [];
    const len = 0.85 + rand() * 0.3;
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const leaf = new THREE.PlaneGeometry(0.34 * (1 - t * 0.7), 0.1);
      leaf.rotateY(Math.PI / 2);
      leaf.rotateZ(-0.5 - t * 0.5);
      leaf.translate(0, t * len * 0.9 + 0.12, 0);
      const right = leaf.clone();
      right.scale(-1, 1, 1);
      frond.push(leaf, right);
    }
    const g = mergeGeometries(frond)!;
    g.rotateX(0.5 + rand() * 0.25);
    g.rotateY((f / 6) * Math.PI * 2 + rand() * 0.4);
    parts.push(g);
  }
  return parts;
}

function bush() {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const r = 0.35 + rand() * 0.3;
    const b = new THREE.IcosahedronGeometry(r, 1);
    jitter(b, r * 0.3);
    b.translate((rand() - 0.5) * 0.7, r * 0.75 + rand() * 0.25, (rand() - 0.5) * 0.7);
    parts.push(b);
  }
  return parts;
}

function stump() {
  const trunk = new THREE.CylinderGeometry(0.34, 0.46, 0.75, 9, 1);
  jitter(trunk, 0.05);
  trunk.translate(0, 0.36, 0);
  const roots: THREE.BufferGeometry[] = [trunk];
  for (let i = 0; i < 4; i++) {
    const r = new THREE.CylinderGeometry(0.06, 0.16, 0.6, 5, 1);
    r.rotateZ(1.25);
    r.rotateY((i / 4) * Math.PI * 2 + rand());
    r.translate(0, 0.1, 0);
    roots.push(r);
  }
  return roots;
}

function log() {
  const body = new THREE.CylinderGeometry(0.26, 0.32, 4.2, 9, 3);
  jitter(body, 0.06);
  body.rotateZ(Math.PI / 2);
  body.translate(0, 0.3, 0);
  const branch = new THREE.CylinderGeometry(0.05, 0.1, 1.1, 5);
  branch.rotateZ(0.9);
  branch.translate(0.9, 0.55, 0.2);
  return [body, branch];
}

function rock() {
  const g = new THREE.IcosahedronGeometry(0.55, 1);
  jitter(g, 0.2);
  g.scale(1, 0.62, 0.85);
  g.translate(0, 0.28, 0);
  return [g];
}

function reed() {
  // une touffe de roseaux : des joncs hauts et fins, quelques-uns coiffés d'un épi
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const h = 1.1 + rand() * 1.1;
    const blade = new THREE.PlaneGeometry(0.035, h, 1, 3);
    blade.translate(0, h / 2, 0);
    blade.rotateZ((rand() - 0.5) * 0.5);
    blade.rotateY(rand() * Math.PI);
    blade.translate((rand() - 0.5) * 0.45, 0, (rand() - 0.5) * 0.45);
    parts.push(blade);
    if (rand() > 0.55) {
      const ear = new THREE.CylinderGeometry(0.035, 0.02, 0.22, 5);
      ear.translate(0, h + 0.08, 0);
      parts.push(ear);
    }
  }
  return parts;
}

function oyat() {
  // oyat : la touffe qui tient la dune, des feuilles raides en éventail
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 11; i++) {
    const h = 0.5 + rand() * 0.6;
    const leaf = new THREE.PlaneGeometry(0.03, h, 1, 3);
    leaf.translate(0, h / 2, 0);
    leaf.rotateZ((rand() - 0.5) * 1.1);
    leaf.rotateY(rand() * Math.PI * 2);
    leaf.translate((rand() - 0.5) * 0.2, 0, (rand() - 0.5) * 0.2);
    parts.push(leaf);
  }
  return parts;
}

function molinie() {
  // la molinie, l'auguicha des Landes : une grosse touffe dense, aux feuilles retombantes,
  // qui marque la lande humide bien plus que les roseaux
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 16; i++) {
    const h = 0.45 + rand() * 0.45;
    const blade = new THREE.PlaneGeometry(0.05, h, 1, 4);
    const pos = blade.attributes.position as THREE.BufferAttribute;
    // la feuille s'incurve vers l'extérieur : le haut retombe
    for (let k = 0; k < pos.count; k++) {
      const t = (pos.getY(k) + h / 2) / h;
      pos.setZ(k, pos.getZ(k) + t * t * 0.28);
      pos.setY(k, pos.getY(k) - t * t * 0.1);
    }
    blade.translate(0, h / 2, 0);
    blade.rotateZ((rand() - 0.5) * 0.3);
    blade.rotateY(rand() * Math.PI * 2);
    blade.translate((rand() - 0.5) * 0.16, 0, (rand() - 0.5) * 0.16);
    parts.push(blade);
  }
  return parts;
}

function linaigrette() {
  // la linaigrette : une tige nue, un épi cotonneux blanc au bout. À contre-jour, ce sont des
  // centaines de points lumineux qui flottent au-dessus de la tourbe.
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const h = 0.55 + rand() * 0.4;
    const stem = new THREE.CylinderGeometry(0.007, 0.011, h, 3, 1);
    stem.translate(0, h / 2, 0);
    const head = new THREE.IcosahedronGeometry(0.032, 1);
    head.scale(0.8, 1.5, 0.8);
    head.translate(0, h + 0.03, 0);
    // le cylindre est indexé, l'icosaèdre non : il faut les ramener au même format
    const tuft = mergeGeometries([stem.toNonIndexed(), head.toNonIndexed()])!;
    tuft.rotateZ((rand() - 0.5) * 0.42);
    tuft.rotateY(rand() * Math.PI * 2);
    tuft.translate((rand() - 0.5) * 0.3, 0, (rand() - 0.5) * 0.3);
    parts.push(tuft);
  }
  return parts;
}

function salicorne() {
  // salicorne et obione : des coussins bas et charnus, seule chose qui pousse sur le schorre
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const r = 0.1 + rand() * 0.12;
    const b = new THREE.IcosahedronGeometry(r, 0);
    b.scale(1, 1.7, 1);
    b.translate((rand() - 0.5) * 0.5, r * 1.1, (rand() - 0.5) * 0.5);
    parts.push(b);
  }
  return parts;
}

function jitter(g: THREE.BufferGeometry, amount: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = Math.sin(x * 4.1 + y * 6.3) * Math.cos(z * 3.7 + y * 2.1);
    p.setXYZ(i, x + k * amount, y + Math.sin(x * 5.9 + z * 4.2) * amount * 0.7, z + k * amount * 0.8);
  }
}

function build(parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
  const welded = mergeVertices(merged, 1e-3);
  welded.computeVertexNormals();
  const flat = welded.toNonIndexed();
  flat.computeBoundingBox();
  const h = Math.max(flat.boundingBox!.max.y, 0.001);
  const p = flat.attributes.position as THREE.BufferAttribute;
  const rel = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) rel[i] = THREE.MathUtils.clamp(p.getY(i) / h, 0, 1);
  flat.setAttribute('aHeight', new THREE.BufferAttribute(rel, 1));
  return flat;
}

// ───────────── semis ─────────────

const RULES: Record<Kind, { count: number; near: [number, number]; forest: number; scale: [number, number]; clearing: boolean; biomes: BiomeId[] }> = {
  fern: { count: 820, near: [1.6, 30], forest: 0.5, scale: [0.7, 1.5], clearing: false, biomes: ['foret', 'marais', 'delta'] },
  bush: { count: 380, near: [2.2, 34], forest: 0.35, scale: [0.8, 1.7], clearing: true, biomes: ['foret'] },
  stump: { count: 110, near: [3.2, 26], forest: 0.45, scale: [0.7, 1.3], clearing: true, biomes: ['foret', 'marais', 'delta'] },
  log: { count: 90, near: [3, 28], forest: 0.45, scale: [0.7, 1.2], clearing: false, biomes: ['foret', 'marais', 'delta'] },
  rock: { count: 300, near: [2.2, 32], forest: 0, scale: [0.5, 1.6], clearing: true, biomes: ['foret'] },
  reed: { count: 900, near: [1.1, 24], forest: 0, scale: [0.7, 1.6], clearing: true, biomes: ['marais', 'delta'] },
  oyat: { count: 1500, near: [1.0, 42], forest: 0, scale: [0.7, 1.6], clearing: true, biomes: ['dune'] },
  salicorne: { count: 1400, near: [1.0, 34], forest: 0, scale: [0.45, 0.9], clearing: true, biomes: ['bassin'] },
  molinie: { count: 1400, near: [1.0, 40], forest: 0, scale: [0.8, 1.7], clearing: true, biomes: ['marais', 'delta'] },
  linaigrette: { count: 900, near: [1.2, 30], forest: 0, scale: [0.8, 1.2], clearing: true, biomes: ['marais'] },
};

function sow(kind: Kind): Piece[] {
  const rule = RULES[kind];
  const out: Piece[] = [];
  for (let i = 0; i < rule.count * 14 && out.length < rule.count; i++) {
    const x = (rand() - 0.5) * 150;
    const z = 40 - rand() * 280;
    const d = trailDistance(x, z);
    if (d < rule.near[0] || d > rule.near[1]) continue;
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.radius * 1.05) continue;
    if (Math.hypot(x - MARSH.x, z - MARSH.z) < MARSH.radius * 0.92) continue;
    if (crasteDistance(x, z) < CRASTE.bank + 0.6) continue;
    if (underPalombiere(x, z)) continue;
    const inClearing = Math.hypot(x - CLEARING.x, z - CLEARING.z) < CLEARING.radius;
    if (inClearing && !rule.clearing) continue;
    if (!rule.biomes.includes(biomeAt(x, z))) continue;
    // la plage reste nue : seuls les oyats tiennent le haut de la dune
    if (coastMask(x, z) > 0.35 && (kind !== 'oyat' || z < DUNE.z - 4)) continue;
    // les fougères et les buissons suivent la densité de la forêt, les rochers non
    const cover = fbm(x * 0.03, z * 0.03);
    if (rule.forest > 0 && cover < rule.forest && rand() > 0.25) continue;
    if (kind === 'rock' && biomeAt(x, z) === 'foret' && rand() > 0.3) continue;
    out.push({ x, z, y: heightAt(x, z, d), scale: rule.scale[0] + rand() * (rule.scale[1] - rule.scale[0]), rot: rand() * Math.PI * 2, tint: rand() });
  }
  return out;
}

const PALETTES: Record<Kind, [string, string]> = {
  fern: ['#20351a', '#456b25'],
  bush: ['#1b2f1a', '#3d5b24'],
  stump: ['#241a12', '#3f3124'],
  log: ['#211a14', '#3a2e22'],
  rock: ['#2f3034', '#5a5b5e'],
  reed: ['#3d4420', '#6e7038'],
  oyat: ['#4a5442', '#8d9070'],
  molinie: ['#3b3a1c', '#7a6a33'],
  salicorne: ['#2b3327', '#6b5240'],
  linaigrette: ['#33401f', '#efe9dc'],
};

const vertex = /* glsl */ `
  attribute float aHeight;
  attribute vec2 aVar;
  uniform float uTime;
  uniform float uWind;
  uniform float uSway;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vHeight;
  varying vec2 vVar;
  void main(){
    vec3 p = position;
    // les feuillages souples ondulent, la pierre et le bois mort restent immobiles
    float sway = aHeight * aHeight * uWind * uSway;
    p.x += sin(uTime * 1.6 + aVar.y * 6.28) * 0.08 * sway;
    p.z += cos(uTime * 1.2 + aVar.y * 4.1) * 0.06 * sway;
    vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(instanceMatrix) * normal);
    vHeight = aHeight;
    vVar = aVar;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const fragment = /* glsl */ `
  ${glslNoise}
  ${glslWorld}
  uniform vec3 uDark;
  uniform vec3 uLight;
  uniform float uLeafy;
  uniform float uTipped;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vHeight;
  varying vec2 vVar;
  void main(){
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 v = normalize(cameraPosition - vWorld);
    float grain = fbm(vWorld.xz * 2.2 + vVar.x * 8.0);
    // les plantes à épi gardent la tige sombre et ne portent leur blanc qu'au sommet
    float k = mix(vVar.x * 0.5 + grain * 0.5, 0.0, uTipped);
    vec3 albedo = mix(uDark, uLight, k);
    albedo = mix(albedo, uLight, uTipped * smoothstep(0.72, 0.96, vHeight));
    float shadow = sunShadow(vWorld, dot(n, uSunDir));
    float wrap = pow(max(dot(n, uSunDir) * 0.5 + 0.5, 0.0), 1.6);
    float ao = mix(0.45, 1.0, smoothstep(0.0, 0.8, vHeight));
    // les frondes et les feuilles laissent passer la lumière quand on les regarde à contre-jour
    float back = pow(max(dot(-v, uSunDir), 0.0), 4.0) * uLeafy;
    vec3 sun = uSunColor * (wrap * ao * shadow + back * 1.1 * vec3(1.0, 0.85, 0.5) * shadow);
    vec3 amb = mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient * ao;
    vec3 col = albedo * (sun + amb + lantern(vWorld, n));
    gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
  }
`;

export function createUndergrowth() {
  const group = new THREE.Group();
  const geometries: Record<Kind, THREE.BufferGeometry> = {
    fern: build(fern()),
    bush: build(bush()),
    stump: build(stump()),
    log: build(log()),
    rock: build(rock()),
    reed: build(reed()),
    oyat: build(oyat()),
    molinie: build(molinie()),
    salicorne: build(salicorne()),
    linaigrette: build(linaigrette()),
  };
  const dummy = new THREE.Object3D();
  const counts: Record<string, number> = {};
  for (const kind of Object.keys(geometries) as Kind[]) {
    const pieces = sow(kind);
    counts[kind] = pieces.length;
    const geo = geometries[kind];
    const variation = new Float32Array(pieces.length * 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...world,
        uDark: { value: new THREE.Color(PALETTES[kind][0]) },
        uLight: { value: new THREE.Color(PALETTES[kind][1]) },
        uSway: { value: kind === 'reed' ? 1.8 : kind === 'oyat' || kind === 'linaigrette' ? 1.4 : kind === 'molinie' ? 1.1 : kind === 'fern' || kind === 'bush' ? 1 : 0 },
        uTipped: { value: kind === 'linaigrette' ? 1 : 0 },
        uLeafy: { value: kind === 'fern' || kind === 'reed' ? 1 : kind === 'bush' ? 0.6 : kind === 'oyat' || kind === 'molinie' ? 0.9 : kind === 'linaigrette' ? 1.6 : 0 },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, pieces.length);
    pieces.forEach((p, i) => {
      dummy.position.set(p.x, p.y - 0.05, p.z);
      dummy.rotation.set(kind === 'log' ? 0.08 : 0, p.rot, kind === 'log' ? 0.05 : 0);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      variation[i * 2] = p.tint;
      variation[i * 2 + 1] = (p.x * 0.11 + p.z * 0.07) % 1;
    });
    geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(variation, 2));
    mesh.frustumCulled = false;
    mesh.name = kind;
    group.add(mesh);
  }
  return { group, counts };
}
