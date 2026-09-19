import * as THREE from 'three';
import { CLEARING, heightAt, trailDistance } from './terrain';
import { glslNoise, glslWorld, world } from './light';

// Pissenlits de la clairière. Le curseur qui passe sur une tête souffle ses aigrettes :
// elles se détachent, montent en spirale et dérivent avec le vent avant de disparaître.

const HEADS = 70;
const SEEDS = 36;

export class Dandelions {
  readonly group = new THREE.Group();
  private heads: { pos: THREE.Vector3; blown: number }[] = [];
  private headMesh: THREE.InstancedMesh;
  private release: THREE.BufferAttribute;
  private seedMat: THREE.ShaderMaterial;
  private dummy = new THREE.Object3D();
  onBlow?: () => void;

  constructor() {
    let tries = 0;
    while (this.heads.length < HEADS && tries++ < 4000) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * CLEARING.radius * 0.95;
      const x = CLEARING.x + Math.cos(a) * r;
      const z = CLEARING.z + Math.sin(a) * r;
      if (trailDistance(x, z) < 1.6) continue;
      const stem = 0.6 + Math.random() * 0.45;
      this.heads.push({ pos: new THREE.Vector3(x, heightAt(x, z) + stem, z), blown: -1 });
    }

    // tiges : un cylindre fin par fleur, en une seule instance
    const stemGeo = new THREE.CylinderGeometry(0.008, 0.012, 1, 4, 1, true);
    stemGeo.translate(0, -0.5, 0);
    const stemMat = new THREE.ShaderMaterial({
      uniforms: { ...world },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        uniform float uTime;
        void main(){
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${glslNoise}
        ${glslWorld}
        varying vec3 vWorld;
        void main(){
          vec3 col = vec3(0.12, 0.16, 0.06) * (uSunColor * 0.4 + uSkyHorizon * uAmbient);
          gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
        }`,
    });
    const stems = new THREE.InstancedMesh(stemGeo, stemMat, this.heads.length);
    this.heads.forEach((h, i) => {
      this.dummy.position.copy(h.pos);
      this.dummy.scale.set(1, h.pos.y - heightAt(h.pos.x, h.pos.z), 1);
      this.dummy.updateMatrix();
      stems.setMatrixAt(i, this.dummy.matrix);
    });
    stems.frustumCulled = false;
    this.group.add(stems);

    // cœur de la fleur : petite sphère claire, qui rétrécit une fois soufflée
    const headGeo = new THREE.IcosahedronGeometry(0.05, 1);
    const headMat = new THREE.ShaderMaterial({
      uniforms: { ...world },
      vertexShader: stemMat.vertexShader,
      fragmentShader: /* glsl */ `
        ${glslNoise}
        ${glslWorld}
        varying vec3 vWorld;
        void main(){
          vec3 col = vec3(0.55, 0.52, 0.42) * (uSunColor * 0.6 + uSkyHorizon * uAmbient * 1.5);
          gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
        }`,
    });
    this.headMesh = new THREE.InstancedMesh(headGeo, headMat, this.heads.length);
    this.headMesh.frustumCulled = false;
    this.group.add(this.headMesh);

    // aigrettes : points qui forment une boule autour de chaque tête, puis s'envolent
    const n = this.heads.length * SEEDS;
    const origin = new Float32Array(n * 3);
    const dir = new Float32Array(n * 3);
    const release = new Float32Array(n).fill(-1);
    const v = new THREE.Vector3();
    this.heads.forEach((h, i) => {
      for (let s = 0; s < SEEDS; s++) {
        v.randomDirection();
        const k = i * SEEDS + s;
        origin.set([h.pos.x + v.x * 0.16, h.pos.y + v.y * 0.16, h.pos.z + v.z * 0.16], k * 3);
        dir.set([v.x, v.y, v.z], k * 3);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(origin, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    this.release = new THREE.BufferAttribute(release, 1);
    this.release.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aRelease', this.release);
    this.seedMat = new THREE.ShaderMaterial({
      uniforms: { ...world, uPixel: { value: 1 } },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        ${glslNoise}
        attribute vec3 aDir;
        attribute float aRelease;
        uniform float uTime;
        uniform float uPixel;
        varying float vAlpha;
        varying vec3 vWorld;
        void main(){
          vec3 p = position;
          float t = aRelease < 0.0 ? 0.0 : uTime - aRelease;
          if (t > 0.0) {
            // s'écarte de la tête, monte en spirale, dérive avec le vent dominant
            float lift = 1.0 - exp(-t * 0.8);
            p += aDir * lift * 0.5;
            p.y += t * 0.35 + lift * 0.4;
            p.x += t * 0.9 + sin(t * 2.0 + aDir.x * 9.0) * 0.25;
            p.z += sin(t * 1.3 + aDir.z * 7.0) * 0.35 - t * 0.2;
          }
          vAlpha = t > 0.0 ? 1.0 - smoothstep(6.0, 10.0, t) : 1.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uPixel * 5.0 / -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        ${glslNoise}
        ${glslWorld}
        varying float vAlpha;
        varying vec3 vWorld;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          vec3 col = vec3(0.95, 0.93, 0.86) * (uSunColor * 0.5 + uSkyHorizon * 0.8);
          gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), (1.0 - d * 2.0) * vAlpha * 0.9);
        }`,
    });
    const seeds = new THREE.Points(geo, this.seedMat);
    seeds.frustumCulled = false;
    this.group.add(seeds);
    this.layout(0);
  }

  setPixel(p: number) {
    this.seedMat.uniforms.uPixel.value = p;
  }

  // renvoie vrai si le curseur survole une fleur encore intacte
  update(time: number, ray: THREE.Ray | null) {
    let hover = false;
    if (ray) {
      this.heads.forEach((h, i) => {
        if (h.blown >= 0 && time - h.blown < 25) return;
        if (ray.distanceSqToPoint(h.pos) > 0.45 * 0.45) return;
        hover = true;
        this.blow(i, time);
      });
    }
    // les fleurs repoussent un peu plus tard : on peut souffler de nouveau au retour
    this.heads.forEach((h, i) => {
      if (h.blown >= 0 && time - h.blown > 25) {
        h.blown = -1;
        for (let s = 0; s < SEEDS; s++) this.release.setX(i * SEEDS + s, -1);
        this.release.needsUpdate = true;
      }
    });
    this.layout(time);
    return hover;
  }

  private blow(i: number, time: number) {
    this.heads[i].blown = time;
    for (let s = 0; s < SEEDS; s++) this.release.setX(i * SEEDS + s, time + Math.random() * 0.4);
    this.release.needsUpdate = true;
    this.onBlow?.();
  }

  private layout(time: number) {
    this.heads.forEach((h, i) => {
      const bald = h.blown >= 0 ? Math.min(1, (time - h.blown) * 2) : 0;
      this.dummy.position.copy(h.pos);
      this.dummy.scale.setScalar(1 - bald * 0.55);
      this.dummy.updateMatrix();
      this.headMesh.setMatrixAt(i, this.dummy.matrix);
    });
    this.headMesh.instanceMatrix.needsUpdate = true;
  }
}
