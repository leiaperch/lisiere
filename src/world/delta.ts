import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { glslNoise, glslWorld, world } from './light';

// Le delta de la rivière, au bout du marais.
//
// Ce n'est plus une eau dormante mais une eau qui court et qui se divise : un bras principal, un
// bras mort, et l'aulnaie qui pousse les pieds dedans, en cépées de plusieurs troncs partant de la
// même souche. C'est la ripisylve — la forêt qui suit l'eau.

export const DELTA = { level: -4.6, half: 4.2, bank: 9, depth: 1.5 };

const branchCurve = (pts: [number, number][]) =>
  new THREE.CatmullRomCurve3(
    pts.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'catmullrom',
    0.5
  );

/** deux bras : le courant principal, et un bras mort qui s'en détache puis s'élargit */
export const CHANNELS = [
  branchCurve([
    [62, -196],
    [84, -199],
    [106, -195],
    [128, -188],
    [150, -178],
  ]),
  branchCurve([
    [96, -196],
    [112, -204],
    [130, -207],
    [150, -204],
  ]),
];

const samples = CHANNELS.map((c) => c.getSpacedPoints(90));

/** distance au bras le plus proche */
export function deltaDistance(x: number, z: number) {
  let best = Infinity;
  for (const pts of samples) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

export const DELTA_REACH = DELTA.bank;

/** profil du lit : fond plat, berge concave, puis la rive */
export function deltaProfile(d: number, ground: number) {
  const floor = DELTA.level - DELTA.depth;
  if (d <= DELTA.half) return floor;
  if (d >= DELTA.bank) return ground;
  const t = (d - DELTA.half) / (DELTA.bank - DELTA.half);
  return floor + t * t * (ground - floor);
}

function ribbon(curve: THREE.CatmullRomCurve3, groundAt: (x: number, z: number) => number) {
  const steps = 110;
  const pos: number[] = [];
  const edge: number[] = [];
  const section: [number, number][] = [
    [-DELTA.bank, 1],
    [-DELTA.half * 1.45, 0.5],
    [-DELTA.half, 0],
    [DELTA.half, 0],
    [DELTA.half * 1.45, 0.5],
    [DELTA.bank, 1],
  ];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  const at = (u: number, off: number, e: number) => {
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    const x = p.x - t.z * off;
    const z = p.z + t.x * off;
    const y = e >= 1 ? groundAt(x, z) : deltaProfile(Math.abs(off), groundAt(x, z));
    return [x, y, z] as [number, number, number];
  };
  for (let i = 0; i < steps; i++) {
    const u0 = i / steps;
    const u1 = (i + 1) / steps;
    for (let k = 0; k < section.length - 1; k++) {
      const [o0, e0] = section[k];
      const [o1, e1] = section[k + 1];
      const a = at(u0, o0, e0);
      const b = at(u1, o0, e0);
      const c = at(u1, o1, e1);
      const d = at(u0, o1, e1);
      pos.push(...a, ...c, ...b, ...a, ...d, ...c);
      edge.push(e0, e1, e0, e0, e1, e1);
    }
  }
  const raw = new THREE.BufferGeometry();
  raw.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  raw.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  const geo = mergeVertices(raw, 1e-4);
  geo.computeVertexNormals();
  return geo;
}

/** les berges des deux bras */
export function createDeltaBanks(groundAt: (x: number, z: number) => number) {
  const geo = mergeGeometries(CHANNELS.map((c) => ribbon(c, groundAt)))!;
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aEdge;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vEdge;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vEdge = aEdge;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vEdge;
      void main(){
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        float grain = fbm(vWorld.xz * 1.3);
        // limon noir au fond, terre et racines sur la berge
        vec3 silt = mix(vec3(0.06, 0.06, 0.05), vec3(0.12, 0.11, 0.09), grain);
        vec3 bank = mix(vec3(0.14, 0.13, 0.09), vec3(0.22, 0.20, 0.13), grain);
        vec3 albedo = mix(silt, bank, smoothstep(0.15, 0.85, vEdge));
        float ndl = max(dot(n, uSunDir), 0.0);
        float shadow = sunShadow(vWorld, ndl);
        float sky = mix(0.4, 1.0, vEdge);
        vec3 col = albedo * (uSunColor * ndl * shadow * sky + mix(uSkyHorizon, uSkyTop, 0.4) * uAmbient * sky + lantern(vWorld, n));
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'delta-berges';
  return mesh;
}

/** l'eau des bras : elle court, donc elle se ride dans le sens du courant */
export function createDeltaWater() {
  const pos: number[] = [];
  const flow: number[] = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (const curve of CHANNELS) {
    const steps = 110;
    for (let i = 0; i < steps; i++) {
      const u0 = i / steps;
      const u1 = (i + 1) / steps;
      const at = (u: number, off: number) => {
        curve.getPointAt(u, p);
        curve.getTangentAt(u, t);
        return [p.x - t.z * off, DELTA.level, p.z + t.x * off] as [number, number, number];
      };
      const w = DELTA.half * 0.92;
      const a = at(u0, -w);
      const b = at(u1, -w);
      const c = at(u1, w);
      const d = at(u0, w);
      pos.push(...a, ...c, ...b, ...a, ...d, ...c);
      curve.getTangentAt((u0 + u1) / 2, t);
      for (let k = 0; k < 6; k++) flow.push(t.x, t.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec2 aFlow;
      varying vec3 vWorld;
      varying vec2 vFlow;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vFlow = aFlow;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec2 vFlow;
      void main(){
        vec3 v = normalize(cameraPosition - vWorld);
        // les rides glissent dans le sens du courant, et s'étirent le long du bras
        vec2 q = vWorld.xz - vFlow * uTime * 0.9;
        float r1 = fbm(q * 0.9);
        float r2 = fbm(q * 2.4 + 11.0);
        vec3 n = normalize(vec3((r1 - 0.5) * 0.3, 1.0, (r2 - 0.5) * 0.3));
        float fresnel = 0.07 + 0.93 * pow(1.0 - max(dot(n, v), 0.0), 4.0);
        vec3 col = mix(vec3(0.020, 0.026, 0.022), mix(uSkyHorizon, uSkyTop, 0.3) * 0.85, fresnel);
        vec3 refl = reflect(-v, n);
        col += uSunColor * pow(max(dot(refl, uSunDir), 0.0), 90.0) * 0.7;
        col += uSkyHorizon * pow(max(dot(refl, uMoonDir), 0.0), 70.0) * uMoon * 1.4;
        col += lantern(vWorld, n) * 0.6;
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'delta-eau';
  return mesh;
}

// ───────────── l'aulnaie ─────────────

let seed = 4242;
const rand = () => {
  seed = (seed * 48271) % 2147483647;
  return (seed - 1) / 2147483646;
};

/** une cépée d'aulne : plusieurs troncs partant de la même souche, penchés vers la lumière */
function alderGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const stems = 4;
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * Math.PI * 2 + rand() * 0.6;
    const lean = 0.1 + rand() * 0.16;
    const h = 6.5 + rand() * 3;
    const trunk = new THREE.CylinderGeometry(0.11, 0.24, h, 6, 1, true);
    trunk.translate(0, h / 2, 0);
    trunk.rotateZ(Math.cos(a) * lean);
    trunk.rotateX(-Math.sin(a) * lean);
    trunk.translate(Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3);
    parts.push(trunk.toNonIndexed());

    const top = h * 0.9;
    for (let k = 0; k < 3; k++) {
      const r = 1.5 + rand() * 0.9;
      const crown = new THREE.IcosahedronGeometry(r, 1);
      crown.scale(1, 0.8, 1);
      crown.translate(
        Math.cos(a) * (lean * top + (rand() - 0.5) * 1.6),
        top + (rand() - 0.4) * 1.8,
        Math.sin(a) * (lean * top + (rand() - 0.5) * 1.6)
      );
      parts.push(crown.toNonIndexed());
    }
  }
  const geo = mergeGeometries(parts)!;
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const hMax = geo.boundingBox!.max.y;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const rel = new Float32Array(pos.count);
  const leafy = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    rel[i] = THREE.MathUtils.clamp(pos.getY(i) / hMax, 0, 1);
    leafy[i] = rel[i] > 0.62 ? 1 : 0;
  }
  geo.setAttribute('aHeight', new THREE.BufferAttribute(rel, 1));
  geo.setAttribute('aLeaf', new THREE.BufferAttribute(leafy, 1));
  return geo;
}

export function createAlders(groundAt: (x: number, z: number) => number) {
  const spots: [number, number, number][] = [];
  for (const curve of CHANNELS) {
    const n = 34;
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const p = curve.getPointAt(u);
      const t = curve.getTangentAt(u);
      for (const side of [-1, 1]) {
        // certains ont les pieds dans l'eau, d'autres sont sur la berge
        const off = side * (DELTA.half * 0.85 + rand() * 9);
        const x = p.x - t.z * off + (rand() - 0.5) * 2.5;
        const z = p.z + t.x * off + (rand() - 0.5) * 2.5;
        if (rand() > 0.62) continue;
        spots.push([x, Math.min(groundAt(x, z), DELTA.level + 0.2) - 0.2, z]);
      }
    }
  }

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aHeight;
      attribute float aLeaf;
      attribute vec2 aVar;
      uniform float uTime;
      uniform float uWind;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vHeight;
      varying float vLeaf;
      varying vec2 vVar;
      void main(){
        vec3 p = position;
        float sway = aHeight * aHeight * uWind * aLeaf;
        p.x += sin(uTime * 0.8 + aVar.y * 6.28) * 0.22 * sway;
        p.z += cos(uTime * 0.6 + aVar.y * 4.1) * 0.16 * sway;
        vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(instanceMatrix) * normal);
        vHeight = aHeight;
        vLeaf = aLeaf;
        vVar = aVar;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vHeight;
      varying float vLeaf;
      varying vec2 vVar;
      void main(){
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 v = normalize(cameraPosition - vWorld);
        float grain = fbm(vWorld.xz * 1.7 + vVar.x * 7.0);
        // l'aulne a une écorce presque noire, et un feuillage sombre et dense
        vec3 bark = mix(vec3(0.07, 0.06, 0.05), vec3(0.16, 0.14, 0.11), grain);
        vec3 leaf = mix(vec3(0.08, 0.14, 0.06), vec3(0.17, 0.25, 0.09), grain * 0.6 + vVar.x * 0.4);
        vec3 albedo = mix(bark, leaf, vLeaf);
        float wrap = pow(max(dot(n, uSunDir) * 0.5 + 0.5, 0.0), 1.9);
        float ao = mix(0.32, 1.0, smoothstep(0.1, 0.85, vHeight));
        float back = pow(max(dot(-v, uSunDir), 0.0), 4.0) * vLeaf;
        float shadow = sunShadow(vWorld, dot(n, uSunDir));
        vec3 sun = uSunColor * (wrap * ao * shadow * 0.7 + back * 0.8 * vec3(1.0, 0.85, 0.5) * shadow);
        vec3 amb = mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient * ao;
        vec3 col = albedo * (sun + amb + lantern(vWorld, n));
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });

  const geo = alderGeometry();
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const dummy = new THREE.Object3D();
  const variation = new Float32Array(spots.length * 2);
  spots.forEach(([x, y, z], i) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rand() * Math.PI * 2, 0);
    dummy.scale.setScalar(0.65 + rand() * 0.5);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    variation[i * 2] = rand();
    variation[i * 2 + 1] = (x * 0.11 + z * 0.07) % 1;
  });
  geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(variation, 2));
  mesh.frustumCulled = false;
  mesh.name = 'aulnes';
  return { mesh, count: spots.length };
}
