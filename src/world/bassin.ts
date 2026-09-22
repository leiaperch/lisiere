import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { glslNoise, glslWorld, world } from './light';

// Le bassin, de l'autre côté de la flèche de sable.
//
// Trois choses le signent : l'estey, ce ruisseau de marée qui serpente sur le schorre et se vide
// quand la mer se retire ; les pignots, ces alignements de piquets plantés dans l'eau qui
// délimitent les parcs à huîtres ; et la cabane tchanquée, montée sur ses échasses — du gascon
// « chancas ». On les voit à contre-jour, sur une eau qui ne bouge presque pas.

/** la lagune : centre au large, le sentier s'arrête sur sa rive */
export const BASSIN = { x: 165, z: -315, radius: 105, level: -2.5 };

// ───────────── l'estey ─────────────

export const ESTEY_CURVE = new THREE.CatmullRomCurve3(
  ([
    [6, -208],
    [24, -222],
    [40, -230],
    [54, -241],
    [70, -251],
    [88, -264],
  ] as [number, number][]).map(([x, z]) => new THREE.Vector3(x, 0, z)),
  false,
  'catmullrom',
  0.5
);

const ESTEY = { half: 2.6, bank: 6.5, depth: 1.35 };
const esteySamples = ESTEY_CURVE.getSpacedPoints(120);

