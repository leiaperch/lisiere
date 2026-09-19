import * as THREE from 'three';
import { KEYS, setDaylight, state, world } from './light';
import { createTerrain, heightAt } from './terrain';
import { createForest, paintGround, plantForest } from './forest';
import { createGrass } from './grass';
import { createFireflies, createLake, createSky } from './sky';
import { Post } from './post';
import { Walk } from './walk';

// Assemble la forêt, la lumière et la marche, et fait tourner le rendu.

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(52, 1, 0.1, 900);
  readonly walk: Walk;
  readonly post: Post;
  readonly stats = { frames: 0, triangles: 0, calls: 0, trees: 0, blades: 0 };
  private fireflies!: THREE.Points;
  private lake!: THREE.Mesh;
  private clock = new THREE.Timer();
  private pointer = new THREE.Vector2(-10, -10);
  private ray = new THREE.Raycaster();
  private lanternPos = new THREE.Vector3();
  private dpr = Math.min(window.devicePixelRatio, 1.5);
  private slow = 0;
  private blurTween = 0;
  onFrame?: (t: number) => void;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.dpr);
    host.appendChild(this.renderer.domElement);
    this.post = new Post(this.renderer);
    this.walk = new Walk(this.camera);
    window.addEventListener('pointermove', (e) => this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1));
    window.addEventListener('pointerleave', () => this.pointer.set(-10, -10));
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
    this.scene.add(terrain);

    progress(0.3, 'Plantation des arbres');
    await step();
    const trees = plantForest();
    this.stats.trees = trees.length;
    this.scene.add(createForest(trees));
    // ombres peintes pour le soleil de 19 h 50, quand elles sont les plus longues
    setDaylight(0.12);
    const { shadow, forest } = paintGround(trees, world.uSunDir.value.clone());
    world.uShadowMap.value = shadow;
    terrainMat.uniforms.uForest.value = forest;
    setDaylight(0);

    progress(0.55, 'Herbes hautes');
    await step();
    const blades = window.innerWidth < 800 ? 26000 : 52000;
    const grass = createGrass(blades);
    this.stats.blades = (grass.geometry as THREE.InstancedBufferGeometry).instanceCount;
    this.scene.add(grass);

    progress(0.75, 'Ciel, lac et lucioles');
    await step();
    this.scene.add(createSky());
    this.fireflies = createFireflies();
    this.scene.add(this.fireflies);
    this.lake = createLake(this.dpr);
    this.scene.add(this.lake);

    progress(0.9, 'Compilation des matériaux');
    await step();
    this.resize();
    this.walk.update(1);
    await this.renderer.compileAsync(this.scene, this.camera);
    progress(1, 'Prêt');
    this.renderer.setAnimationLoop(() => this.frame());
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
    const t = this.walk.current;
    setDaylight(t);
    world.uTime.value = time;
    this.post.uniforms.uTime.value = time;
    this.post.uniforms.uExposure.value = state.exposure;
    this.post.uniforms.uGrade.value.copy(state.grade);

    // lucioles et lanterne arrivent avec la nuit
    const ff = this.fireflies.material as THREE.ShaderMaterial;
    ff.uniforms.uAmount.value = state.fireflies;
    // taille des lucioles proportionnelle à la hauteur de l'image, quelle que soit la résolution
    ff.uniforms.uPixel.value = this.renderer.getPixelRatio() * (this.host.clientHeight / 760) * 3.2;
    this.updateLantern(dt);

    this.updateRays();

    // le lac ne coûte un second rendu que lorsqu'il est dans le champ
    this.lake.visible = t > 0.8;

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
