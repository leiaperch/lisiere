import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAKE, heightAt, pathPoint } from './terrain';
import { CRASTE, CRASTE_DIR } from './craste';
import { glslNoise, glslWorld, world } from './light';

// Les aigrettes du marais. Elles se tiennent immobiles dans l'eau, le cou replié, et décollent
// lentement quand on approche : de grands coups d'aile, pas le départ nerveux des passereaux du
// sous-bois. C'est l'image du Teich, et à cette heure-ci ce sont les seules taches claires du
// paysage.

interface Egret {
  home: THREE.Vector3;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  heading: number;
  state: 'posee' | 'envol';
  timer: number;
  phase: number;
  flap: number;
}

const COUNT = 6;

function geometry() {
  const parts: THREE.BufferGeometry[] = [];
  // les primitives de three ne sont pas toutes indexées : on les ramène toutes au même format
  // avant de les fusionner, sinon mergeGeometries refuse le mélange
  const tag = (geo: THREE.BufferGeometry, wing: number) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    g.setAttribute('aWing', new THREE.BufferAttribute(new Float32Array(n).fill(wing), 1));
    parts.push(g);
  };

  // corps : un fuseau allongé, porté haut sur les pattes
  const body = new THREE.IcosahedronGeometry(0.2, 1);
  body.scale(1, 0.85, 2.0);
  body.translate(0, 0.62, 0);
  tag(body, 0);

  // cou en S : une suite de segments qui remontent puis avancent
  const neck: [number, number, number][] = [
    [0, 0.78, -0.16],
    [0, 0.94, -0.26],
    [0, 1.08, -0.3],
    [0, 1.18, -0.24],
    [0, 1.22, -0.14],
  ];
  for (const [x, y, z] of neck) {
    const s = new THREE.IcosahedronGeometry(0.055, 0);
    s.translate(x, y, z);
    tag(s, 0);
  }
  const head = new THREE.IcosahedronGeometry(0.075, 1);
  head.scale(1, 1, 1.35);
  head.translate(0, 1.24, -0.06);
  tag(head, 0);
  const beak = new THREE.ConeGeometry(0.035, 0.28, 5);
  beak.rotateX(-Math.PI / 2);
  beak.translate(0, 1.23, -0.22);
  tag(beak, 0);

  // pattes : deux fils, à peine visibles mais qui donnent la hauteur
  for (const x of [-0.06, 0.06]) {
    const leg = new THREE.CylinderGeometry(0.014, 0.012, 0.62, 4);
    leg.translate(x, 0.31, 0.04);
    tag(leg, 0);
  }

  // ailes : deux longues plaques, repliées au repos, qui pivotent à l'envol
  for (const side of [-1, 1]) {
    const w = new THREE.BufferGeometry();
    const tip = 0.78 * side;
    const pos = new Float32Array([
      0.05 * side, 0.66, -0.16,
      tip, 0.7, 0.06,
      0.05 * side, 0.64, 0.3,
      0.05 * side, 0.66, -0.16,
      0.05 * side, 0.64, 0.3,
      tip * 0.55, 0.68, 0.34,
    ]);
    w.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    w.computeVertexNormals();
    tag(w, side);
  }

  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}

export class Egrets {
  readonly mesh: THREE.InstancedMesh;
  private birds: Egret[] = [];
  private flapAttr: THREE.InstancedBufferAttribute;
  private dummy = new THREE.Object3D();
  private tmp = new THREE.Vector3();
  onTakeOff?: () => void;

