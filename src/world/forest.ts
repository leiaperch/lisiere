import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CLEARING, DUNE, LAKE, MARSH, coastMask, fbm, heightAt } from './terrain';
import { AIRIAL } from './endings';
import { biomeAt, trailDistance } from './paths';
import { CRASTE, crasteDistance } from './craste';
import { PALOMBIERE, blocksPalombiere, underPalombiere } from './palombiere';
import { glslNoise, glslWorld, world } from './light';

// La forêt : quelques milliers d'arbres en deux familles, placés une fois selon des règles
// (lisière, sous-bois, clairière, rive), dessinés en deux appels de rendu.

export interface Tree {
  x: number;
  y: number;
  z: number;
  scale: number;
  kind: 0 | 1 | 2 | 3; // 0 conifère, 1 feuillu, 2 tronc mort, 3 pin maritime
  hue: number;
  /** arbre gemmé : il porte une care et un pot de résine à son pied */
  gem: number;
}

// graine déterministe : la forêt est la même à chaque visite
let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

export function plantForest(): Tree[] {
  const trees: Tree[] = [];
  const tries = 30000;
  for (let i = 0; i < tries && trees.length < 3200; i++) {
    const x = (rand() - 0.5) * 380;
    const z = 60 - rand() * 360;
    const dTrail = trailDistance(x, z);
    if (dTrail < 3.6 + rand() * 2) continue;
    const dc = Math.hypot(x - CLEARING.x, z - CLEARING.z);
    const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
    const dm = Math.hypot(x - MARSH.x, z - MARSH.z);
    if (dc < CLEARING.radius * (0.9 + rand() * 0.3)) continue;
    if (Math.hypot(x - AIRIAL.x, z - AIRIAL.z) < AIRIAL.radius * (0.95 + rand() * 0.35)) continue;
    if (dl < LAKE.radius * 1.1) continue;
    if (dm < MARSH.radius * 1.1) continue;
    if (crasteDistance(x, z) < CRASTE.bank + 2) continue;
    if (underPalombiere(x, z) || blocksPalombiere(x, z)) continue;

    const biome = biomeAt(x, z);
    // ni dans les rangs de vigne, ni sur le schorre : ces terres-là n'ont pas d'arbres
    if (biome === 'vigne' || biome === 'bassin') continue;
    const shore = coastMask(x, z);
    // rien ne pousse sur le sable nu : la forêt s'arrête au pied de la dune
    if (shore > 0.45 && z < DUNE.z + 34) continue;

    const noise = fbm(x * 0.03, z * 0.03);
    let density: number;
    let kind: 0 | 1 | 2 | 3;
    let small = 1;
    if (biome === 'marais' || biome === 'delta') {
      // le marais n'a plus que des arbres clairsemés, et beaucoup de troncs morts debout
      density = noise * 0.55;
      kind = noise > 0.58 ? 1 : 2;
      small = 0.85;
    } else if (biome === 'dune') {
      // la lisière landaise : des pins, de plus en plus rares et rabougris près du sable
      density = noise * 1.35 * (1 - shore * 0.9);
      kind = noise > 0.28 ? 3 : 0;
      small = 0.7 + (1 - shore) * 0.45;
    } else {
      // la prairie du départ reste ouverte, quelques arbres isolés seulement
      const meadow = THREE.MathUtils.smoothstep(z, -26, 2);
      density = noise * 1.5 - meadow * 1.4 - (dTrail < 9 ? 0.15 : 0);
      kind = fbm(x * 0.02 + 40, z * 0.02) > 0.52 ? 1 : 0;
    }
    if (rand() > density) continue;
    // Le gemmage : on entaillait les pins le long des pistes pour en faire couler la résine.
    // Seuls les pins et les conifères en portent, et seulement à portée du sentier — un gemmeur
    // ne va pas saigner un arbre qu'il ne peut pas venir vider.
    const gem = (kind === 0 || kind === 3) && biome !== 'marais' && dTrail < 34 && rand() < 0.62 ? 1 : 0;
    trees.push({ x, y: heightAt(x, z, dTrail), z, scale: (0.75 + rand() * 0.7) * small, kind, hue: rand(), gem });
  }
  plantGrove(trees);
  return trees;
}

/**
 * Le bosquet de la palombière.
 *
 * Une palombière se bâtit dans un bouquet de pins assez haut pour la cacher. Ici, la lande a
 * repris la main et les arbres sont clairsemés : on plante donc la vingtaine de pins qui portent
 * la cabane, en couronne autour d'elle, sans quoi elle se dresserait seule au milieu du vide.
 */
