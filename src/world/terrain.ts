import * as THREE from 'three';
import { glslNoise, glslWorld, world } from './light';
import { BIOMES, SEGMENTS, biomeWeights, buildFields, trailDistance } from './paths';
import { CRASTE, crasteDistance, crasteProfile, deckHeight } from './craste';
import { BASSIN, ESTEY_REACH, esteyDistance, esteyProfile } from './bassin';
import { DELTA, DELTA_REACH, deltaDistance, deltaProfile } from './delta';
import { AIRIAL } from './endings';

export { BASSIN };

export { trailDistance };
export type { BiomeId } from './paths';

// Le relief. Tout est calculé côté JavaScript (mêmes hauteurs pour le sol, l'herbe, les arbres et
// la caméra), puis la géométrie du sol est déformée une fois au chargement.
//
// La clairière est sur le tronc commun, avant la fourche. Ensuite, chaque branche a son accident :
// la dune puis la plage côté océan, la tourbière et l'étang côté marais.

/** l'étang, au bout du marais : c'est là que l'on fait des ricochets */
export const LAKE = { x: 80, z: -202, radius: 27, level: -3.0 };
/** la tourbière, juste avant l'étang */
export const MARSH = { x: 54, z: -136, radius: 14, level: -2.2 };
/** la dune : une crête de sable qui barre l'horizon, puis la plage derrière */
export const DUNE = { z: -200, height: 12.5, spread: 13 };
export const SEA = { level: -2.4, shore: -230 };
export const CLEARING = { x: -17, z: -58, radius: 19 };

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

const weights: number[] = [];

