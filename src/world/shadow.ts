import * as THREE from 'three';
import { world } from './light';

// Ombres portées du soleil. Une caméra orthographique regarde la scène depuis le soleil et
// enregistre la profondeur des arbres proches ; les matériaux comparent ensuite leur propre
// profondeur à cette carte. La zone couverte suit le promeneur, et seuls les arbres à portée
// sont redessinés, pour que la passe reste légère.

const SIZE = 2048;
const RANGE = 46; // demi-largeur couverte, en mètres
const REBUILD = 12; // on refait la liste des arbres proches tous les 12 m

export interface Caster {
  /** géométrie et attributs partagés avec l'arbre visible */
  source: THREE.InstancedMesh;
  /** positions des instances, pour ne garder que celles qui sont à portée */
  points: THREE.Vector3[];
}

export class SunShadow {
  readonly target: THREE.WebGLRenderTarget;
  private cam = new THREE.OrthographicCamera(-RANGE, RANGE, RANGE, -RANGE, 0.5, 420);
  private scene = new THREE.Scene();
  private near: { mesh: THREE.InstancedMesh; caster: Caster }[] = [];
  private lastBuild = new THREE.Vector3(1e6, 0, 0);
  private lastSun = new THREE.Vector3();
  private sun = new THREE.Vector3();
  private center = new THREE.Vector3();
  private matrix = new THREE.Matrix4();

  constructor(casters: Caster[]) {
    const depth = new THREE.DepthTexture(SIZE, SIZE, THREE.FloatType);
    this.target = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthTexture: depth, depthBuffer: true });
    this.target.texture.generateMipmaps = false;

    for (const caster of casters) {
      // même géométrie, matériau réduit à la profondeur : le vent est repris pour que l'ombre suive
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: world.uTime, uWind: world.uWind },
        vertexShader: /* glsl */ `
          attribute float aHeight;
          attribute vec2 aVar;
          uniform float uTime;
          uniform float uWind;
          void main(){
            vec3 p = position;
            float sway = aHeight * aHeight * uWind;
            p.x += sin(uTime * 0.9 + aVar.y * 6.28) * 0.18 * sway;
            p.z += cos(uTime * 0.7 + aVar.y * 4.1) * 0.12 * sway;
            gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: `void main(){ gl_FragColor = vec4(1.0); }`,
        side: THREE.DoubleSide,
      });
      // géométrie propre à la passe d'ombre : mêmes triangles, mais ses propres attributs d'instance
      const geo = caster.source.geometry.clone();
      geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(new Float32Array(caster.points.length * 2), 2));
      const mesh = new THREE.InstancedMesh(geo, mat, caster.points.length);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
      this.near.push({ mesh, caster });
    }
    world.uShadowMapSun.value = depth;
  }

  update(renderer: THREE.WebGLRenderer, camera: THREE.Camera, sunDir: THREE.Vector3) {
    if (sunDir.y < 0.01) {
      world.uSunShadowStrength.value = 0;
      return;
    }
    // la zone couverte se place devant le promeneur
    const forward = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    this.center.copy(camera.position).addScaledVector(forward, RANGE * 0.45);
    this.center.y = 0;

    // on refait la sélection quand le promeneur avance, ou quand le soleil a tourné
    this.sun.copy(sunDir);
    if (this.center.distanceTo(this.lastBuild) > REBUILD || this.sun.distanceTo(this.lastSun) > 0.03) {
      this.lastBuild.copy(this.center);
      this.lastSun.copy(this.sun);
      this.collect();
    }

    this.cam.position.copy(this.center).addScaledVector(sunDir, 210);
    this.cam.lookAt(this.center);
    this.cam.updateMatrixWorld();
    this.cam.updateProjectionMatrix();
    this.matrix.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse);
    world.uSunMatrix.value.copy(this.matrix);
    world.uSunShadowStrength.value = THREE.MathUtils.smoothstep(sunDir.y, 0.01, 0.06);

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
  }

  // ne garde que les arbres proches : la passe d'ombre dessine quelques centaines d'instances, pas des milliers
  private collect() {
    const m = new THREE.Matrix4();
    const reach = RANGE * 1.3;
    const d = new THREE.Vector3();
    // un arbre compte s'il est proche de la zone couverte « de côté » ; il peut être loin dans l'axe
    // du soleil, puisque c'est de là que vient l'ombre (au ras de l'horizon, elle fait 100 m).
    const inFrustum = (p: THREE.Vector3) => {
      d.copy(p).sub(this.center);
      const along = d.dot(this.sun);
      if (along < -12 || along > 150) return false;
      d.addScaledVector(this.sun, -along);
      return Math.abs(d.x) < reach && Math.abs(d.z) < reach && Math.abs(d.y) < 90;
    };
    for (const { mesh, caster } of this.near) {
      const src = caster.source.geometry.getAttribute('aVar') as THREE.InstancedBufferAttribute | null;
      const dst = mesh.geometry.getAttribute('aVar') as THREE.InstancedBufferAttribute;
      let n = 0;
      caster.points.forEach((p, i) => {
        if (!inFrustum(p)) return;
        caster.source.getMatrixAt(i, m);
        mesh.setMatrixAt(n, m);
        if (src) dst.setXY(n, src.getX(i), src.getY(i));
        n++;
      });
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      dst.needsUpdate = true;
    }
  }
}
