import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SEGMENTS } from './paths';
import { glslNoise, glslWorld, world } from './light';

// La craste : le fossé de drainage creusé dans le sable pour assécher la lande et permettre la
// plantation du pin. C'est la marque de fabrique du massif landais, et c'est surtout une ligne
// parfaitement droite dans un paysage qui n'en a aucune. Le sentier la longe, puis la franchit
// sur un caillebotis de bois.

// Le fossé est construit à partir d'un point du sentier : on garantit ainsi qu'il le croise
// vraiment, au lieu de le longer de trois mètres et de laisser le caillebotis dans le vide.
const CROSS_AT = 0.52; // avancement dans la branche du marais
const CROSS_ANGLE = (55 * Math.PI) / 180;

const crossPoint = SEGMENTS.marais.curve.getPointAt(CROSS_AT);
const crossTangent = SEGMENTS.marais.curve.getTangentAt(CROSS_AT);
const dir2 = new THREE.Vector2(
  crossTangent.x * Math.cos(CROSS_ANGLE) - crossTangent.z * Math.sin(CROSS_ANGLE),
  crossTangent.x * Math.sin(CROSS_ANGLE) + crossTangent.z * Math.cos(CROSS_ANGLE)
).normalize();

export const CRASTE = {
  // Le fossé s'arrête court de ce côté : allongé, il atteignait le sentier de l'océan et l'on
  // tombait dedans juste avant la montée de la dune.
  a: new THREE.Vector2(crossPoint.x - dir2.x * 24, crossPoint.z - dir2.y * 24),
  b: new THREE.Vector2(crossPoint.x + dir2.x * 44, crossPoint.z + dir2.y * 44),
  /** demi-largeur du fond, en mètres */
  half: 2.2,
  /** demi-largeur totale, berges en pente comprises */
  bank: 5.4,
  /** niveau de l'eau */
  level: -3.2,
  /** profondeur du fond sous l'eau */
  depth: 1.3,
};

const ab = new THREE.Vector2().subVectors(CRASTE.b, CRASTE.a);
const abLenSq = ab.lengthSq();
export const CRASTE_LENGTH = ab.length();
export const CRASTE_DIR = ab.clone().normalize();

const tmp = new THREE.Vector2();

/** distance horizontale à l'axe du fossé ; au-delà de ses extrémités, il n'existe plus */
export function crasteDistance(x: number, z: number) {
  tmp.set(x, z).sub(CRASTE.a);
  const t = tmp.dot(ab) / abLenSq;
  if (t < 0 || t > 1) {
    const over = t < 0 ? -t : t - 1;
    return 60 + over * 200;
  }
  return Math.abs(tmp.x * CRASTE_DIR.y - tmp.y * CRASTE_DIR.x);
}

/** là où le sentier du marais franchit le fossé : on y pose le caillebotis */
export const CROSSING = { point: crossPoint, tangent: crossTangent, local: CROSS_AT };

/** hauteur de la berge à une distance latérale donnée de l'axe : fond plat, replat, talus */
export function crasteProfile(d: number, ground: number) {
  const floor = CRASTE.level - CRASTE.depth;
  const lip = CRASTE.half + (CRASTE.bank - CRASTE.half) * 0.75;
  const lipY = floor + (CRASTE.depth + 0.9) * 0.85;
  if (d <= CRASTE.half) return floor;
  if (d <= lip) return floor + ((d - CRASTE.half) / (lip - CRASTE.half)) * (lipY - floor);
  if (d >= CRASTE.bank) return ground;
  return lipY + ((d - lip) / (CRASTE.bank - lip)) * (ground - lipY);
}

/** longueur du platelage, un peu plus large que le fossé pour poser les appuis sur la berge */
const DECK_SPAN = 13;
const DECK_HALF_WIDTH = 0.85;
const DECK_TOP = CRASTE.level + 1.05;

