import * as THREE from 'three';
import { glslNoise, glslWorld, world } from './light';

// Le sentier et le relief. Tout est calculé côté JavaScript (mêmes hauteurs pour le sol, l'herbe,
// les arbres et la caméra), puis la géométrie du sol est déformée une fois au chargement.

// tracé du sentier : de la prairie (z = 20) jusqu'à la rive du lac (z ≈ −205)
export const TRAIL = new THREE.CatmullRomCurve3(
  [
    [0, 0, 24],
    [2, 0, 4],
    [-4, 0, -22],
    [-9, 0, -48],
    [-3, 0, -74],
    [8, 0, -98],
    [12, 0, -122],
    [4, 0, -148],
    [-4, 0, -172],
    [-2, 0, -196],
    [0, 0, -210],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  false,
  'catmullrom',
  0.5
);

export const LAKE = { x: 0, z: -250, radius: 44, level: -1.6 };
export const CLEARING = { x: 9, z: -110, radius: 22 };

// bruit de valeur déterministe (même résultat à chaque chargement)
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function vnoise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
export function fbm(x: number, y: number) {
  let a = 0.5;
  let s = 0;
  for (let i = 0; i < 4; i++) {
    s += a * vnoise(x, y);
    x *= 2.03;
    y *= 2.03;
    a *= 0.5;
  }
  return s;
}

// distance horizontale au sentier, par échantillonnage de la courbe
const samples = TRAIL.getSpacedPoints(400);
export function trailDistance(x: number, z: number) {
  let best = Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    const p = samples[i];
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

export function heightAt(x: number, z: number, dTrail = trailDistance(x, z)) {
  let h = (fbm(x * 0.018, z * 0.018) - 0.5) * 7;
  // les versants se relèvent loin du sentier, qui suit un fond de vallon
  h += THREE.MathUtils.smoothstep(dTrail, 10, 90) * 14 * fbm(x * 0.01 + 7, z * 0.01);
  // le sentier est aplani
  h *= THREE.MathUtils.smoothstep(dTrail, 1.2, 7) * 0.8 + 0.2;
  // la clairière est un replat
  const dc = Math.hypot(x - CLEARING.x, z - CLEARING.z);
  h = THREE.MathUtils.lerp(h, 0.2, 1 - THREE.MathUtils.smoothstep(dc, CLEARING.radius * 0.6, CLEARING.radius * 1.3));
  // cuvette du lac
  const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
  const basin = 1 - THREE.MathUtils.smoothstep(dl, LAKE.radius * 0.7, LAKE.radius * 1.25);
  h = THREE.MathUtils.lerp(h, LAKE.level - 1.8, basin);
  return h;
}

export function createTerrain() {
  const size = 420;
  const seg = 220;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -95);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const trail = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const d = trailDistance(x, z);
    pos.setY(i, heightAt(x, z, d));
    trail[i] = d;
  }
  geo.setAttribute('aTrail', new THREE.BufferAttribute(trail, 1));
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world, uForest: { value: null as THREE.Texture | null } },
    vertexShader: /* glsl */ `
      attribute float aTrail;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vTrail;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vTrail = aTrail;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      uniform sampler2D uForest;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vTrail;
      void main(){
        vec3 n = normalize(vNormal);
        float grain = fbm(vWorld.xz * 0.35);
        float patches = fbm(vWorld.xz * 0.05 + 3.0);
        // herbe sèche, mousse sous les arbres, terre battue sur le sentier
        vec3 meadow = mix(vec3(0.20, 0.23, 0.08), vec3(0.34, 0.32, 0.12), patches);
        vec3 moss = vec3(0.09, 0.12, 0.05);
        vec3 dirt = mix(vec3(0.30, 0.22, 0.14), vec3(0.40, 0.31, 0.20), grain);
        vec2 fuv = (vWorld.xz - uShadowBounds.xy) / uShadowBounds.zw;
        float forest = texture2D(uForest, fuv).r; // densité d'arbres, floutée : sert d'occlusion
        vec3 albedo = mix(meadow, moss, forest);
        float path = 1.0 - smoothstep(0.8, 2.3 + grain * 0.8, vTrail);
        albedo = mix(albedo, dirt, path);
        albedo *= 0.85 + grain * 0.3;

        float ndl = max(dot(n, uSunDir), 0.0);
        float shadow = sunShadow(vWorld, ndl);
        vec3 direct = uSunColor * ndl * shadow * (1.0 - forest * 0.75);
        // à l'ombre, il ne reste que la lumière du ciel, un peu plus froide
        vec3 ambient = mix(uSkyHorizon, uSkyTop, 0.5) * uAmbient * (1.0 - forest * 0.55) * (0.72 + 0.28 * shadow);
        vec3 col = albedo * (direct + ambient + lantern(vWorld, n));
        col = applyFog(col, vWorld, cameraPosition);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  return { mesh, material: mat };
}

// point du sentier et direction, pour une abscisse 0 → 1
export function trailPoint(u: number, out = new THREE.Vector3()) {
  TRAIL.getPointAt(THREE.MathUtils.clamp(u, 0, 1), out);
  out.y = heightAt(out.x, out.z, 0);
  return out;
}