export function heightAt(x: number, z: number, dTrail = trailDistance(x, z)) {
  biomeWeights(x, z, weights);
  const [vigne, foret, dune, bassin, marais, delta] = weights;
  // chaque terre a son grain : graves roulantes, sable modelé par le vent, tourbe plate
  const rough = vigne * 0.7 + foret * 1 + dune * 0.8 + bassin * 0.2 + marais * 0.45 + delta * 0.3;
  const drop = marais * 2.2 + delta * 2.6;

  let h = (fbm(x * 0.018, z * 0.018) - 0.5) * 7 * rough;
  // les versants se relèvent loin du sentier, qui suit un fond de vallon
  h += THREE.MathUtils.smoothstep(dTrail, 10, 90) * 14 * rough * fbm(x * 0.01 + 7, z * 0.01);
  // le sentier est aplani
  h *= THREE.MathUtils.smoothstep(dTrail, 1.2, 7) * 0.8 + 0.2;
  h -= drop;
  // les graves montent doucement au-dessus de la lisière : le vignoble domine la forêt
  h += vigne * (3.5 + THREE.MathUtils.smoothstep(z, 20, 140) * 9);

  // l'airial est un replat herbeux, comme la clairière : on y bâtissait justement parce que c'est plat
  const da = Math.hypot(x - AIRIAL.x, z - AIRIAL.z);
  h = THREE.MathUtils.lerp(h, -2.6, 1 - THREE.MathUtils.smoothstep(da, AIRIAL.radius * 0.55, AIRIAL.radius * 1.35));

  // la clairière est un replat
  const dc = Math.hypot(x - CLEARING.x, z - CLEARING.z);
  h = THREE.MathUtils.lerp(h, 0.2, 1 - THREE.MathUtils.smoothstep(dc, CLEARING.radius * 0.6, CLEARING.radius * 1.3));

  // côté océan : la dune se lève, puis la plage descend jusqu'à l'eau
  const seaward = coastMask(x, z);
  if (seaward > 0.001) {
    const crest = DUNE.height * Math.exp(-((z - DUNE.z) ** 2) / (2 * DUNE.spread ** 2));
    const sand = (fbm(x * 0.06, z * 0.06) - 0.5) * 2.6 * THREE.MathUtils.smoothstep(z, SEA.shore + 8, DUNE.z + 10);
    const beach = THREE.MathUtils.lerp(SEA.level - 1.7, 0.4, THREE.MathUtils.smoothstep(z, SEA.shore - 12, DUNE.z - 6));
    // le sentier gravit la dune au lieu de la raboter : seul le petit modelé de sable s'aplanit
    const flat = THREE.MathUtils.smoothstep(dTrail, 1.2, 9) * 0.75 + 0.25;
    h = THREE.MathUtils.lerp(h, beach + crest + sand * flat, seaward);
  }

  // côté bassin : le schorre, presque plat, à peine au-dessus de l'eau, puis la vasière
  // le trait de côte est brouillé : une lagune n'a pas un rivage en arc de cercle
  const db = Math.hypot(x - BASSIN.x, z - BASSIN.z) + (fbm(x * 0.022 + 5, z * 0.022) - 0.5) * 30;
  const tide = 1 - THREE.MathUtils.smoothstep(db, BASSIN.radius * 0.72, BASSIN.radius * 1.45);
  if (tide > 0.001) {
    const schorre = BASSIN.level + 0.5 + (fbm(x * 0.05 + 12, z * 0.05) - 0.5) * 0.5;
    const slikke = BASSIN.level - 1.6;
    // près du large la vasière plonge sous l'eau, en bordure le schorre reste au sec
    const wet = 1 - THREE.MathUtils.smoothstep(db, BASSIN.radius * 0.8, BASSIN.radius * 1.15);
    h = THREE.MathUtils.lerp(h, THREE.MathUtils.lerp(schorre, slikke, wet), tide);
  }

  // Le delta est une plaine d'inondation : le sol s'y aplanit juste au-dessus de l'eau. Sans ce
  // calage, le bruit du terrain descendait deux mètres sous la rivière, qui semblait perchée.
  if (delta > 0.01) {
    const flood = DELTA.level + 0.85 + (fbm(x * 0.07 + 21, z * 0.07) - 0.5) * 0.9;
    h = THREE.MathUtils.lerp(h, flood, Math.min(delta * 1.15, 1));
  }

  // La passe : entre la plage et le schorre, il restait une table de terre plate juste au-dessus
  // de l'eau, qui se lisait comme une dalle posée sur la lagune. C'est justement là que l'océan
  // communique avec le bassin — on ouvre donc le chenal, et l'eau la recouvre.
  const pass =
    (1 - THREE.MathUtils.smoothstep(Math.abs(x - 32), 12, 36)) *
    (1 - THREE.MathUtils.smoothstep(Math.abs(z + 268), 14, 40));
  if (pass > 0.001) h = THREE.MathUtils.lerp(h, SEA.level - 1.8, pass);

  // les bras du delta : mêmes lits dessinés à part, le terrain leur fait de la place
  const dd = deltaDistance(x, z);
  if (dd < DELTA_REACH) {
    const off = 0.5 * (1 - THREE.MathUtils.smoothstep(dd, DELTA_REACH * 0.7, DELTA_REACH));
    h = Math.min(h, deltaProfile(dd, h) - off);
  }

  // l'estey : même principe que la craste, le lit est dessiné à part
  const de = esteyDistance(x, z);
  if (de < ESTEY_REACH) {
    const off = 0.45 * (1 - THREE.MathUtils.smoothstep(de, ESTEY_REACH * 0.7, ESTEY_REACH));
    h = Math.min(h, esteyProfile(de, h) - off);
  }

  // la craste : le terrain se contente de descendre sous les berges, dessinées à part
  const dcr = crasteDistance(x, z);
  if (dcr < CRASTE.bank) {
    // l'écart se referme au bord, sinon le terrain tombe d'une marche au ras de la berge
    const off = 0.5 * (1 - THREE.MathUtils.smoothstep(dcr, CRASTE.bank * 0.7, CRASTE.bank));
    h = Math.min(h, crasteProfile(dcr, h) - off);
  }

  // cuvette de la tourbière : on marche presque au ras de l'eau
  const dm = Math.hypot(x - MARSH.x, z - MARSH.z);
  const bog = 1 - THREE.MathUtils.smoothstep(dm, MARSH.radius * 0.55, MARSH.radius * 1.35);
  h = THREE.MathUtils.lerp(h, MARSH.level - 0.6, bog);

  // cuvette de l'étang
  const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
  const basin = 1 - THREE.MathUtils.smoothstep(dl, LAKE.radius * 0.7, LAKE.radius * 1.3);
  h = THREE.MathUtils.lerp(h, LAKE.level - 1.8, basin);
  return h;
}

