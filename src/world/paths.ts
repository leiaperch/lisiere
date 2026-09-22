import * as THREE from 'three';

// Le réseau de sentiers.
//
// La balade part des rangs de vigne, entre sous les arbres, et se sépare à la fourche : on continue
// vers l'océan puis on bascule côté bassin, ou on s'enfonce dans les terres, vers le marais puis
// le delta de la rivière. Chaque branche a donc deux tronçons ; le choix, lui, est unique.
//
// Tout le reste du monde (relief, arbres, herbes, sous-bois) a besoin de la distance au sentier le
// plus proche, des dizaines de milliers de fois. Comparer chaque point à chaque courbe coûte trop
// cher : on calcule une fois pour toutes un champ de distances sur une grille, et chaque requête
// devient une simple lecture.

export type BiomeId = 'vigne' | 'foret' | 'dune' | 'bassin' | 'marais' | 'delta';
export const BIOMES: BiomeId[] = ['vigne', 'foret', 'dune', 'bassin', 'marais', 'delta'];

export interface Segment {
  id: string;
  biome: BiomeId;
  curve: THREE.CatmullRomCurve3;
  length: number;
  /** segment qui suit automatiquement, ou branches proposées au choix */
  next: string[];
}

const curve = (pts: [number, number][]) =>
  new THREE.CatmullRomCurve3(
    pts.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'catmullrom',
    0.5
  );

// les rangs de vigne sur les graves, avant la lisière
const VINES: [number, number][] = [
  [8, 152],
  [4, 126],
  [-4, 100],
  [0, 74],
  [5, 48],
  [0, 24],
];

// tronc commun sous les arbres. Les derniers mètres sont rectilignes : on arrive face à la
// fourche, et les deux chemins s'ouvrent à droite et à gauche, tous deux dans le champ.
const APPROACH: [number, number][] = [
  [0, 24],
  [2, 4],
  [-4, -22],
  [-9, -48],
  [-4, -70],
  [0, -84],
  [0, -94],
];

// vers l'océan : le sentier part sur la gauche, puis monte sur la dune face au couchant
const TO_COAST: [number, number][] = [
  [0, -94],
  [-6, -118],
  [-17, -140],
  [-23, -163],
  [-27, -183],
  [-29, -201],
];

// puis on bascule de l'autre côté de la flèche de sable, vers les eaux calmes du bassin
const TO_BASIN: [number, number][] = [
  [-29, -201],
  [-12, -212],
  [12, -218],
  [36, -223],
  [58, -230],
  [78, -239],
];

// vers l'intérieur : le sentier part sur la droite et descend dans la zone humide
const TO_MARSH: [number, number][] = [
  [0, -94],
  [6, -118],
  [21, -136],
  [35, -153],
  [49, -167],
  [61, -179],
];

// puis il remonte la rivière, dans les aulnes
const TO_DELTA: [number, number][] = [
  [61, -179],
  [78, -181],
  [96, -177],
  [113, -172],
  [130, -165],
  [146, -156],
];

function segment(id: string, biome: BiomeId, pts: [number, number][], next: string[] = []): Segment {
  const c = curve(pts);
  return { id, biome, curve: c, length: c.getLength(), next };
}

export const SEGMENTS: Record<string, Segment> = {
  vigne: segment('vigne', 'vigne', VINES, ['approche']),
  approche: segment('approche', 'foret', APPROACH, ['cote', 'marais']),
  cote: segment('cote', 'dune', TO_COAST, ['bassin']),
  bassin: segment('bassin', 'bassin', TO_BASIN),
  marais: segment('marais', 'marais', TO_MARSH, ['delta']),
  delta: segment('delta', 'delta', TO_DELTA),
};

export const START = 'vigne';
/** les deux chemins proposés à la fourche */
export const CHOICES = SEGMENTS.approche.next;
/** ce qu'on parcourt avant d'avoir à choisir */
export const TRUNK = ['vigne', 'approche'];
const TRUNK_LENGTH = TRUNK.reduce((n, id) => n + SEGMENTS[id].length, 0);

