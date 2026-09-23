import * as THREE from 'three';
import { surfaceAt } from './terrain';
import { CHOICES, START, TOTAL_LENGTH, TRUNK, TRUNK_LENGTH, type Position, branchRoute, routePosition } from './paths';

// La marche : la caméra avance sur le sentier à hauteur d'yeux. Le défilement choisit la distance
// parcourue, un amorti léger la rejoint. Le regard suit le chemin, avec des intentions par endroit
// (lever les yeux vers la canopée, se tourner vers la clairière, s'arrêter au bout).
//
// Tant que la branche n'est pas choisie, la marche bute sur la fourche : on peut continuer à faire
// défiler la page, le promeneur attend là, et repart dès qu'un chemin est pris.

interface Gaze {
  at: number; // avancement dans le segment, 0 → 1
  yaw: number; // radians, positif vers la gauche
  pitch: number; // radians, positif vers le haut
  eye: number; // hauteur des yeux au-dessus du sol
}

const GAZE: Record<string, Gaze[]> = {
  vigne: [
    { at: 0.0, yaw: 0.1, pitch: 0.04, eye: 1.7 },
    { at: 0.3, yaw: -0.42, pitch: -0.02, eye: 1.7 }, // on regarde filer les rangs sur la gauche
    { at: 0.6, yaw: 0.3, pitch: 0.06, eye: 1.7 }, // puis le château, sur la droite
    { at: 1.0, yaw: 0.0, pitch: 0.08, eye: 1.7 }, // la lisière se referme devant
  ],
  approche: [
    { at: 0.0, yaw: 0.18, pitch: 0.06, eye: 1.7 },
    { at: 0.2, yaw: 0.05, pitch: 0.02, eye: 1.65 },
    { at: 0.42, yaw: -0.12, pitch: 0.34, eye: 1.6 }, // sous-bois : on lève les yeux vers la canopée
    { at: 0.62, yaw: -0.5, pitch: 0.02, eye: 1.7 }, // clairière, sur la gauche du sentier
    { at: 0.82, yaw: -0.1, pitch: 0.0, eye: 1.65 },
    { at: 1.0, yaw: 0.0, pitch: 0.04, eye: 1.7 }, // la fourche : on regarde les deux chemins
  ],
  cote: [
    { at: 0.0, yaw: 0.0, pitch: 0.02, eye: 1.65 },
    { at: 0.35, yaw: 0.3, pitch: -0.02, eye: 1.6 }, // entre les pins, on regarde le sable arriver
    { at: 0.68, yaw: -0.18, pitch: 0.14, eye: 1.7 }, // la montée de la dune
    { at: 1.0, yaw: 0.0, pitch: -0.07, eye: 1.8 }, // la crête : la plage en contrebas, puis l'océan
  ],
  bassin: [
    { at: 0.0, yaw: -0.3, pitch: 0.0, eye: 1.75 }, // on quitte l'océan, dos au couchant
    { at: 0.35, yaw: 0.25, pitch: -0.08, eye: 1.7 },
    { at: 0.7, yaw: -0.15, pitch: 0.02, eye: 1.7 },
    { at: 1.0, yaw: 0.28, pitch: 0.03, eye: 2.2 }, // la lagune, les pignots, la cabane tchanquée
  ],
  delta: [
    { at: 0.0, yaw: 0.1, pitch: 0.0, eye: 1.65 },
    { at: 0.4, yaw: -0.3, pitch: -0.06, eye: 1.6 }, // les bras d'eau entre les aulnes
    { at: 0.75, yaw: 0.2, pitch: 0.05, eye: 1.65 },
    { at: 1.0, yaw: 0.0, pitch: 0.06, eye: 1.9 },
  ],
  airial: [
    { at: 0.0, yaw: 0.15, pitch: 0.02, eye: 1.65 },
    { at: 0.5, yaw: -0.2, pitch: 0.06, eye: 1.7 }, // les chênes de l'airial s'ouvrent
    { at: 1.0, yaw: 0.0, pitch: 0.03, eye: 1.7 }, // la maison, la lampe allumée
  ],
  marais: [
    { at: 0.0, yaw: -0.05, pitch: 0.0, eye: 1.65 },
    { at: 0.12, yaw: -0.14, pitch: 0.24, eye: 1.7 }, // la palombière, dans les pins sur la gauche
    { at: 0.22, yaw: -0.12, pitch: 0.16, eye: 1.68 },
    { at: 0.35, yaw: 0.22, pitch: -0.16, eye: 1.55 }, // on surveille où l'on met les pieds
    { at: 0.72, yaw: -0.28, pitch: 0.04, eye: 1.6 },
    { at: 1.0, yaw: -0.06, pitch: 0.04, eye: 2.2 }, // la rive de l'étang
  ],
};

const FLAT: Gaze = { at: 0, yaw: 0, pitch: 0.02, eye: 1.7 };

export class Walk {
  /** position visée, en mètres parcourus depuis le départ */
  target = 0;
  /** position réelle, amortie */
  current = 0;
  route: string[] = [...TRUNK];
  chosen: string | null = null;
  private yaw = 0;
  private pitch = 0;
  private eye = 1.7;
  private look = new THREE.Vector2(); // regard libre à la souris
  private lookTarget = new THREE.Vector2();
  private here: Position = routePosition([START], 0);
  private ahead: Position = routePosition([START], 0);
  private p = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private stride = 0;
  private heading = 0; // cap amorti, en radians
  private headingReady = false;
  private scrollU = 0; // dernier défilement brut, avant recalage
  private mapFrom = 0; // défilement au moment du choix
  private mapTo = 0; // avancement au même instant

