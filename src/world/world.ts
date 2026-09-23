import * as THREE from 'three';
import { KEYS, setDaylight, state, world } from './light';
import { LAKE, createTerrain, heightAt, paintBiomes } from './terrain';
import { CHOICES, FORK, FORK_AT, TIME_RATE, branchHeading, branchTarget } from './paths';
import { createForest, createPots, paintGround, plantForest } from './forest';
import { createGrass } from './grass';
import { createFireflies, createLake, createMarshWater, createOcean, createSky, type Lake } from './sky';
import { Birds } from './fauna';
import { Egrets } from './egret';
import { Dandelions } from './flora';
import { createUndergrowth } from './undergrowth';
import { createVineyard } from './vines';
import { SunShadow, type Caster } from './shadow';
import { createCrasteBanks, createCrasteWater, createDeck } from './craste';
import { createBasinWater, createCabane, createEstey, createEsteyWater, createPignots } from './bassin';
import { createAlders, createDeltaBanks, createDeltaWater } from './delta';
import { createAirial } from './endings';
import { createPalombiere } from './palombiere';
import { Post } from './post';
import { Walk } from './walk';

// Assemble la forêt, la lumière, la faune et la marche, et fait tourner le rendu.

const { x: LAKE_X, z: LAKE_Z, level: LAKE_LEVEL } = LAKE;
const LAKE_R = LAKE.radius * 1.3;

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(52, 1, 0.1, 900);
  readonly walk: Walk;
  readonly post: Post;
  readonly stats = { frames: 0, triangles: 0, calls: 0, trees: 0, blades: 0, undergrowth: 0, vines: 0, alders: 0, pots: 0 };
  private sky!: THREE.Object3D;
  private fireflies!: THREE.Points;
  private lake!: Lake;
  private birds!: Birds;
  private egrets!: Egrets;
  private dandelions!: Dandelions;
  private pointerRay: THREE.Ray | null = null;
  private shadow!: SunShadow;
  private terrainMat!: THREE.ShaderMaterial;
  private ocean!: THREE.Mesh;
  private basin!: THREE.Group;
  private delta!: THREE.Group;
  private bog!: THREE.Mesh;
  private craste!: THREE.Mesh;
  private banks!: THREE.Mesh;
  private deck!: THREE.Mesh;
  private choice: string | null = null;
  private coast = 0;
  private choiceGlow = 0;
  private stuck = false;
  /** ce que le curseur survole : sert à changer le curseur de la page */
  hover: 'bird' | 'flower' | 'water' | 'path' | null = null;
  onHover?: (what: 'bird' | 'flower' | 'water' | 'path' | null) => void;
  /** appelé quand le promeneur s'engage sur une branche */
  onChoose?: (id: string) => void;
  /** appelé quand on continue à faire défiler sans avoir choisi de chemin */
  onStuck?: (stuck: boolean) => void;
  onBirds?: () => void;
  onBlow?: () => void;
  onSplash?: () => void;
  private clock = new THREE.Timer();
  private pointer = new THREE.Vector2(-10, -10);
  private ray = new THREE.Raycaster();
  private lanternPos = new THREE.Vector3();
  private dpr = Math.min(window.devicePixelRatio, 1.5);
  private slow = 0;
  private blurTween = 0;
  onFrame?: (t: number) => void;

  constructor(private host: HTMLElement) {
    // ?shot : garde le tampon de dessin lisible après coup, le temps d'une capture de contrôle.
    // Hors de ce cas, on laisse le navigateur le vider — c'est lui qui rend le rendu rapide.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: location.search.includes('shot') });
    this.renderer.setPixelRatio(this.dpr);
    host.appendChild(this.renderer.domElement);
    this.post = new Post(this.renderer);
    this.walk = new Walk(this.camera);
    window.addEventListener('pointermove', (e) => this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1));
    window.addEventListener('pointerleave', () => this.pointer.set(-10, -10));
    // Le clic est écouté sur la fenêtre, pas sur le canvas : la section de défilement le
    // recouvre entièrement, et aucun clic ne lui parvenait jamais.
    window.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement | null)?.closest('a, button, #apropos')) return;
      this.throwStone(e);
    });
    new ResizeObserver(() => this.resize()).observe(host);
  }

  // construction par étapes, pour faire avancer l'écran de chargement
  async build(progress: (p: number, label: string) => void) {
    // une pause courte entre deux étapes laisse l'écran de chargement se redessiner
    const step = () => new Promise((r) => setTimeout(r, 16));
    setDaylight(0);

    progress(0.08, 'Relief et sentier');
    await step();
    const { mesh: terrain, material: terrainMat } = createTerrain();
    this.terrainMat = terrainMat;
    const maps = paintBiomes();
    terrainMat.uniforms.uBiome.value = maps.biome;
    terrainMat.uniforms.uBiome2.value = maps.biome2;
    this.scene.add(terrain);

    progress(0.3, 'Plantation des arbres');
    await step();
    const trees = plantForest();
    this.stats.trees = trees.length;
    const forestGroup = createForest(trees);
    this.scene.add(forestGroup);
    this.scene.add(createPalombiere((x, z) => heightAt(x, z)));
    const pots = createPots(trees);
    this.stats.pots = pots.count;
    this.scene.add(pots.mesh);
    // ombres peintes au loin, pour le soleil de 19 h 50, quand elles sont les plus longues
    setDaylight(0.12);
    const painted = paintGround(trees, world.uSunDir.value.clone());
    world.uShadowMap.value = painted.shadow;
    terrainMat.uniforms.uForest.value = painted.forest;
    setDaylight(0);

    progress(0.42, 'Les rangs de vigne');
    await step();
    const vineyard = createVineyard();
    this.stats.vines = vineyard.count;
    this.scene.add(vineyard.group);

    progress(0.55, 'Fougères, souches et rochers');
    await step();
    const under = createUndergrowth();
    this.stats.undergrowth = Object.values(under.counts).reduce((a, b) => a + b, 0);
    this.scene.add(under.group);

    progress(0.62, 'Herbes hautes');
    await step();
    const blades = window.innerWidth < 800 ? 26000 : 52000;
    const grass = createGrass(blades);
    this.stats.blades = (grass.geometry as THREE.InstancedBufferGeometry).instanceCount;
    this.scene.add(grass);

    progress(0.75, 'Ciel, eaux et lucioles');
    await step();
    this.sky = createSky();
    this.scene.add(this.sky);
    this.fireflies = createFireflies();
    this.scene.add(this.fireflies);
    this.lake = createLake(this.dpr);
    this.scene.add(this.lake.mesh);
    this.bog = createMarshWater();
    this.scene.add(this.bog);
    this.craste = createCrasteWater();
    this.scene.add(this.craste);
    this.banks = createCrasteBanks((x, z) => heightAt(x, z));
    this.scene.add(this.banks);
    this.deck = createDeck();
    this.scene.add(this.deck);
    this.ocean = createOcean();
    this.scene.add(this.ocean);

    this.basin = new THREE.Group();
    this.basin.add(createBasinWater(), createEstey((x, z) => heightAt(x, z)), createEsteyWater(), createPignots(), createCabane());
    this.scene.add(this.basin);

    const alders = createAlders((x, z) => heightAt(x, z));
    this.stats.alders = alders.count;
    this.delta = new THREE.Group();
    this.delta.add(createDeltaBanks((x, z) => heightAt(x, z)), createDeltaWater(), alders.mesh);
    this.delta.add(createAirial((x, z) => heightAt(x, z)));
    this.scene.add(this.delta);

    progress(0.82, 'Oiseaux, aigrettes et pissenlits');
    await step();
    this.birds = new Birds();
    this.birds.onTakeOff = () => this.onBirds?.();
    this.scene.add(this.birds.mesh);
    this.egrets = new Egrets();
    this.egrets.onTakeOff = () => this.onBirds?.();
    this.scene.add(this.egrets.mesh);
    this.dandelions = new Dandelions();
    this.dandelions.onBlow = () => this.onBlow?.();
    this.scene.add(this.dandelions.group);

    progress(0.88, 'Ombres portées');
    await step();
    // casters : les deux familles d'arbres, plus les buissons et les souches qui bordent le sentier
    const casters: Caster[] = [];
    const push = (mesh: THREE.InstancedMesh, positions: THREE.Vector3[]) => casters.push({ source: mesh, points: positions });
    const kinds = ['conifer', 'broadleaf'] as const;
    forestGroup.children.forEach((child, i) => {
      const mesh = child as THREE.InstancedMesh;
      push(mesh, trees.filter((t) => t.kind === i).map((t) => new THREE.Vector3(t.x, t.y, t.z)));
      void kinds;
    });
    for (const name of ['bush', 'stump', 'log']) {
      const mesh = under.group.getObjectByName(name) as THREE.InstancedMesh | undefined;
      if (!mesh) continue;
      const m = new THREE.Matrix4();
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        pts.push(new THREE.Vector3().setFromMatrixPosition(m));
      }
      push(mesh, pts);
    }
    this.shadow = new SunShadow(casters);

    progress(0.94, 'Compilation des matériaux');
    await step();
    this.resize();
    this.walk.update(1);
    await this.renderer.compileAsync(this.scene, this.camera);
    progress(1, 'Prêt');
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** heure de la balade : elle ralentit sur la branche du littoral, pour finir au couchant */
  private daylightAt(t: number) {
    if (t <= FORK_AT) return t;
    const rate = TIME_RATE[this.walk.branch ?? ''] ?? 1;
    return FORK_AT + (t - FORK_AT) * rate;
  }

  // position dans la balade, 0 → 1, donnée par le défilement
  setProgress(u: number) {
    this.walk.u = THREE.MathUtils.clamp(u, 0, 1);
  }

  // « respiration » de l'objectif entre deux chapitres
  breathe() {
    this.blurTween = 1;
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h, this.dpr);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 64 : 52;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const time = this.clock.getElapsed();
    if (document.hidden) return;

    this.walk.update(dt);
    // le ciel suit le promeneur : posé à l'origine du monde, on voyait le bord de sa sphère dès
    // qu'on s'en éloignait de deux cents mètres
    this.sky.position.copy(this.camera.position);
    const t = this.walk.progress;
    setDaylight(this.daylightAt(t));
    // chaque branche a son air : épais et chargé d'humidité au marais, lavé par le large sur la côte
    const advance = THREE.MathUtils.smoothstep(t, FORK_AT, FORK_AT + 0.28);
    this.coast = this.walk.branch === 'cote' ? advance : 0;
    if (this.walk.branch === 'marais') {
      world.uFogDensity.value *= 1 + advance * 0.6;
      // la tourbe est à découvert et l'eau renvoie le ciel : il y fait moins noir que sous les arbres
      world.uAmbient.value *= 1 + advance * 0.3;
    }
    else if (this.coast > 0) {
      world.uFogDensity.value *= 1 - this.coast * 0.55;
      // sur la dune, plus rien ne cache le ciel, et le sable comme l'eau renvoient la lumière :
      // l'ambiante y est franchement plus haute que sous les arbres
      world.uAmbient.value *= 1 + this.coast * 0.7;
    }
    world.uTime.value = time;
    this.post.uniforms.uTime.value = time;
    this.post.uniforms.uExposure.value = state.exposure * (1 + this.coast * 0.14);
    this.post.uniforms.uGrade.value.copy(state.grade);

    // lucioles et lanterne arrivent avec la nuit
    const ff = this.fireflies.material as THREE.ShaderMaterial;
    ff.uniforms.uAmount.value = state.fireflies;
    // taille des lucioles proportionnelle à la hauteur de l'image, quelle que soit la résolution
    ff.uniforms.uPixel.value = this.renderer.getPixelRatio() * (this.host.clientHeight / 760) * 3.2;
    this.updateLantern(dt);

    // interactions : le rayon du curseur sert aux oiseaux, aux pissenlits et aux ricochets
    this.pointerRay = this.pointer.x < -2 ? null : (this.ray.setFromCamera(this.pointer, this.camera), this.ray.ray);
    const overBird = this.birds.update(dt, time, this.camera, this.pointerRay);
    const overEgret = this.egrets.update(dt, time, this.camera, this.pointerRay);
    this.dandelions.setPixel(ff.uniforms.uPixel.value);
    const overFlower = this.dandelions.update(time, this.pointerRay);
    const overWater = !!this.pointerRay && this.atLake && this.stonePoint() !== null;
    this.updateChoice(dt);
    const hover = this.choice ? 'path' : overBird || overEgret ? 'bird' : overFlower ? 'flower' : overWater ? 'water' : null;
    if (hover !== this.hover) {
      this.hover = hover;
      this.onHover?.(hover);
    }

    // ombres portées : une passe courte, seulement quand le soleil est encore levé
    this.shadow.update(this.renderer, this.camera, world.uSunDir.value);
    this.updateRays();

    // chaque eau n'est dessinée que sur la branche où elle se trouve ; le lac, qui coûte un
    // second rendu de la scène, n'apparaît qu'une fois sa rive en vue
    const marsh = this.walk.branch === 'marais';
    const coast = this.walk.branch === 'cote';
    this.lake.mesh.visible = marsh && t > 0.8;
    this.bog.visible = marsh && t > 0.6;
    this.craste.visible = marsh;
    this.banks.visible = marsh;
    this.egrets.mesh.visible = marsh;
    this.deck.visible = marsh;
    this.ocean.visible = coast && t > 0.6;
    // le bassin n'apparaît qu'une fois la dune franchie : avant, il est derrière l'horizon
    this.basin.visible = coast && t > 0.78;
    // le delta n'apparaît qu'après l'étang, quand le sentier remonte la rivière
    this.delta.visible = marsh && t > 0.78;

    // flou de respiration : monte vite, redescend lentement
    this.blurTween = Math.max(0, this.blurTween - dt * 1.4);
    const b = this.blurTween;
    this.post.uniforms.uBlur.value = Math.sin(Math.min(b, 1) * Math.PI) * 2.6;

    this.post.render(this.scene, this.camera);
    this.stats.frames++;
    this.stats.calls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
    this.onFrame?.(t);
    this.adapt(dt);
  }

  // ricochet : le clic touche la surface du lac
  private stone = new THREE.Vector3();
  private stonePoint() {
    const r = this.pointerRay;
    if (!r || r.direction.y > -0.02) return null;
    const dist = (LAKE_LEVEL - r.origin.y) / r.direction.y;
    if (dist < 0 || dist > 140) return null;
    this.stone.copy(r.origin).addScaledVector(r.direction, dist);
    const d = Math.hypot(this.stone.x - LAKE_X, this.stone.z - LAKE_Z);
    return d < LAKE_R ? this.stone : null;
  }

  /** vrai quand le promeneur est assez près de l'étang pour lancer une pierre */
  private get atLake() {
    return this.walk.branch === 'marais' && this.walk.progress > 0.86;
  }

  private throwStone(e?: PointerEvent) {
    // au doigt, aucun survol ne précède le contact : on relit le pointeur au moment du clic
    if (e && this.walk.waiting) {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.updateChoice(0.016);
    }
    if (this.choice) {
      // au lieu de lancer une pierre, le clic engage sur le chemin survolé
      const id = this.choice;
      this.walk.choose(id);
      this.choice = null;
      this.onChoose?.(id);
      return;
    }
    if (!this.atLake) return;
    const p = this.stonePoint();
    if (!p) return;
    this.lake.ripple(p.x, p.z, this.clock.getElapsed());
    this.onSplash?.();
  }

  // À la fourche, on ne met pas de texte à l'écran : le sentier survolé s'éclaire, et le curseur
  // annonce l'action comme il le fait pour les oiseaux ou les pissenlits.
  private branchPoint = new THREE.Vector3();
  private branchDir = new THREE.Vector3();
  private updateChoice(dt: number) {
    const uChoice = this.terrainMat.uniforms.uChoice.value as THREE.Vector4;
    let found: string | null = null;
    if (this.walk.waiting && this.pointer.x > -2) {
      // la matrice de la caméra date de l'image précédente : on la remet à jour avant de projeter
      this.camera.updateMatrixWorld();
      let best = 0.17;
      for (const id of CHOICES) {
        branchTarget(id, 26, this.branchPoint);
        this.branchPoint.y = heightAt(this.branchPoint.x, this.branchPoint.z, 0) + 1.2;
        this.branchPoint.project(this.camera);
        if (this.branchPoint.z > 1) continue;
        const d = Math.hypot(this.branchPoint.x - this.pointer.x, this.branchPoint.y - this.pointer.y);
        if (d < best) {
          best = d;
          found = id;
        }
      }
    }
    this.choice = found;
    if (found) {
      branchHeading(found, this.branchDir);
      this.terrainMat.uniforms.uChoiceDir.value.set(this.branchDir.x, this.branchDir.z);
    }
    this.choiceGlow += ((found ? 1 : 0) - this.choiceGlow) * (1 - Math.exp(-dt * 6));
    uChoice.set(FORK.x, FORK.z, 0, this.choiceGlow);

    // on continue à faire défiler alors que le promeneur attend : il faut le dire
    const stuck = this.walk.blocked;
    if (stuck !== this.stuck) {
      this.stuck = stuck;
      this.onStuck?.(stuck);
    }
  }

  // rayons : actifs quand le soleil est au-dessus de l'horizon et devant le promeneur
  private sunPoint = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private updateRays() {
    const sun = world.uSunDir.value;
    this.camera.getWorldDirection(this.forward);
    const facing = THREE.MathUtils.smoothstep(this.forward.dot(sun), 0.2, 0.75);
    const up = THREE.MathUtils.smoothstep(sun.y, -0.01, 0.05);
    this.sunPoint.copy(this.camera.position).addScaledVector(sun, 100).project(this.camera);
    this.post.uniforms.uSunScreen.value.set(this.sunPoint.x * 0.5 + 0.5, this.sunPoint.y * 0.5 + 0.5);
    this.post.uniforms.uRays.value = facing * up;
    this.post.uniforms.uRayColor.value.copy(world.uSunColor.value).multiplyScalar(1 / Math.max(world.uSunColor.value.r, 0.001));
  }

  // la lanterne se pose là où pointe le curseur, à hauteur de main, dans un rayon de quelques mètres
  private updateLantern(dt: number) {
    const on = state.lantern;
    if (on <= 0.01 || this.pointer.x < -2) {
      world.uLantern.value.w += (0 - world.uLantern.value.w) * (1 - Math.exp(-dt * 4));
      return;
    }
    this.ray.setFromCamera(this.pointer, this.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    const reach = THREE.MathUtils.clamp((-1.0 - 0.2) / Math.min(d.y, -0.05), 2.5, 9);
    const target = new THREE.Vector3().copy(o).addScaledVector(d, reach);
    target.y = heightAt(target.x, target.z) + 1.1;
    this.lanternPos.lerp(target, 1 - Math.exp(-dt * 6));
    world.uLantern.value.x = this.lanternPos.x;
    world.uLantern.value.y = this.lanternPos.y;
    world.uLantern.value.z = this.lanternPos.z;
    world.uLantern.value.w += (on * 3.2 - world.uLantern.value.w) * (1 - Math.exp(-dt * 4));
  }

  // densité de pixels réduite par paliers si le GPU peine
  private adapt(dt: number) {
    if (dt > 1 / 38) this.slow++;
    else this.slow = Math.max(0, this.slow - 2);
    if (this.slow > 50 && this.dpr > 0.75) {
      this.dpr = Math.max(0.75, this.dpr - 0.25);
      this.slow = 0;
      this.resize();
    }
  }

  get keys() {
    return KEYS;
  }
}