/** itinéraire complet d'une branche, continuations comprises */
export function branchRoute(id: string): string[] {
  const out = [id];
  let seg = SEGMENTS[id];
  while (seg.next.length === 1) {
    seg = SEGMENTS[seg.next[0]];
    out.push(seg.id);
  }
  return out;
}

/** point de la fourche, où le promeneur s'arrête tant qu'il n'a pas choisi */
export const FORK = (() => {
  const p = SEGMENTS.approche.curve.getPointAt(1);
  return new THREE.Vector3(p.x, 0, p.z);
})();

const BRANCH_LENGTH = Math.max(...CHOICES.map((id) => branchRoute(id).reduce((n, s) => n + SEGMENTS[s].length, 0)));
export const TOTAL_LENGTH = TRUNK_LENGTH + BRANCH_LENGTH;
/** avancement, 0 → 1, auquel on atteint la fourche */
export const FORK_AT = TRUNK_LENGTH / TOTAL_LENGTH;
export { TRUNK_LENGTH };

/**
 * Le temps ne court pas à la même vitesse sur les deux branches. Vers l'océan, la lumière se
 * retient : on arrive sur la dune au moment où le soleil touche l'eau, et la nuit tombe sur le
 * bassin. Vers le marais, elle va plus vite, et le delta se traverse à la nuit.
 */
export const TIME_RATE: Record<string, number> = { cote: 0.35, marais: 0.85 };

// ───────────── champ de distances ─────────────

const FIELD = { x0: -250, z0: -340, cell: 1.6, w: 0, d: 0 };
FIELD.w = Math.ceil(520 / FIELD.cell);
FIELD.d = Math.ceil(530 / FIELD.cell);

/** une carte de distances par biome : permet aussi de savoir dans quel biome on se trouve */
const fields = {} as Record<BiomeId, Float32Array>;
for (const b of BIOMES) fields[b] = new Float32Array(FIELD.w * FIELD.d);
let built = false;

/** au-delà, la distance exacte n'a plus d'influence sur le relief ni sur les semis */
const FAR = 120;

export function buildFields() {
  if (built) return;
  built = true;
  const points = {} as Record<BiomeId, number[]>;
  for (const b of BIOMES) points[b] = [];
  // Les premiers mètres d'un tronçon gardent le biome du précédent : sans cela le paysage
  // changerait pile à la jonction, et les roseaux pousseraient jusque dans la fourche.
  const HOLD = 26;
  for (const seg of Object.values(SEGMENTS)) {
    const previous = Object.values(SEGMENTS).find((s) => s.next.includes(seg.id));
    const n = Math.max(2, Math.round(seg.length));
    seg.curve.getSpacedPoints(n).forEach((p, i) => {
      const along = (i / n) * seg.length;
      const biome = previous && along < HOLD ? previous.biome : seg.biome;
      points[biome].push(p.x, p.z);
    });
  }

  for (const biome of BIOMES) {
    const pts = points[biome];
    const field = fields[biome];
    for (let iz = 0; iz < FIELD.d; iz++) {
      const z = FIELD.z0 + iz * FIELD.cell;
      for (let ix = 0; ix < FIELD.w; ix++) {
        const x = FIELD.x0 + ix * FIELD.cell;
        let best = FAR * FAR;
        for (let i = 0; i < pts.length; i += 2) {
          const dx = pts[i] - x;
          const dz = pts[i + 1] - z;
          const d = dx * dx + dz * dz;
          if (d < best) best = d;
        }
        field[iz * FIELD.w + ix] = Math.sqrt(best);
      }
    }
  }
}