/** distance horizontale à l'axe de l'estey ; au-delà des bouts, il n'existe plus */
export function esteyDistance(x: number, z: number) {
  let best = Infinity;
  for (let i = 0; i < esteySamples.length; i++) {
    const p = esteySamples[i];
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** profil du lit : fond plat, talus de vase, puis le schorre */
export function esteyProfile(d: number, ground: number) {
  const floor = BASSIN.level - ESTEY.depth;
  if (d <= ESTEY.half) return floor;
  if (d >= ESTEY.bank) return ground;
  const t = (d - ESTEY.half) / (ESTEY.bank - ESTEY.half);
  return floor + t * t * (ground - floor); // berge concave, creusée par le courant
}

export const ESTEY_REACH = ESTEY.bank;

/**
 * Le lit de l'estey, en géométrie propre — même raison que pour la craste : un chenal de cinq
 * mètres ne tient pas dans une grille de deux, il faut le dessiner à part.
 */
export function createEstey(groundAt: (x: number, z: number) => number) {
  const steps = 130;
  const pos: number[] = [];
  const edge: number[] = [];
  const section: [number, number][] = [
    [-ESTEY.bank, 1],
    [-ESTEY.half * 1.55, 0.55],
    [-ESTEY.half, 0],
    [ESTEY.half, 0],
    [ESTEY.half * 1.55, 0.55],
    [ESTEY.bank, 1],
  ];
  const tmpP = new THREE.Vector3();
  const tmpT = new THREE.Vector3();
  const at = (t: number, off: number, e: number) => {
    ESTEY_CURVE.getPointAt(t, tmpP);
    ESTEY_CURVE.getTangentAt(t, tmpT);
    const x = tmpP.x - tmpT.z * off;
    const z = tmpP.z + tmpT.x * off;
    const y = e >= 1 ? groundAt(x, z) : esteyProfile(Math.abs(off), groundAt(x, z));
    return [x, y, z] as [number, number, number];
  };
  const push = (p: [number, number, number], e: number) => {
    pos.push(p[0], p[1], p[2]);
    edge.push(e);
  };
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    for (let k = 0; k < section.length - 1; k++) {
      const [o0, e0] = section[k];
      const [o1, e1] = section[k + 1];
      const a = at(t0, o0, e0);
      const b = at(t1, o0, e0);
      const c = at(t1, o1, e1);
      const d = at(t0, o1, e1);
      push(a, e0); push(c, e1); push(b, e0);
      push(a, e0); push(d, e1); push(c, e1);
    }
  }
  const raw = new THREE.BufferGeometry();
  raw.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  raw.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  const geo = mergeVertices(raw, 1e-4);
  geo.computeVertexNormals();

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
        float grain = fbm(vWorld.xz * 1.1);
        // vase grise et luisante au fond, schorre plus sec sur le haut de berge
        vec3 mud = mix(vec3(0.11, 0.11, 0.10), vec3(0.19, 0.19, 0.16), grain);
        vec3 salt = mix(vec3(0.17, 0.18, 0.13), vec3(0.26, 0.26, 0.19), grain);
        vec3 albedo = mix(mud, salt, smoothstep(0.2, 0.9, vEdge));
        float ndl = max(dot(n, uSunDir), 0.0);
        float shadow = sunShadow(vWorld, ndl);
        // la vase mouillée renvoie le ciel en lueur rasante
        float sheen = pow(1.0 - max(dot(n, normalize(cameraPosition - vWorld)), 0.0), 4.0) * (1.0 - vEdge);
        vec3 col = albedo * (uSunColor * ndl * shadow + mix(uSkyHorizon, uSkyTop, 0.4) * uAmbient + lantern(vWorld, n));
        col += uSkyHorizon * sheen * 0.3;
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'estey';
  return mesh;
}

/** l'eau qui reste au fond de l'estey : un ruban étroit, sombre et immobile */
export function createEsteyWater() {
  const steps = 130;
  const pos: number[] = [];
  const tmpP = new THREE.Vector3();
  const tmpT = new THREE.Vector3();
  const level = BASSIN.level - ESTEY.depth + 0.85;
  const at = (t: number, off: number) => {
    ESTEY_CURVE.getPointAt(t, tmpP);
    ESTEY_CURVE.getTangentAt(t, tmpT);
    return [tmpP.x - tmpT.z * off, level, tmpP.z + tmpT.x * off] as [number, number, number];
  };
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const w = ESTEY.half * 0.8;
    const a = at(t0, -w);
    const b = at(t1, -w);
    const c = at(t1, w);
    const d = at(t0, w);
    pos.push(...a, ...c, ...b, ...a, ...d, ...c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, stillWater(0.008));
  mesh.name = 'estey-eau';
  return mesh;
}

// ───────────── l'eau du bassin ─────────────

function stillWater(deep = 0.02) {
  return new THREE.ShaderMaterial({
    uniforms: { ...world, uDeep: { value: deep } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      uniform float uDeep;
      varying vec3 vWorld;
      void main(){
        vec3 v = normalize(cameraPosition - vWorld);
        // une eau de lagune : à peine ridée, elle rend le ciel presque tel quel
        float r1 = fbm(vWorld.xz * 0.5 + vec2(uTime * 0.04, uTime * 0.02));
        float r2 = fbm(vWorld.xz * 1.3 - vec2(uTime * 0.03, uTime * 0.05));
        vec3 n = normalize(vec3((r1 - 0.5) * 0.14, 1.0, (r2 - 0.5) * 0.14));
        float fresnel = 0.05 + 0.95 * pow(1.0 - max(dot(n, v), 0.0), 4.5);
        vec3 sky = mix(uSkyHorizon, uSkyTop, 0.3);
        vec3 col = mix(vec3(uDeep, uDeep * 1.3, uDeep * 1.2), sky * 0.92, fresnel);
        vec3 refl = reflect(-v, n);
        col += uSunColor * pow(max(dot(refl, uSunDir), 0.0), 120.0) * 0.8;
        col += uSkyHorizon * pow(max(dot(refl, uMoonDir), 0.0), 80.0) * uMoon * 1.5;
        col += lantern(vWorld, n) * 0.5;
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
}

export function createBasinWater() {
  const geo = new THREE.CircleGeometry(BASSIN.radius * 2.4, 72);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, stillWater());
  mesh.position.set(BASSIN.x, BASSIN.level, BASSIN.z);
  mesh.name = 'bassin';
  return mesh;
}

// ───────────── pignots et cabane ─────────────

/**
 * Les pignots : de grands piquets de bois plantés dans l'eau, qui délimitent les parcs à huîtres.
 * Alignés au cordeau, ils font des pointillés réguliers sur une eau lisse — c'est cette répétition
 * qui signe le bassin, pas le piquet lui-même.
 */
export function createPignots() {
  const stake = new THREE.CylinderGeometry(0.075, 0.1, 2.6, 5);
  stake.translate(0, 0.55, 0);
  const geo = stake.toNonIndexed();
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();

  const rows: [number, number, number, number][] = [
    // x, z de départ, direction, nombre
    [96, -252, 0, 26],
    [104, -262, 0, 26],
    [112, -272, 0, 22],
    [128, -258, 1, 18],
  ];
  const positions: [number, number][] = [];
  for (const [x0, z0, dir, n] of rows) {
    for (let i = 0; i < n; i++) {
      const t = i * 3.1;
      positions.push(dir === 0 ? [x0 + t * 0.94, z0 - t * 0.34] : [x0 - t * 0.3, z0 - t * 0.95]);
    }
  }

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vUp;
      void main(){
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(instanceMatrix) * normal);
        vUp = position.y;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vUp;
      void main(){
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        // bois noirci par l'eau salée en bas, gris argenté en haut
        float grain = fbm(vec2(vWorld.x * 3.0, vUp * 6.0));
        vec3 albedo = mix(vec3(0.07, 0.07, 0.06), mix(vec3(0.22, 0.20, 0.17), vec3(0.34, 0.32, 0.28), grain), smoothstep(-0.9, 0.4, vUp));
        float ndl = max(dot(n, uSunDir), 0.0);
        vec3 col = albedo * (uSunColor * ndl * 0.9 + mix(uSkyHorizon, uSkyTop, 0.5) * uAmbient + lantern(vWorld, n));
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, positions.length);
  const dummy = new THREE.Object3D();
  positions.forEach(([x, z], i) => {
    dummy.position.set(x, BASSIN.level - 0.2, z);
    // aucun pignot n'est parfaitement droit : c'est ce qui les distingue d'une clôture
    dummy.rotation.set((Math.sin(i * 2.3) * 0.06), i * 1.7, Math.cos(i * 1.9) * 0.06);
    dummy.scale.setScalar(0.9 + ((i * 37) % 10) / 40);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.frustumCulled = false;
  mesh.name = 'pignots';
  return mesh;
}

/** la cabane tchanquée : une cabane de bois montée sur échasses, au milieu de l'eau */
export function createCabane() {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g.toNonIndexed();
  };

  // échasses : quatre pieux obliques, plantés dans la vase
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
    const leg = new THREE.CylinderGeometry(0.12, 0.16, 5.6, 6);
    leg.rotateX(sz * 0.05);
    leg.rotateZ(-sx * 0.05);
    leg.translate(sx * 1.85, 2.5, sz * 1.85);
    parts.push(leg.toNonIndexed());
  }
  // plancher et terrasse
  parts.push(box(5.4, 0.22, 5.4, 0, 5.3, 0));
  // corps de cabane
  parts.push(box(4.2, 2.5, 4.2, 0, 6.65, 0));
  // toit à quatre pans
  const roof = new THREE.ConeGeometry(3.6, 1.9, 4);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, 8.85, 0);
  parts.push(roof.toNonIndexed());
  // garde-corps de la terrasse, côté eau
  for (const s of [-1, 1]) parts.push(box(5.4, 0.08, 0.08, 0, 6.0, s * 2.6));
  for (const s of [-1, 1]) parts.push(box(0.08, 0.7, 5.4, s * 2.6, 5.75, 0));
  // échelle
  for (const s of [-1, 1]) parts.push(box(0.08, 5.2, 0.08, s * 0.5, 2.6, 2.9));
  for (let i = 0; i < 7; i++) parts.push(box(1.1, 0.06, 0.06, 0, 0.7 + i * 0.68, 2.9));

  const geo = mergeGeometries(parts)!;
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vUp;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vUp = position.y;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vUp;
      void main(){
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        float grain = fbm(vec2(vWorld.x * 2.2 + vWorld.z * 1.4, vUp * 5.0));
        vec3 wood = mix(vec3(0.14, 0.12, 0.10), vec3(0.30, 0.27, 0.22), grain);
        // le volet et la porte sont peints, comme toutes les cabanes du bassin
        vec3 albedo = mix(vec3(0.08, 0.08, 0.07), wood, smoothstep(0.0, 1.2, vUp));
        float ndl = max(dot(n, uSunDir), 0.0);
        vec3 col = albedo * (uSunColor * ndl * 0.85 + mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient + lantern(vWorld, n));
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(118, BASSIN.level - 1.4, -282);
  mesh.rotation.y = -0.6;
  mesh.name = 'cabane';
  return mesh;
}
