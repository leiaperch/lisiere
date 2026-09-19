import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CLEARING, LAKE, fbm, heightAt, trailDistance } from './terrain';
import { glslNoise, glslWorld, world } from './light';

// La forêt : quelques milliers d'arbres en deux familles, placés une fois selon des règles
// (lisière, sous-bois, clairière, rive), dessinés en deux appels de rendu.

export interface Tree {
  x: number;
  y: number;
  z: number;
  scale: number;
  kind: 0 | 1; // 0 conifère, 1 feuillu
  hue: number;
}

// graine déterministe : la forêt est la même à chaque visite
let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

export function plantForest(): Tree[] {
  const trees: Tree[] = [];
  const tries = 16000;
  for (let i = 0; i < tries && trees.length < 2600; i++) {
    const x = (rand() - 0.5) * 320;
    const z = 60 - rand() * 320;
    const dTrail = trailDistance(x, z);
    if (dTrail < 3.6 + rand() * 2) continue;
    // lisière : la prairie du départ reste ouverte, quelques arbres isolés seulement
    const meadow = THREE.MathUtils.smoothstep(z, -26, 2);
    const dc = Math.hypot(x - CLEARING.x, z - CLEARING.z);
    const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
    if (dc < CLEARING.radius * (0.9 + rand() * 0.3)) continue;
    if (dl < LAKE.radius * 1.12) continue;
    const density = fbm(x * 0.03, z * 0.03) * 1.5 - meadow * 1.4 - (dTrail < 9 ? 0.15 : 0);
    if (rand() > density) continue;
    const kind: 0 | 1 = fbm(x * 0.02 + 40, z * 0.02) > 0.52 ? 1 : 0;
    trees.push({ x, y: heightAt(x, z, dTrail), z, scale: 0.75 + rand() * 0.7, kind, hue: rand() });
  }
  return trees;
}

// ───────────── géométries ─────────────

function conifer() {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.16, 0.3, 3.2, 7, 1, true);
  trunk.translate(0, 1.6, 0);
  tag(trunk, 0);
  parts.push(trunk);
  const layers = 5;
  for (let i = 0; i < layers; i++) {
    const r = 2.6 - i * 0.42;
    const h = 3.1 - i * 0.28;
    const cone = new THREE.ConeGeometry(r, h, 14, 4, true);
    cone.translate(0, 2.2 + i * 1.55 + h / 2, 0);
    jitter(cone, 0.22);
    tag(cone, 1);
    parts.push(cone);
  }
  return finish(mergeGeometries(parts)!);
}

function broadleaf() {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.2, 0.36, 4.2, 7, 1, true);
  trunk.translate(0, 2.1, 0);
  tag(trunk, 0);
  parts.push(trunk);
  const blobs: [number, number, number, number][] = [
    [0, 5.6, 0, 2.5],
    [1.4, 4.9, 0.6, 1.8],
    [-1.3, 5.1, -0.4, 1.9],
    [0.3, 6.9, -0.7, 1.7],
    [-0.4, 4.6, 1.3, 1.6],
  ];
  for (const [x, y, z, r] of blobs) {
    const b = new THREE.IcosahedronGeometry(r, 2);
    jitter(b, r * 0.18);
    b.translate(x, y, z);
    tag(b, 1);
    parts.push(b);
  }
  return finish(mergeGeometries(parts)!);
}

// normales lissées sur la géométrie soudée (feuillage doux, sans facettes), puis mise à plat pour la fusion
function tag(g: THREE.BufferGeometry, part: number) {
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const welded = mergeVertices(g, 1e-3);
  welded.computeVertexNormals();
  const flat = welded.toNonIndexed();
  const n = flat.attributes.position.count;
  flat.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
  g.copy(flat);
}

function jitter(g: THREE.BufferGeometry, amount: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = Math.sin(x * 3.1 + y * 5.7) * Math.cos(z * 4.3 + y * 1.9);
    p.setXYZ(i, x + k * amount, y + Math.sin(x * 7.1 + z * 3.3) * amount * 0.6, z + k * amount * 0.8);
  }
}

function finish(g: THREE.BufferGeometry) {
  g.computeBoundingBox();
  const h = g.boundingBox!.max.y;
  const p = g.attributes.position as THREE.BufferAttribute;
  const rel = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) rel[i] = p.getY(i) / h;
  g.setAttribute('aHeight', new THREE.BufferAttribute(rel, 1));
  return g;
}

// ───────────── matériau ─────────────