  constructor(private camera: THREE.PerspectiveCamera) {
    window.addEventListener('pointermove', (e) => {
      this.lookTarget.set((e.clientX / window.innerWidth - 0.5) * -0.22, (e.clientY / window.innerHeight - 0.5) * -0.12);
    });
  }

  /** la branche prise, ou null tant qu'on est sur le tronc commun */
  get branch(): string | null {
    return this.route[TRUNK.length] ?? null;
  }

  /** avancement global, 0 → 1 : pilote l'heure, le son et l'interface */
  get progress() {
    return THREE.MathUtils.clamp(this.current / TOTAL_LENGTH, 0, 1);
  }

  /** distance à laquelle la marche s'arrête tant qu'aucune branche n'est prise */
  private get limit() {
    return this.chosen ? TOTAL_LENGTH : TRUNK_LENGTH;
  }

  /** vrai quand on fait défiler au-delà de la fourche sans avoir choisi de chemin */
  get blocked() {
    return !this.chosen && this.target > TRUNK_LENGTH + 8;
  }

  /** vrai quand le promeneur attend à la fourche */
  get waiting() {
    return !this.chosen && this.current > TRUNK_LENGTH - 14;
  }

  /**
   * Le défilement de la page, 0 → 1.
   *
   * Pendant l'attente à la fourche, la page continue de défiler alors que la marche, elle, est
   * arrêtée : un écart se creuse entre les deux. Sans rien faire, cet écart se libère d'un coup
   * au moment du choix et le promeneur part en courant. On recale donc l'échelle au moment où
   * la branche est prise : le défilement restant couvre exactement la branche restante.
   */
  set u(v: number) {
    this.scrollU = THREE.MathUtils.clamp(v, 0, 1);
    let x = this.scrollU;
    if (this.chosen) {
      const span = Math.max(1 - this.mapFrom, 0.02);
      x = this.mapTo + ((this.scrollU - this.mapFrom) * (1 - this.mapTo)) / span;
    }
    this.target = THREE.MathUtils.clamp(x, 0, 1) * TOTAL_LENGTH;
  }

  choose(id: string) {
    if (this.chosen || !CHOICES.includes(id)) return;
    this.chosen = id;
    this.route = [...TRUNK, ...branchRoute(id)];
    this.mapFrom = this.scrollU;
    this.mapTo = this.current / TOTAL_LENGTH;
    this.target = this.current; // on repart d'où l'on est, sans sursaut
  }

  // renvoie vrai tant que la caméra bouge encore
  update(dt: number) {
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * 3.2);
    const before = this.current;
    const goal = Math.min(this.target, this.limit);
    this.current += (goal - this.current) * k;
    const speed = Math.abs(this.current - before) / Math.max(dt, 1e-3);

    routePosition(this.route, this.current, this.here);
    routePosition(this.route, this.current + 2.2, this.ahead);

    // intentions du regard, interpolées en douceur entre les repères
    const g = this.gazeAt(this.here);
    const kg = 1 - Math.exp(-dt * 2.4);
    this.yaw += (g.yaw - this.yaw) * kg;
    this.pitch += (g.pitch - this.pitch) * kg;
    this.eye += (g.eye - this.eye) * kg;
    this.look.lerp(this.lookTarget, 1 - Math.exp(-dt * 2));

    this.p.copy(this.here.point);
    // pas : léger balancement proportionnel à la vitesse de marche
    this.stride += speed * dt * 110;
    const bob = this.reduced ? 0 : Math.min(speed * 7, 1) * 0.035;
    const ground = surfaceAt(this.p.x, this.p.z);
    this.camera.position.set(this.p.x + Math.cos(this.stride * 0.5) * bob * 0.6, ground + this.eye + Math.abs(Math.sin(this.stride)) * bob, this.p.z);

    // en bout de branche, on regarde dans l'axe du sentier plutôt que vers un point confondu
    this.dir.copy(this.here.local > 0.99 ? this.here.tangent : this.ahead.point.clone().sub(this.p));
    this.dir.y = 0;
    if (this.dir.lengthSq() < 1e-6) this.dir.copy(this.here.tangent).setY(0);
    this.dir.normalize();
    // Le cap suit le sentier avec un peu de retard. Sans cet amorti, tout changement de direction
    // un peu vif — un raccord entre deux courbes, un virage court — fait pivoter la tête d'un bloc.
    const target = Math.atan2(-this.dir.x, -this.dir.z);
    if (!this.headingReady) {
      this.heading = target;
      this.headingReady = true;
    } else {
      let delta = target - this.heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.heading += delta * (this.reduced ? 1 : 1 - Math.exp(-dt * 1.7));
    }
    const yaw = this.heading + this.yaw + this.look.x;
    const pitch = this.pitch + this.look.y;
    this.camera.rotation.set(pitch, yaw, Math.sin(this.stride * 0.5) * bob * 0.05, 'YXZ');
    return Math.abs(goal - this.current) > 1e-3 || speed > 1e-3;
  }

  private gazeAt(pos: Position) {
    const keys = GAZE[pos.segment.id];
    if (!keys) return FLAT;
    let i = 0;
    while (i < keys.length - 2 && pos.local > keys[i + 1].at) i++;
    const a = keys[i];
    const b = keys[i + 1];
    let k = THREE.MathUtils.clamp((pos.local - a.at) / (b.at - a.at), 0, 1);
    k = k * k * (3 - 2 * k);
    return { yaw: a.yaw + (b.yaw - a.yaw) * k, pitch: a.pitch + (b.pitch - a.pitch) * k, eye: a.eye + (b.eye - a.eye) * k };
  }
}