/** hauteur sur laquelle on marche : le sol, ou le platelage quand on franchit la craste */
export function surfaceAt(x: number, z: number) {
  return deckHeight(x, z) ?? heightAt(x, z, 0);
}

/**
 * Où l'océan prend la main : une bande au nord de la carte, qui s'arrête bien avant le marais.
 * C'est ce masque, et non le biome, qui dessine la plage : une plage est large, un sentier non.
 */
export function coastMask(x: number, z: number) {
  return (1 - THREE.MathUtils.smoothstep(z, DUNE.z + 26, DUNE.z + 62)) * (1 - THREE.MathUtils.smoothstep(x, 6, 46));
}

export function createTerrain() {
  buildFields();
  const size = 560;
  const seg = 280;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -85);
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
    uniforms: {
      ...world,
      uForest: { value: null as THREE.Texture | null },
      uBiome: { value: null as THREE.Texture | null },
      uBiome2: { value: null as THREE.Texture | null },
      // fourche : x, z du repère, direction survolée et intensité du surlignage
      uChoice: { value: new THREE.Vector4(0, 0, 0, 0) },
      uChoiceDir: { value: new THREE.Vector2(0, -1) },
    },
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
      uniform sampler2D uBiome;
      uniform sampler2D uBiome2;
      uniform vec4 uChoice;
      uniform vec2 uChoiceDir;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vTrail;
      void main(){
        vec3 n = normalize(vNormal);
        float grain = fbm(vWorld.xz * 0.35);
        float patches = fbm(vWorld.xz * 0.05 + 3.0);
        vec2 fuv = (vWorld.xz - uShadowBounds.xy) / uShadowBounds.zw;
        float forest = texture2D(uForest, fuv).r; // densité d'arbres, floutée : sert d'occlusion
        vec4 b1 = texture2D(uBiome, fuv);   // r vigne, g forêt, b dune, a bande côtière
        vec4 b2 = texture2D(uBiome2, fuv);  // r bassin, g marais, b delta

        // herbe sèche et mousse sous les arbres, tourbe au marais, graves dans la vigne
        vec3 meadow = mix(vec3(0.20, 0.23, 0.08), vec3(0.34, 0.32, 0.12), patches);
        vec3 moss = vec3(0.09, 0.12, 0.05);
        vec3 wood = mix(meadow, moss, forest);
        vec3 peat = mix(vec3(0.13, 0.13, 0.09), vec3(0.20, 0.25, 0.12), patches * 0.7 + grain * 0.3);
        // les graves : un sol de graviers clairs, presque nu entre les rangs
        vec3 graves = mix(vec3(0.30, 0.26, 0.21), vec3(0.47, 0.42, 0.34), grain);
        graves = mix(graves, vec3(0.22, 0.24, 0.13), smoothstep(0.45, 0.8, patches) * 0.5);
        // le schorre : vase grise et salicorne rase
        vec3 schorre = mix(vec3(0.17, 0.17, 0.14), vec3(0.26, 0.27, 0.19), patches);
        schorre = mix(schorre, vec3(0.12, 0.11, 0.10), smoothstep(0.3, 0.8, grain) * 0.6);

        vec3 albedo = wood * b1.g + peat * (b2.g + b2.b) + graves * b1.r + schorre * b2.r;

        // le sable : clair et ridé sur la dune, foncé et lisse là où la mer vient le mouiller
        float wet = 1.0 - smoothstep(${SEA.shore.toFixed(1)} - 4.0, ${SEA.shore.toFixed(1)} + 10.0, vWorld.z);
        float ridges = fbm(vec2(vWorld.x * 0.8, vWorld.z * 0.12));
        vec3 sand = mix(vec3(0.62, 0.56, 0.45), vec3(0.78, 0.71, 0.57), ridges);
        sand = mix(sand, vec3(0.26, 0.25, 0.23), wet);
        albedo = mix(albedo, sand, max(b1.a, b1.b * 0.6));

        vec3 dirt = mix(vec3(0.30, 0.22, 0.14), vec3(0.40, 0.31, 0.20), grain);
        float path = 1.0 - smoothstep(0.8, 2.3 + grain * 0.8, vTrail);
        albedo = mix(albedo, dirt, path);
        albedo *= 0.85 + grain * 0.3;

        // au moment du choix, le sentier survolé s'éclaire sur ses premiers mètres
        vec2 rel = vWorld.xz - uChoice.xy;
        float along = dot(rel, normalize(uChoiceDir));
        float side = length(rel - normalize(uChoiceDir) * along);
        float lit = uChoice.w * smoothstep(0.0, 6.0, along) * (1.0 - smoothstep(14.0, 34.0, along)) * (1.0 - smoothstep(1.5, 5.0, side));
        albedo += uSkyHorizon * lit * 0.35;

        float ndl = max(dot(n, uSunDir), 0.0);
        float shadow = sunShadow(vWorld, ndl);
        // le couvert n'assombrit que sous les arbres : la plage reste ouverte
        float cover = forest * b1.g * (1.0 - b1.a);
        vec3 direct = uSunColor * ndl * shadow * (1.0 - cover * 0.75);
        // à l'ombre, il ne reste que la lumière du ciel, un peu plus froide
        vec3 ambient = mix(uSkyHorizon, uSkyTop, 0.5) * uAmbient * (1.0 - cover * 0.55) * (0.72 + 0.28 * shadow);
        vec3 col = albedo * (direct + ambient + lantern(vWorld, n));
        col = applyFog(col, vWorld, cameraPosition);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  return { mesh, material: mat };
}