  constructor() {
    const p = new THREE.Vector3();
    const side = new THREE.Vector2(-CRASTE_DIR.y, CRASTE_DIR.x);
    for (let i = 0; i < COUNT; i++) {
      let x: number;
      let z: number;
      let y: number;
      if (i < 3) {
        // dans la craste, les pattes dans l'eau
        const t = 0.3 + i * 0.16 + Math.random() * 0.08;
        x = CRASTE.a.x + (CRASTE.b.x - CRASTE.a.x) * t + side.x * (Math.random() - 0.5) * 1.4;
        z = CRASTE.a.y + (CRASTE.b.y - CRASTE.a.y) * t + side.y * (Math.random() - 0.5) * 1.4;
        y = CRASTE.level - 0.15;
      } else if (i < 5) {
        // sur la rive de l'étang
        const a = Math.PI * (0.6 + Math.random() * 0.5);
        x = LAKE.x + Math.cos(a) * LAKE.radius * 0.96;
        z = LAKE.z + Math.sin(a) * LAKE.radius * 0.96;
        y = LAKE.level - 0.1;
      } else {
        // une isolée, plus près du sentier, pour qu'on en croise une de près
        pathPoint('marais', 0.72, p);
        x = p.x + 7 + Math.random() * 4;
        z = p.z + (Math.random() - 0.5) * 6;
        y = heightAt(x, z) + 0.02;
      }
      const home = new THREE.Vector3(x, y, z);
      this.birds.push({ home, pos: home.clone(), vel: new THREE.Vector3(), heading: Math.random() * 6.28, state: 'posee', timer: Math.random() * 6, phase: Math.random() * 10, flap: 0 });
    }

    const geo = geometry();
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
          // battement lent et ample : une aigrette ne bat pas comme un moineau
          float a = sin(uTime * 5.5 + aFlap.y) * 1.25 * aFlap.x - (1.0 - aFlap.x) * 0.15;
          if (aWing != 0.0) {
            float span = abs(p.x) - 0.05;
            p.y += sin(a) * span;
            p.x = sign(p.x) * (0.05 + cos(a) * span);
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
          if (!gl_FrontFacing) n = -n;
          vec3 v = normalize(cameraPosition - vWorld);
          // plumage blanc : il ne s'éteint jamais complètement, c'est ce qui le fait ressortir
          vec3 albedo = vec3(0.93, 0.92, 0.88);
          float wrap = pow(max(dot(n, uSunDir) * 0.5 + 0.5, 0.0), 1.4);
          float back = pow(max(dot(-v, uSunDir), 0.0), 3.0);
          vec3 col = albedo * (uSunColor * wrap * 0.5 + mix(uSkyHorizon, uSkyTop, 0.5) * uAmbient * 1.6 + lantern(vWorld, n));
          col += uSunColor * back * 0.35 * albedo;
          gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'aigrettes';
  }

  /** renvoie vrai si le curseur survole une aigrette encore posée */
  update(dt: number, time: number, camera: THREE.Camera, ray: THREE.Ray | null) {
    let hover = false;
    let flushed = false;
    for (const b of this.birds) {
      b.timer += dt;
      if (b.state === 'posee') {
        const near = b.pos.distanceTo(camera.position) < 15;
        const pointed = !!ray && ray.distanceSqToPoint(b.pos) < 1.6 * 1.6 && b.pos.distanceTo(camera.position) < 60;
        if (pointed) hover = true;
        if (near || pointed) {
          this.takeOff(b, camera.position);
          flushed = true;
        } else {
          // guet : le corps reste immobile, seul le cap dérive très lentement
          b.heading += Math.sin(time * 0.3 + b.phase) * dt * 0.25;
          b.pos.y = b.home.y + Math.sin(time * 0.8 + b.phase) * 0.012;
          b.flap += (0 - b.flap) * Math.min(1, dt * 5);
        }
      } else {
        // envol : lourd au départ, puis un vol plané bas au-dessus de l'eau
        b.vel.y += (b.timer < 2 ? 4.2 : 0.6) * dt;
        b.vel.x += Math.sin(time * 0.7 + b.phase) * dt * 1.2;
        b.vel.clampLength(0, 8);
        b.pos.addScaledVector(b.vel, dt);
        b.heading = Math.atan2(b.vel.x, b.vel.z) + Math.PI;
        b.flap += (1 - b.flap) * Math.min(1, dt * 4);
        if (b.timer > 16 && camera.position.distanceTo(b.home) > 55) {
          b.state = 'posee';
          b.pos.copy(b.home);
          b.vel.set(0, 0, 0);
          b.timer = 0;
        }
      }
    }
    if (flushed) this.onTakeOff?.();

    this.birds.forEach((b, i) => {
      this.dummy.position.copy(b.pos);
      this.dummy.rotation.set(b.state === 'envol' ? -0.12 : 0, b.heading, 0);
      const fade = b.state === 'envol' && b.timer > 12 ? Math.max(0, 1 - (b.timer - 12) / 3) : 1;
      this.dummy.scale.setScalar(1.35 * fade);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.flapAttr.setXY(i, b.flap, b.phase);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flapAttr.needsUpdate = true;
    return hover;
  }

  private takeOff(b: Egret, from: THREE.Vector3) {
    b.state = 'envol';
    b.timer = 0;
    this.tmp.copy(b.pos).sub(from).setY(0).normalize();
    b.vel.set(this.tmp.x * 2.6 + (Math.random() - 0.5) * 1.5, 1.6, this.tmp.z * 2.6 + (Math.random() - 0.5) * 1.5);
  }
}