function plantGrove(trees: Tree[]) {
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + rand() * 0.24;
    const r = 7.8 + rand() * 9;
    const x = PALOMBIERE.x + Math.cos(a) * r;
    const z = PALOMBIERE.z + Math.sin(a) * r;
    const dTrail = trailDistance(x, z);
    if (dTrail < 4.5 || crasteDistance(x, z) < CRASTE.bank + 2) continue;
    if (blocksPalombiere(x, z)) continue;
    trees.push({ x, y: heightAt(x, z, dTrail), z, scale: 0.95 + rand() * 0.45, kind: 3, hue: rand(), gem: rand() < 0.5 ? 1 : 0 });
  }
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

function pine() {
  // pin maritime : long fût nu, houppier haut et étalé. C'est ce qui laisse passer la lumière
  // rasante entre les troncs, et qui fait la silhouette d'une pinède landaise.
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.22, 0.42, 11, 7, 3, true);
  jitter(trunk, 0.12);
  trunk.translate(0, 5.5, 0);
  tag(trunk, 0);
  parts.push(trunk);
  const blobs: [number, number, number, number][] = [
    [0, 11.4, 0, 2.3],
    [1.9, 10.6, 0.5, 1.7],
    [-1.7, 10.9, -0.6, 1.6],
    [0.4, 12.6, -1.2, 1.5],
    [-0.6, 10.2, 1.7, 1.4],
  ];
  for (const [x, y, z, r] of blobs) {
    const b = new THREE.IcosahedronGeometry(r, 2);
    jitter(b, r * 0.3);
    b.scale(1, 0.55, 1); // couronne aplatie par le vent
    b.translate(x, y, z);
    tag(b, 1);
    parts.push(b);
  }
  const g = mergeGeometries(parts)!;
  g.rotateZ(0.05);
  return finish(g);
}