// lecture bilinéaire du champ : continue, donc le sentier n'a pas de bord en escalier
function sample(field: Float32Array, x: number, z: number) {
  const fx = (x - FIELD.x0) / FIELD.cell;
  const fz = (z - FIELD.z0) / FIELD.cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  if (ix < 0 || iz < 0 || ix >= FIELD.w - 1 || iz >= FIELD.d - 1) return FAR;
  const tx = fx - ix;
  const tz = fz - iz;
  const i = iz * FIELD.w + ix;
  const a = field[i] + (field[i + 1] - field[i]) * tx;
  const b = field[i + FIELD.w] + (field[i + FIELD.w + 1] - field[i + FIELD.w]) * tx;
  return a + (b - a) * tz;
}

/** distance horizontale au sentier le plus proche, tous chemins confondus */
export function trailDistance(x: number, z: number) {
  buildFields();
  let best = FAR;
  for (const b of BIOMES) best = Math.min(best, sample(fields[b], x, z));
  return best;
}

/** distance aux sentiers d'un biome donné */
export function biomeDistance(biome: BiomeId, x: number, z: number) {
  buildFields();
  return sample(fields[biome], x, z);
}

// Poids des biomes en un point : le plus proche domine, et la transition se fait sur une
// trentaine de mètres pour qu'aucune frontière ne soit visible au sol.
const BLEND = 36;
export function biomeWeights(x: number, z: number, out: number[] = []) {
  buildFields();
  let sum = 0;
  for (let i = 0; i < BIOMES.length; i++) {
    const d = sample(fields[BIOMES[i]], x, z);
    const w = Math.exp(-(d * d) / (BLEND * BLEND));
    out[i] = w;
    sum += w;
  }
  if (sum < 1e-6) {
    out.fill(0);
    out[1] = 1;
    return out;
  }
  for (let i = 0; i < BIOMES.length; i++) out[i] /= sum;
  return out;
}

const weightsTmp: number[] = [];

/** biome dominant, pour les semis qui doivent trancher plutôt que mélanger */
export function biomeAt(x: number, z: number): BiomeId {
  const w = biomeWeights(x, z, weightsTmp);
  let best = 0;
  for (let i = 1; i < BIOMES.length; i++) if (w[i] > w[best]) best = i;
  return BIOMES[best];
}

// ───────────── parcours ─────────────

export interface Position {
  point: THREE.Vector3;
  tangent: THREE.Vector3;
  segment: Segment;
  /** avancement dans le segment, 0 → 1 */
  local: number;
}

const tmpPoint = new THREE.Vector3();
const tmpTangent = new THREE.Vector3();

export const newPosition = (): Position => ({ point: new THREE.Vector3(), tangent: new THREE.Vector3(0, 0, -1), segment: SEGMENTS[START], local: 0 });

/**
 * Position sur un itinéraire, donnée en mètres parcourus. Tant que la branche n'est pas choisie,
 * l'itinéraire s'arrête à la fourche et le promeneur y attend.
 */
export function routePosition(route: string[], distance: number, out: Position = newPosition()) {
  let left = Math.max(distance, 0);
  let seg = SEGMENTS[route[0]];
  for (let i = 0; i < route.length; i++) {
    seg = SEGMENTS[route[i]];
    if (left <= seg.length || i === route.length - 1) break;
    left -= seg.length;
  }
  const local = THREE.MathUtils.clamp(left / seg.length, 0, 1);
  seg.curve.getPointAt(local, tmpPoint);
  seg.curve.getTangentAt(local, tmpTangent);
  out.point.copy(tmpPoint);
  out.tangent.copy(tmpTangent);
  out.segment = seg;
  out.local = local;
  return out;
}

/** direction de départ d'une branche, pour orienter le surlignage au moment du choix */
export function branchHeading(id: string, out = new THREE.Vector3()) {
  return SEGMENTS[id].curve.getTangentAt(0.08, out);
}

/** point situé à quelques mètres dans une branche : sert de cible de survol pour le choix */
export function branchTarget(id: string, metres = 22, out = new THREE.Vector3()) {
  const seg = SEGMENTS[id];
  return seg.curve.getPointAt(THREE.MathUtils.clamp(metres / seg.length, 0, 1), out);
}
