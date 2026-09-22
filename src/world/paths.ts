import * as THREE from 'three';

// Le réseau de sentiers. La balade part d'un tronc commun sous les arbres, puis se sépare à la
// fourche : on continue vers l'océan, dune après dune, ou on s'enfonce dans les terres, vers le
// marais et son étang.
//
// Tout le reste du monde (relief, arbres, herbes, sous-bois) a besoin de la distance au sentier
// le plus proche, des dizaines de milliers de fois. Comparer chaque point à la courbe coûtait
// déjà cher avec un seul chemin ; avec trois, c'est intenable. On calcule donc une fois pour
// toutes un champ de distances sur une grille, et chaque requête devient une simple lecture.

export type BiomeId = 'foret' | 'dune' | 'marais';
export const BIOMES: BiomeId[] = ['foret', 'dune', 'marais'];

export interface Segment {
  id: string;
  biome: BiomeId;
  curve: THREE.CatmullRomCurve3;
  length: number;
  /** segments accessibles depuis la fin de celui-ci */
  next: string[];
}

const curve = (pts: [number, number][]) =>
  new THREE.CatmullRomCurve3(
    pts.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'catmullrom',
    0.5
  );

// tronc commun : la prairie, la lisière, le sous-bois, puis la fourche.
// Les derniers mètres sont volontairement rectilignes : on arrive face à la fourche, et les deux
// chemins s'ouvrent à droite et à gauche, tous deux dans le champ.
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

// vers l'intérieur : le sentier part sur la droite et descend dans la zone humide
const TO_MARSH: [number, number][] = [
  [0, -94],
  [6, -118],
  [21, -136],
  [35, -153],
  [49, -167],
  [61, -179],
];

function segment(id: string, biome: BiomeId, pts: [number, number][], next: string[] = []): Segment {
  const c = curve(pts);
  return { id, biome, curve: c, length: c.getLength(), next };
}

export const SEGMENTS: Record<string, Segment> = {
  approche: segment('approche', 'foret', APPROACH, ['cote', 'marais']),
  cote: segment('cote', 'dune', TO_COAST),
  marais: segment('marais', 'marais', TO_MARSH),
};

export const START = 'approche';
export const CHOICES = SEGMENTS.approche.next;

/** point de la fourche, où le promeneur s'arrête tant qu'il n'a pas choisi */
export const FORK = new THREE.Vector3(APPROACH[APPROACH.length - 1][0], 0, APPROACH[APPROACH.length - 1][1]);

// Les deux branches font presque la même longueur : le défilement de la page garde ainsi la même
// échelle avant et après le choix, et rien ne saute au moment où l'on s'engage.
export const BRANCH_LENGTH = Math.max(...CHOICES.map((id) => SEGMENTS[id].length));
export const TOTAL_LENGTH = SEGMENTS.approche.length + BRANCH_LENGTH;
/** avancement, 0 → 1, auquel on atteint la fourche */
export const FORK_AT = SEGMENTS.approche.length / TOTAL_LENGTH;

/**
 * Le temps ne court pas à la même vitesse sur les deux branches. Vers l'océan, la lumière se
 * retient : on arrive sur la dune au moment où le soleil touche l'eau. Vers le marais, elle va
 * jusqu'au bout, et la nuit tombe sur l'étang. Les deux fins ne se ressemblent pas.
 */
export const TIME_RATE: Record<string, number> = { cote: 0.2, marais: 0.85 };

// ───────────── champ de distances ─────────────

const FIELD = { x0: -232, z0: -352, cell: 1.5, w: 0, d: 0 };
FIELD.w = Math.ceil(464 / FIELD.cell);
FIELD.d = Math.ceil(472 / FIELD.cell);

/** une carte de distances par biome : permet aussi de savoir dans quel biome on se trouve */
const fields: Record<BiomeId, Float32Array> = {
  foret: new Float32Array(FIELD.w * FIELD.d),
  dune: new Float32Array(FIELD.w * FIELD.d),
  marais: new Float32Array(FIELD.w * FIELD.d),
};
let built = false;

/** au-delà, la distance exacte n'a plus d'influence sur le relief ni sur les semis */
const FAR = 120;

export function buildFields() {
  if (built) return;
  built = true;
  // points d'échantillonnage, un peu plus d'un par mètre, regroupés par biome
  const points: Record<BiomeId, number[]> = { foret: [], dune: [], marais: [] };
  // Les premiers mètres d'une branche restent en forêt : sans cela, les roseaux et les oyats
  // pousseraient jusque dans la fourche, et le changement de paysage arriverait trop tôt.
  const HOLD = 26;
  for (const seg of Object.values(SEGMENTS)) {
    const n = Math.max(2, Math.round(seg.length));
    const pts = seg.curve.getSpacedPoints(n);
    pts.forEach((p, i) => {
      const along = (i / n) * seg.length;
      const biome = seg.id !== START && along < HOLD ? 'foret' : seg.biome;
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
  return Math.min(sample(fields.foret, x, z), sample(fields.dune, x, z), sample(fields.marais, x, z));
}

/** distance aux sentiers d'un biome donné */
export function biomeDistance(biome: BiomeId, x: number, z: number) {
  buildFields();
  return sample(fields[biome], x, z);
}

// Poids des trois biomes en un point : le plus proche domine, et la transition se fait sur une
// trentaine de mètres pour qu'aucune frontière ne soit visible au sol.
const BLEND = 36;
export function biomeWeights(x: number, z: number, out = [0, 0, 0]) {
  buildFields();
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const d = sample(fields[BIOMES[i]], x, z);
    const w = Math.exp(-(d * d) / (BLEND * BLEND));
    out[i] = w;
    sum += w;
  }
  if (sum < 1e-6) {
    out[0] = 1;
    out[1] = out[2] = 0;
    return out;
  }
  for (let i = 0; i < 3; i++) out[i] /= sum;
  return out;
}

/** biome dominant, pour les semis qui doivent trancher plutôt que mélanger */
export function biomeAt(x: number, z: number): BiomeId {
  const w = biomeWeights(x, z);
  let best = 0;
  for (let i = 1; i < 3; i++) if (w[i] > w[best]) best = i;
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