function snag() {
  // un tronc mort debout : fût ébréché, deux moignons de branches, pas de feuillage
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.1, 0.34, 7.4, 6, 3, true);
  jitter(trunk, 0.12);
  trunk.translate(0, 3.6, 0);
  tag(trunk, 0);
  parts.push(trunk);
  for (const [y, a, len] of [
    [4.6, 0.7, 1.9],
    [3.1, 3.9, 1.4],
  ] as [number, number, number][]) {
    const b = new THREE.CylinderGeometry(0.04, 0.12, len, 5, 1, true);
    b.rotateZ(1.15);
    b.rotateY(a);
    b.translate(Math.cos(a) * 0.4, y, Math.sin(a) * 0.4);
    tag(b, 0);
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
  attribute vec2 aGem; // x : arbre gemmé, y : orientation de la care
  uniform float uTime;
  uniform float uWind;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vPart;
  varying float vHeight;
  varying vec2 vVar;
  varying vec3 vLocal;
  varying vec2 vGem;
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
    vGem = aGem;
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
  varying vec2 vGem;
  void main(){
    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorld);
    if (!gl_FrontFacing) n = -n;
    vec3 L = uSunDir;

    vec3 albedo;
    float care = 0.0; // part de care sur ce pixel, réutilisée plus bas pour l'éclairer
    if (vPart < 0.5) {
      float angle = atan(vLocal.x, vLocal.z);
      float bark = fbm(vec2(angle * 3.0, vLocal.y * 5.0));
      albedo = mix(vec3(0.12, 0.08, 0.06), vec3(0.24, 0.17, 0.11), bark);
      // La care : une bande d'écorce enlevée, montant du pied vers la cime, entaillée de
      // chevrons obliques. C'est le bois nu qui apparaît, bien plus clair que l'écorce.
      // Bornée en largeur et en hauteur séparément, la care dessinait un rectangle : deux bords
      // verticaux, deux bords horizontaux, des angles droits. On la mesure donc d'un seul tenant,
      // comme la distance au centre d'une ellipse — la balafre s'affine vers le haut et vers le
      // bas, comme une care vraie, et n'a plus de coin. Sa hauteur suit celle de l'arbre plutôt
      // qu'une cote fixe, sans quoi elle déborde du fût sur les petits sujets.
      float face = cos(angle - vGem.y * 6.28);
      float along = (vHeight - 0.02) / 0.24; // du pied jusqu'à hauteur d'homme
      // la care est étroite — un cinquième du tour, pas la moitié — et se rétrécit en montant,
      // comme une balafre ouverte au hapchot année après année
      float across = (1.0 - face) / (0.046 * (1.0 - along * 0.45));
      float d = length(vec2(across, (along - 0.5) * 2.2));
      float band = (1.0 - smoothstep(0.72, 1.0, d)) * vGem.x;
      vec3 wood = mix(vec3(0.34, 0.26, 0.16), vec3(0.52, 0.41, 0.27), bark);
      // les coups de hapchot laissent des traits en travers, tous les quelques centimètres
      // les entailles sont espacées d'une main, pas d'un centimètre : à 26 par mètre, la care
      // se lisait comme une fermeture éclair
      float cuts = smoothstep(0.55, 0.98, abs(sin(vLocal.y * 8.5 + angle * 1.2)));
      albedo = mix(albedo, mix(wood, wood * 0.72, cuts), band);
      care = band;
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
    float shadow = sunShadow(vWorld, dot(n, L));
    vec3 sun = uSunColor * (wrap * ao * mix(0.45, 1.0, shadow) + back * (0.6 + edge * 1.6) * vec3(1.0, 0.85, 0.45) * 0.9 * shadow);
    vec3 amb = mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient * ao;
    vec3 rim = uSkyHorizon * edge * 0.25 * vPart;
    vec3 col = albedo * (sun + amb + lantern(vWorld, n)) + rim * albedo * 2.0;
    // le bois vif est lisse et pâle : il accroche la lumière du ciel que l'écorce absorbe, et
    // c'est ce qui le fait ressortir même quand le tronc est à contre-jour
    col += mix(uSkyHorizon, uSkyTop, 0.5) * uAmbient * care * 0.35 * albedo;
    col = applyFog(col, vWorld, cameraPosition);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createForest(trees: Tree[]) {
  const group = new THREE.Group();
  const kinds = [conifer(), broadleaf(), snag(), pine()];
  const palettes: [string, string][] = [
    ['#10241a', '#2a4424'],
    ['#223a16', '#57601f'],
    ['#2a2419', '#3a3327'],
    ['#1b3018', '#3f5520'],
  ];
  const dummy = new THREE.Object3D();
  kinds.forEach((geo, kind) => {
    const list = trees.filter((t) => t.kind === kind);
    const variation = new Float32Array(list.length * 2);
    const gemmage = new Float32Array(list.length * 2); // x : gemmé ou non, y : orientation de la care
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
      gemmage[i * 2] = t.gem;
      // La care regarde le chemin : le gemmeur travaille depuis la piste, il n'entaille pas la
      // face cachée. L'angle est donné dans le repère de l'arbre, or chaque arbre est tourné au
      // hasard autour de son axe — il faut donc retrancher cette rotation, sinon la care part
      // dans n'importe quelle direction.
      const spread = ((t.x * 0.37 + t.z * 0.21) % 1) * 0.16 - 0.08;
      gemmage[i * 2 + 1] = spread + t.hue;
    });
    geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(variation, 2));
    geo.setAttribute('aGem', new THREE.InstancedBufferAttribute(gemmage, 2));
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
    const height = (t.kind === 0 ? 11 : t.kind === 1 ? 8 : t.kind === 2 ? 7 : 14) * t.scale;
    const length = Math.min(height / Math.tan(elev), 46);
    const [px, pz] = toPx(t.x, t.z);
    const [qx, qz] = toPx(t.x + dir.x * length, t.z + dir.y * length);
    const grad = g.createLinearGradient(px, pz, qx, qz);
    grad.addColorStop(0, 'rgba(40,40,60,0.55)');
    grad.addColorStop(1, 'rgba(40,40,60,0)');
    g.strokeStyle = grad;
    g.lineWidth = ((t.kind === 0 ? 3.2 : t.kind === 1 ? 4.4 : t.kind === 2 ? 1.6 : 3.8) * t.scale * size) / bw;
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

/**
 * Les pots de résine, cloués sous la care. Inventés en 1840, ils ont remplacé le creuset taillé
 * dans le sol et donné à la forêt landaise sa silhouette la plus reconnaissable : des milliers de
 * troncs balafrés, chacun avec sa poterie au pied.
 */
export function createPots(trees: Tree[]) {
  const gemmed = trees.filter((t) => t.gem > 0.5);
  const pot = new THREE.CylinderGeometry(0.1, 0.065, 0.14, 7, 1, true);
  pot.translate(0, 0.07, 0);
  const geo = pot.toNonIndexed();
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main(){
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main(){
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        // terre cuite, salie de résine sur le bord
        float grain = fbm(vWorld.xz * 9.0);
        vec3 albedo = mix(vec3(0.30, 0.16, 0.10), vec3(0.44, 0.26, 0.17), grain);
        float ndl = max(dot(n, uSunDir), 0.0);
        vec3 col = albedo * (uSunColor * ndl * 0.7 + mix(uSkyHorizon, uSkyTop, 0.5) * uAmbient + lantern(vWorld, n));
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, gemmed.length);
  const dummy = new THREE.Object3D();
  gemmed.forEach((t, i) => {
    // le pot est cloué du côté de la care, contre le tronc
    // même orientation que la care dans le shader : le pot se cloue sous l'entaille, pas ailleurs
    const a = (((t.x * 0.37 + t.z * 0.21) % 1) * 0.16 - 0.08) * Math.PI * 2;
    const r = (t.kind === 3 ? 0.36 : 0.3) * t.scale;
    dummy.position.set(t.x + Math.sin(a) * r, t.y + 0.34, t.z + Math.cos(a) * r);
    dummy.rotation.set(0.1, a, 0);
    dummy.scale.setScalar(0.9 + (i % 5) * 0.05);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.frustumCulled = false;
  mesh.name = 'pots';
  return { mesh, count: gemmed.length };
}