const vertex = /* glsl */ `
  attribute float aPart;
  attribute float aHeight;
  attribute vec2 aVar; // x : teinte, y : phase du vent
  uniform float uTime;
  uniform float uWind;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vPart;
  varying float vHeight;
  varying vec2 vVar;
  varying vec3 vLocal;
  void main(){
    vec3 p = position;
    // le houppier ondule au vent, le tronc reste planté
    float sway = aHeight * aHeight * uWind;
    p.x += sin(uTime * 0.9 + aVar.y * 6.28) * 0.18 * sway;
    p.z += cos(uTime * 0.7 + aVar.y * 4.1) * 0.12 * sway;
    vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    vPart = aPart;
    vHeight = aHeight;
    vVar = aVar;
    vLocal = position;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const fragment = /* glsl */ `
  ${glslNoise}
  ${glslWorld}
  uniform vec3 uLeaf;
  uniform vec3 uLeafWarm;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vPart;
  varying float vHeight;
  varying vec2 vVar;
  varying vec3 vLocal;
  void main(){
    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorld);
    if (!gl_FrontFacing) n = -n;
    vec3 L = uSunDir;

    vec3 albedo;
    if (vPart < 0.5) {
      float bark = fbm(vec2(atan(vLocal.x, vLocal.z) * 3.0, vLocal.y * 5.0));
      albedo = mix(vec3(0.12, 0.08, 0.06), vec3(0.24, 0.17, 0.11), bark);
    } else {
      float clump = fbm(vLocal.xz * 1.3 + vLocal.y * 0.8 + vVar.x * 10.0);
      albedo = mix(uLeaf, uLeafWarm, vVar.x * 0.6 + clump * 0.4);
      albedo *= 0.75 + clump * 0.5;
    }

    // éclairage enveloppant : le feuillage n'a jamais de face complètement noire
    float wrap = pow(max(dot(n, L) * 0.5 + 0.5, 0.0), 2.0);
    // occlusion : bas et intérieur du houppier plus sombres
    float ao = mix(0.35, 1.0, smoothstep(0.1, 0.9, vHeight));
    // contre-jour : la lumière traverse les aiguilles et les feuilles vues face au soleil
    float back = pow(max(dot(-v, L), 0.0), 5.0) * vPart;
    float edge = pow(1.0 - max(dot(n, v), 0.0), 2.0);
    vec3 sun = uSunColor * (wrap * ao + back * (0.6 + edge * 1.6) * vec3(1.0, 0.85, 0.45) * 0.9);
    vec3 amb = mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient * ao;
    vec3 rim = uSkyHorizon * edge * 0.25 * vPart;
    vec3 col = albedo * (sun + amb + lantern(vWorld, n)) + rim * albedo * 2.0;
    col = applyFog(col, vWorld, cameraPosition);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createForest(trees: Tree[]) {
  const group = new THREE.Group();
  const kinds = [conifer(), broadleaf()];
  const palettes: [string, string][] = [
    ['#10241a', '#2a4424'],
    ['#223a16', '#57601f'],
  ];
  const dummy = new THREE.Object3D();
  kinds.forEach((geo, kind) => {
    const list = trees.filter((t) => t.kind === kind);
    const variation = new Float32Array(list.length * 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...world, uLeaf: { value: new THREE.Color(palettes[kind][0]) }, uLeafWarm: { value: new THREE.Color(palettes[kind][1]) } },
      vertexShader: vertex,
      fragmentShader: fragment,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((t, i) => {
      dummy.position.set(t.x, t.y - 0.15, t.z);
      dummy.rotation.set(0, t.hue * Math.PI * 2, 0);
      dummy.scale.setScalar(t.scale * (kind === 0 ? 1.15 : 1));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      variation[i * 2] = t.hue;
      variation[i * 2 + 1] = (t.x * 0.13 + t.z * 0.07) % 1;
    });
    geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(variation, 2));
    mesh.frustumCulled = false;
    group.add(mesh);
  });
  return group;
}

// ───────────── ombres longues et densité, peintes une fois ─────────────

export function paintGround(trees: Tree[], sunDir: THREE.Vector3) {
  const [bx, bz, bw, bd] = world.uShadowBounds.value.toArray();
  const size = 1024;
  const toPx = (x: number, z: number) => [((x - bx) / bw) * size, ((z - bz) / bd) * size] as const;

  // ombres : chaque arbre projette une traînée à l'opposé du soleil
  const shadow = document.createElement('canvas');
  shadow.width = shadow.height = size;
  const g = shadow.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  const dir = new THREE.Vector2(-sunDir.x, -sunDir.z).normalize();
  const elev = Math.max(Math.asin(sunDir.y), 0.05);
  g.filter = 'blur(3px)';
  for (const t of trees) {
    const height = (t.kind === 0 ? 11 : 8) * t.scale;
    const length = Math.min(height / Math.tan(elev), 46);
    const [px, pz] = toPx(t.x, t.z);
    const [qx, qz] = toPx(t.x + dir.x * length, t.z + dir.y * length);
    const grad = g.createLinearGradient(px, pz, qx, qz);
    grad.addColorStop(0, 'rgba(40,40,60,0.55)');
    grad.addColorStop(1, 'rgba(40,40,60,0)');
    g.strokeStyle = grad;
    g.lineWidth = ((t.kind === 0 ? 3.2 : 4.4) * t.scale * size) / bw;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(px, pz);
    g.lineTo(qx, qz);
    g.stroke();
  }

  // densité : sert d'occlusion au sol et de teinte de sous-bois
  const forest = document.createElement('canvas');
  forest.width = forest.height = 512;
  const f = forest.getContext('2d')!;
  f.fillStyle = '#000';
  f.fillRect(0, 0, 512, 512);
  f.filter = 'blur(6px)';
  f.fillStyle = 'rgba(255,255,255,0.35)';
  for (const t of trees) {
    const x = ((t.x - bx) / bw) * 512;
    const z = ((t.z - bz) / bd) * 512;
    f.beginPath();
    f.arc(x, z, (3 * t.scale * 512) / bw, 0, Math.PI * 2);
    f.fill();
  }

  const make = (c: HTMLCanvasElement) => {
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false;
    return tex;
  };
  return { shadow: make(shadow), forest: make(forest) };
}