/** hauteur du platelage sous un point donné, ou null si l'on n'est pas dessus */
export function deckHeight(x: number, z: number) {
  const dx = x - CROSSING.point.x;
  const dz = z - CROSSING.point.z;
  const along = dx * CROSSING.tangent.x + dz * CROSSING.tangent.z;
  const side = dx * -CROSSING.tangent.z + dz * CROSSING.tangent.x;
  if (Math.abs(along) > DECK_SPAN / 2 || Math.abs(side) > DECK_HALF_WIDTH + 0.15) return null;
  return DECK_TOP;
}

// ───────────── géométries ─────────────

function plank(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** le caillebotis : des planches en travers, deux longerons, des pieux plantés dans la vase */
export function createDeck() {
  const parts: THREE.BufferGeometry[] = [];
  const boards = Math.round(DECK_SPAN / 0.32);
  for (let i = 0; i < boards; i++) {
    const t = -DECK_SPAN / 2 + (i + 0.5) * (DECK_SPAN / boards);
    // chaque planche a son propre gauchissement : un platelage n'est jamais plan
    const tilt = Math.sin(i * 2.7) * 0.012;
    const g = plank(DECK_HALF_WIDTH * 2, 0.06, 0.26, 0, -tilt * 2, t);
    g.rotateZ(tilt);
    parts.push(g);
  }
  parts.push(plank(0.12, 0.16, DECK_SPAN, -DECK_HALF_WIDTH + 0.18, -0.11, 0));
  parts.push(plank(0.12, 0.16, DECK_SPAN, DECK_HALF_WIDTH - 0.18, -0.11, 0));
  for (const z of [-DECK_SPAN / 2 + 0.6, -1.6, 1.6, DECK_SPAN / 2 - 0.6]) {
    for (const x of [-DECK_HALF_WIDTH + 0.18, DECK_HALF_WIDTH - 0.18]) {
      parts.push(plank(0.16, 1.9, 0.16, x, -1.05, z));
    }
  }
  const geo = mergeGeometries(parts)!;
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vLocal = position;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      void main(){
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        // bois gris, veiné dans le sens de la planche, plus sombre au ras de l'eau
        float grain = fbm(vec2(vLocal.x * 14.0, vLocal.z * 2.2));
        vec3 albedo = mix(vec3(0.18, 0.16, 0.13), vec3(0.36, 0.33, 0.28), grain);
        albedo *= mix(0.55, 1.0, smoothstep(-1.4, 0.0, vLocal.y));
        float ndl = max(dot(n, uSunDir), 0.0);
        float shadow = sunShadow(vWorld, ndl);
        vec3 amb = mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient;
        vec3 col = albedo * (uSunColor * ndl * shadow + amb + lantern(vWorld, n));
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(CROSSING.point.x, DECK_TOP, CROSSING.point.z);
  mesh.rotation.y = Math.atan2(CROSSING.tangent.x, CROSSING.tangent.z);
  mesh.name = 'caillebotis';
  return mesh;
}

/**
 * Les berges du fossé, en géométrie propre.
 *
 * Le terrain est une grille de deux mètres : une tranchée de quatre mètres de large n'y tient pas,
 * elle se lit comme un creux mou au lieu d'un fossé à bords nets. On dessine donc le profil à
 * part — talus, fond plat, talus — et le terrain se contente de faire de la place dessous.
 */
export function createCrasteBanks(groundAt: (x: number, z: number) => number) {
  const steps = 110;
  const floor = CRASTE.level - CRASTE.depth;
  const lip = CRASTE.half + (CRASTE.bank - CRASTE.half) * 0.75;
  const lipY = crasteProfile(lip, 0);
  const side = new THREE.Vector2(-CRASTE_DIR.y, CRASTE_DIR.x);
  // Profil ordonné d'une berge à l'autre. L'ordre compte : il garantit que toutes les faces
  // tournent dans le même sens, sinon les normales se contredisent et le talus se raye.
  const section: [number, number | null, number][] = [
    [-CRASTE.bank, null, 1],
    [-lip, lipY, 0.72],
    [-CRASTE.half, floor, 0],
    [CRASTE.half, floor, 0],
    [lip, lipY, 0.72],
    [CRASTE.bank, null, 1],
  ];

  const pos: number[] = [];
  const edge: number[] = [];
  const at = (t: number, off: number, y: number | null) => {
    const x = CRASTE.a.x + ab.x * t + side.x * off;
    const z = CRASTE.a.y + ab.y * t + side.y * off;
    return [x, y === null ? groundAt(x, z) : y, z] as [number, number, number];
  };
  const push = (p: [number, number, number], e: number) => {
    pos.push(p[0], p[1], p[2]);
    edge.push(e);
  };

  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    for (let k = 0; k < section.length - 1; k++) {
      const [o0, y0, e0] = section[k];
      const [o1, y1, e1] = section[k + 1];
      const a = at(t0, o0, y0);
      const b = at(t1, o0, y0);
      const c = at(t1, o1, y1);
      const d = at(t0, o1, y1);
      push(a, e0); push(c, e1); push(b, e0);
      push(a, e0); push(d, e1); push(c, e1);
    }
  }

  const raw = new THREE.BufferGeometry();
  raw.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  raw.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  // sans soudure, chaque triangle garde sa propre normale et le talus se lit comme un escalier
  const geo = mergeVertices(raw, 1e-4);
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aEdge;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vEdge;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vEdge = aEdge;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vEdge;
      void main(){
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        float grain = fbm(vWorld.xz * 0.8);
        // sable nu et lessivé sur le talus, vase noire au fond
        vec3 sand = mix(vec3(0.26, 0.22, 0.16), vec3(0.38, 0.33, 0.24), grain);
        vec3 mud = mix(vec3(0.07, 0.07, 0.05), vec3(0.13, 0.12, 0.09), grain);
        vec3 albedo = mix(mud, sand, smoothstep(0.15, 0.75, vEdge));
        float ndl = max(dot(n, uSunDir), 0.0);
        float shadow = sunShadow(vWorld, ndl);
        // le fond ne voit qu'une fente de ciel : il reste sombre même en plein couchant
        float sky = mix(0.35, 1.0, vEdge);
        vec3 col = albedo * (uSunColor * ndl * shadow * sky + mix(uSkyHorizon, uSkyTop, 0.4) * uAmbient * sky + lantern(vWorld, n));
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'craste-berges';
  return mesh;
}

/** l'eau du fossé : une bande étroite et sombre, presque immobile */
export function createCrasteWater() {
  const geo = new THREE.PlaneGeometry(CRASTE.half * 2, CRASTE_LENGTH, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      void main(){
        vec3 v = normalize(cameraPosition - vWorld);
        float r = fbm(vWorld.xz * 1.4 + vec2(uTime * 0.03, uTime * 0.02));
        vec3 n = normalize(vec3((r - 0.5) * 0.12, 1.0, (fbm(vWorld.xz * 1.1 - uTime * 0.02) - 0.5) * 0.12));
        float fresnel = 0.06 + 0.94 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
        // eau de lande : acide, très sombre, presque un miroir noir sous un ciel clair
        vec3 col = mix(vec3(0.012, 0.018, 0.016), mix(uSkyHorizon, uSkyTop, 0.3) * 0.8, fresnel);
        col += uSkyHorizon * pow(max(dot(reflect(-v, n), uMoonDir), 0.0), 70.0) * uMoon * 1.2;
        col += lantern(vWorld, n) * 0.6;
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  const mid = new THREE.Vector2().addVectors(CRASTE.a, CRASTE.b).multiplyScalar(0.5);
  mesh.position.set(mid.x, CRASTE.level, mid.y);
  mesh.rotation.y = -Math.atan2(CRASTE_DIR.x, CRASTE_DIR.y);
  mesh.name = 'craste';
  return mesh;
}
