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

/** épaule : centre de rotation des ailes, partagé par la géométrie et le shader */
const SHOULDER = [0.075, 0.66, -0.1] as const;

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

  // Corps : une sphère qu'on effile vers l'arrière pour obtenir le fuseau et la pointe de la
  // queue. Une sphère mise à l'échelle donnait une boule, et l'oiseau ressemblait à un bonhomme.
  const body = new THREE.IcosahedronGeometry(0.22, 2);
  const bp = body.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < bp.count; i++) {
    const t = THREE.MathUtils.clamp((bp.getZ(i) + 0.22) / 0.44, 0, 1); // 0 poitrail, 1 queue
    const taper = 1 - THREE.MathUtils.smoothstep(t, 0.42, 1) * 0.86;
    bp.setXYZ(i, bp.getX(i) * 0.8 * taper, bp.getY(i) * 0.92 * taper, bp.getZ(i) * 1.85);
  }
  body.translate(0, 0.63, 0.06);
  tag(body, 0);

  // Cou : un tube continu sur une courbe en S. En boules séparées, on voyait le chapelet.
  const neckCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.72, -0.04),
    new THREE.Vector3(0, 0.86, -0.15),
    new THREE.Vector3(0, 1.02, -0.22),
    new THREE.Vector3(0, 1.16, -0.2),
    new THREE.Vector3(0, 1.24, -0.12),
  ]);
  tag(new THREE.TubeGeometry(neckCurve, 20, 0.04, 7, false), 0);

  const head = new THREE.IcosahedronGeometry(0.068, 1);
  head.scale(0.85, 0.85, 1.35);
  head.translate(0, 1.26, -0.16);
  tag(head, 0);

  // bec : long, droit, en poignard
  const beak = new THREE.ConeGeometry(0.03, 0.34, 6);
  beak.rotateX(-Math.PI / 2);
  beak.rotateX(0.12);
  beak.translate(0, 1.24, -0.38);
  tag(beak, 0);

  // Pattes : cuisse vers l'arrière, tarse vers l'avant, articulation marquée — c'est ce pli qui
  // dit « échassier » plutôt que « figurine sur deux piquets ».
  for (const x of [-0.055, 0.055]) {
    const thigh = new THREE.CylinderGeometry(0.016, 0.014, 0.3, 5);
    thigh.rotateX(-0.28);
    thigh.translate(x, 0.47, 0.11);
    tag(thigh, 0);
    const tarsus = new THREE.CylinderGeometry(0.013, 0.011, 0.36, 5);
    tarsus.rotateX(0.16);
    tarsus.translate(x, 0.16, 0.14);
    tag(tarsus, 0);
    const foot = new THREE.BoxGeometry(0.05, 0.015, 0.14);
    foot.translate(x, 0.005, 0.07);
    tag(foot, 0);
  }

  // Ailes, dessinées déployées : le repli est fait par le shader, qui les ramène le long du
  // flanc au repos et les ouvre à l'envol.
  for (const side of [-1, 1]) {
    const w = new THREE.BufferGeometry();
    const sx = (v: number) => v * side;
    const P = {
      rootFront: [sx(0.075), 0.68, -0.14],
      rootBack: [sx(0.075), 0.64, 0.24],
      midFront: [sx(0.4), 0.7, -0.04],
      midBack: [sx(0.38), 0.67, 0.32],
      tip: [sx(0.84), 0.69, 0.3],
    };
    const tri = side > 0
      ? [P.rootFront, P.midFront, P.midBack, P.rootFront, P.midBack, P.rootBack, P.midFront, P.tip, P.midBack]
      : [P.midBack, P.midFront, P.rootFront, P.rootBack, P.midBack, P.rootFront, P.midBack, P.tip, P.midFront];
    w.setAttribute('position', new THREE.Float32BufferAttribute(tri.flat(), 3));
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
        attribute vec2 aFlap; // x : ouverture de l'aile (0 repliée, 1 en vol), y : phase
        uniform float uTime;
        varying vec3 vWorld;
        varying vec3 vNormal;

        vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
        vec3 rotZ(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }

        void main(){
          vec3 p = position;
          vec3 n = normal;
          if (aWing != 0.0) {
            vec3 shoulder = vec3(${SHOULDER[0].toFixed(3)} * aWing, ${SHOULDER[1].toFixed(2)}, ${SHOULDER[2].toFixed(2)});
            vec3 q = p - shoulder;
            // au repos l'aile est ramenée le long du flanc, pointe vers la queue
            float fold = (1.0 - aFlap.x) * 1.22;
            q = rotY(q, -aWing * fold);
            q *= mix(0.86, 1.0, aFlap.x);
            // en vol : battement lent et ample autour de l'axe du corps
            float beat = sin(uTime * 5.0 + aFlap.y) * 1.15 * aFlap.x;
            q = rotZ(q, aWing * beat);
            n = rotZ(rotY(n, -aWing * fold), aWing * beat);
            p = shoulder + q;
          }
          vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vWorld = w.xyz;
          vNormal = normalize(mat3(instanceMatrix) * n);
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
      this.dummy.scale.setScalar(1.15 * fade);
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