// ───────────── carte des biomes, peinte une fois ─────────────

export function paintBiomes() {
  const [bx, bz, bw, bd] = world.uShadowBounds.value.toArray();
  const size = 256;
  const a = new Uint8Array(size * size * 4);
  const b = new Uint8Array(size * size * 4);
  const w: number[] = [];
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const x = bx + ((ix + 0.5) / size) * bw;
      const z = bz + ((iy + 0.5) / size) * bd;
      biomeWeights(x, z, w);
      const i = (iy * size + ix) * 4;
      // BIOMES : vigne, foret, dune, bassin, marais, delta
      a[i] = Math.round(w[0] * 255);
      a[i + 1] = Math.round(w[1] * 255);
      a[i + 2] = Math.round(w[2] * 255);
      a[i + 3] = Math.round(coastMask(x, z) * 255);
      b[i] = Math.round(w[3] * 255);
      b[i + 1] = Math.round(w[4] * 255);
      b[i + 2] = Math.round(w[5] * 255);
      b[i + 3] = 255;
    }
  }
  const make = (data: Uint8Array) => {
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  };
  return { biome: make(a), biome2: make(b) };
}

void BIOMES;

// ───────────── repères sur le parcours ─────────────

/** point du sentier, pour une abscisse 0 → 1 dans un segment donné, posé sur le sol */
export function pathPoint(id: string, local: number, out = new THREE.Vector3()) {
  SEGMENTS[id].curve.getPointAt(THREE.MathUtils.clamp(local, 0, 1), out);
  out.y = heightAt(out.x, out.z, 0);
  return out;
}

/** profil altimétrique d'un itinéraire, pour le chargement et la vignette de la page */
export function routeProfile(route: string[], samples: number) {
  const p = new THREE.Vector3();
  const per = 1 / (samples - 1);
  return Array.from({ length: samples }, (_, i) => {
    const u = i * per * route.length;
    const seg = Math.min(Math.floor(u), route.length - 1);
    pathPoint(route[seg], u - seg, p);
    return p.y;
  });
}
