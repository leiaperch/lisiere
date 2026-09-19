import * as THREE from 'three';
import { heightAt, trailPoint } from './terrain';
import { glslNoise, glslWorld, world } from './light';

// Oiseaux posés au bord du sentier. Ils picorent ; quand le promeneur approche ou que le curseur
// passe sur eux, ils s'envolent ensemble, s'éloignent en montant, puis reviennent se poser plus tard.

interface Bird {
  home: THREE.Vector3;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  heading: number;
  state: 'perched' | 'flying';
  timer: number; // temps écoulé dans l'état
  phase: number;
  flap: number; // 0 ailes repliées → 1 battement franc
}

const COUNT = 22;

function birdGeometry() {
  // corps en losange allongé, deux ailes triangulaires ; aWing : 0 corps, −1 aile gauche, +1 aile droite
  const pos: number[] = [];
  const wing: number[] = [];
  const tri = (a: number[], b: number[], c: number[], w: number) => {
    pos.push(...a, ...b, ...c);
    wing.push(w, w, w);
  };
  const nose = [0, 0.02, -0.16];
  const tail = [0, 0.03, 0.16];
  const top = [0, 0.08, 0];
  const bottom = [0, -0.04, 0];
  const l = [-0.05, 0.02, 0];
  const r = [0.05, 0.02, 0];
  for (const [a, b] of [
    [top, l],
    [r, top],
    [l, bottom],
    [bottom, r],
  ]) {
    tri(nose, a, b, 0);
    tri(tail, b, a, 0);
  }
  tri([-0.04, 0.04, -0.05], [-0.3, 0.05, 0.02], [-0.04, 0.04, 0.07], -1);
  tri([0.04, 0.04, -0.05], [0.04, 0.04, 0.07], [0.3, 0.05, 0.02], 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  g.computeVertexNormals();
  return g;
}

export class Birds {
  readonly mesh: THREE.InstancedMesh;
  private birds: Bird[] = [];
  private flapAttr: THREE.InstancedBufferAttribute;
  private dummy = new THREE.Object3D();
  private tmp = new THREE.Vector3();
  onTakeOff?: () => void;

  constructor() {
    const p = new THREE.Vector3();
    for (let i = 0; i < COUNT; i++) {
      // petits groupes posés dans la prairie et au début du sous-bois
      const group = Math.floor(i / 5);
      const u = 0.035 + group * 0.055 + Math.random() * 0.02;
      trailPoint(u, p);
      const side = (group % 2 ? 1 : -1) * (2.2 + Math.random() * 3.5);
      const x = p.x + side;
      const z = p.z + (Math.random() - 0.5) * 3;
      const home = new THREE.Vector3(x, heightAt(x, z) + 0.05, z);
      this.birds.push({ home, pos: home.clone(), vel: new THREE.Vector3(), heading: Math.random() * 6.28, state: 'perched', timer: Math.random() * 5, phase: Math.random() * 10, flap: 0 });
    }
    const geo = birdGeometry();
    this.flapAttr = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 2), 2);
    geo.setAttribute('aFlap', this.flapAttr);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...world },
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aWing;
        attribute vec2 aFlap; // x : amplitude du battement, y : phase
        uniform float uTime;
        varying vec3 vWorld;
        varying vec3 vNormal;
        void main(){
          vec3 p = position;
          // l'aile pivote autour de son attache sur le corps
          float a = sin(uTime * 22.0 + aFlap.y) * 1.1 * aFlap.x + (1.0 - aFlap.x) * -0.2;
          if (aWing != 0.0) {
            float span = abs(p.x) - 0.04;
            p.y += sin(a) * span * 1.0;
            p.x = sign(p.x) * (0.04 + cos(a) * span);
          }
          vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
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
          vec3 v = normalize(cameraPosition - vWorld);
          vec3 albedo = vec3(0.08, 0.06, 0.05);
          float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);
          float rim = pow(1.0 - abs(dot(n, v)), 3.0);
          vec3 col = albedo * (uSunColor * wrap * 0.6 + uSkyHorizon * uAmbient) + uSunColor * rim * 0.25;
          gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    this.mesh.frustumCulled = false;
  }

  // ray : rayon du curseur ; renvoie vrai si le curseur survole un oiseau posé
  update(dt: number, time: number, camera: THREE.Camera, ray: THREE.Ray | null) {
    let hover = false;
    let scare: THREE.Vector3 | null = null;
    for (const b of this.birds) {
      if (b.state !== 'perched') continue;
      const near = b.pos.distanceTo(camera.position) < 6.5;
      const pointed = !!ray && ray.distanceSqToPoint(b.pos) < 0.9 * 0.9 && b.pos.distanceTo(camera.position) < 40;
      if (pointed) hover = true;
      if (near || pointed) {
        scare = b.pos;
        break;
      }
    }
    // un oiseau effrayé fait partir tout son groupe
    if (scare) {
      let flushed = false;
      for (const b of this.birds) {
        if (b.state === 'perched' && b.pos.distanceTo(scare) < 7) {
          this.takeOff(b, camera.position);
          flushed = true;
        }
      }
      if (flushed) this.onTakeOff?.();
    }

    this.birds.forEach((b, i) => {
      b.timer += dt;
      if (b.state === 'perched') {
        // picore : petits bonds et changements de direction
        const hop = Math.max(0, Math.sin(time * 3 + b.phase)) ** 12;
        b.pos.y = b.home.y + hop * 0.12;
        if (hop > 0.95) b.heading += (Math.random() - 0.5) * 0.4;
        b.flap += (0 - b.flap) * Math.min(1, dt * 8);
      } else {
        // vol : monte, s'éloigne, ondule, puis revient se poser quand le promeneur est loin
        b.vel.y += (b.timer < 1.2 ? 9 : 1.5) * dt;
        b.vel.x += Math.sin(time * 1.3 + b.phase) * dt * 2;
        b.vel.clampLength(0, 11);
        b.pos.addScaledVector(b.vel, dt);
        b.heading = Math.atan2(b.vel.x, b.vel.z) + Math.PI;
        b.flap += (1 - b.flap) * Math.min(1, dt * 10);
        if (b.timer > 12 && camera.position.distanceTo(b.home) > 45) {
          b.state = 'perched';
          b.pos.copy(b.home);
          b.vel.set(0, 0, 0);
          b.timer = 0;
        }
      }
      this.dummy.position.copy(b.pos);
      this.dummy.rotation.set(b.state === 'flying' ? -0.25 : 0, b.heading, 0);
      this.dummy.scale.setScalar(1.5 * (b.state === 'flying' && b.timer > 9 ? Math.max(0, 1 - (b.timer - 9) / 2) : 1));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.flapAttr.setXY(i, b.flap, b.phase);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flapAttr.needsUpdate = true;
    return hover;
  }

  private takeOff(b: Bird, from: THREE.Vector3) {
    b.state = 'flying';
    b.timer = Math.random() * 0.25;
    this.tmp.copy(b.pos).sub(from).setY(0).normalize();
    b.vel.set(this.tmp.x * 4 + (Math.random() - 0.5) * 3, 3 + Math.random() * 2, this.tmp.z * 4 + (Math.random() - 0.5) * 3);
  }
}
