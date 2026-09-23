import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { glslNoise, glslWorld, world } from './light';

/**
 * La palombière.
 *
 * En octobre, les palombes descendent vers l'Espagne en suivant les Landes, et toute la région
 * monte les attendre dans les arbres. Une palombière, c'est une cabane de planches calée à six
 * mètres du sol, habillée de branchages pour disparaître dans le houppier, une échelle clouée au
 * poteau, et des appelants — des pigeons apprivoisés — posés sur des perchoirs au bout d'une
 * longue perche, qu'on fait battre des ailes depuis la cabane pour attirer le vol.
 *
 * Elle est plantée sur la branche du marais, à douze mètres du sentier. Sa place n'a pas été
 * choisie à vue : on a cherché l'endroit d'où elle tombe dans l'axe de la marche — huit degrés
 * hors du cap, à une trentaine de mètres — pour qu'elle se découvre d'elle-même, sans qu'il
 * faille tourner la tête.
 */
export const PALOMBIERE = {
  x: 3,
  z: -134.3,
  /** rayon dégagé autour des poteaux : rien ne pousse dessous */
  clear: 6.5,
  /** hauteur du plancher au-dessus du sol. Plus haut, la cabane sort du champ du promeneur */
  floor: 5.1,
};

/**
 * La cabane est posée à treize mètres du sentier, et sa façade — la meurtrière, la perche et les
 * appelants — regarde le chemin : c'est l'angle sous lequel le promeneur la découvre. L'angle est
 * la normale au sentier à cet endroit, retournée vers lui.
 */
const FACING = Math.atan2(0.67, -0.743);

const W = 1.55; // demi-largeur du plancher
const D = 1.25; // demi-profondeur
const WALL = 1.45;

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  g.deleteAttribute('uv');
  return g.toNonIndexed();
}

function beam(len: number, r: number, from: THREE.Vector3, to: THREE.Vector3) {
  const g = new THREE.CylinderGeometry(r, r * 1.15, len, 6, 1);
  g.deleteAttribute('uv');
  const dir = to.clone().sub(from);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  g.applyQuaternion(q);
  g.translate(from.x + dir.x / 2, from.y + dir.y / 2, from.z + dir.z / 2);
  return g.toNonIndexed();
}

let seed = 1553;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

/** planches, poteaux, échelle et perche : tout ce qui est en bois scié ou en rondin */
function timber(drop: number) {
  const parts: THREE.BufferGeometry[] = [];
  const F = PALOMBIERE.floor;

  // les quatre poteaux, légèrement écartés du bas : un pied étroit se lit comme un guéridon
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const top = new THREE.Vector3(sx * (W - 0.18), F, sz * (D - 0.18));
    const foot = new THREE.Vector3(sx * (W + 0.5), -drop, sz * (D + 0.4));
    parts.push(beam(1, 0.115, foot, top));
  }
  // contreventement : deux croix de Saint-André entre les poteaux, côté sentier et côté opposé
  for (const sz of [-1, 1]) {
    const a = new THREE.Vector3(-(W - 0.1), F - 0.4, sz * (D - 0.1));
    const b = new THREE.Vector3(W - 0.1, F - 2.6, sz * (D + 0.05));
    parts.push(beam(1, 0.05, a, b));
    parts.push(beam(1, 0.05, new THREE.Vector3(b.x, a.y, b.z), new THREE.Vector3(a.x, b.y, a.z)));
  }

  // le plancher : des planches jointives, chacune un peu gauchie
  const boards = 9;
  for (let i = 0; i < boards; i++) {
    const z = -D + (i + 0.5) * ((D * 2) / boards);
    parts.push(box(W * 2 + 0.3, 0.07, (D * 2) / boards - 0.015, 0, F + Math.sin(i * 2.3) * 0.012, z));
  }
  parts.push(box(W * 2 + 0.3, 0.14, 0.14, 0, F - 0.1, -D));
  parts.push(box(W * 2 + 0.3, 0.14, 0.14, 0, F - 0.1, D));

  // les parois. Celle qui regarde le sentier s'arrête à hauteur de poitrine et reprend plus haut :
  // entre les deux court la meurtrière par laquelle on guette.
  const wallY = F + 0.04;
  parts.push(box(0.09, 0.9, D * 2, -W, wallY + 0.45, 0));
  parts.push(box(0.09, 0.28, D * 2, -W, wallY + 1.31, 0));
  parts.push(box(W * 2, WALL, 0.09, 0, wallY + WALL / 2, -D));
  parts.push(box(W * 2, WALL, 0.09, 0, wallY + WALL / 2, D));
  // la paroi du fond, avec la trappe d'accès laissée ouverte
  parts.push(box(0.09, WALL, D * 2 - 0.75, W, wallY + WALL / 2, 0.37));
  parts.push(box(0.09, 0.5, 0.75, W, wallY + WALL - 0.25, -0.88));

  // le toit : deux pans très plats, débordants, faits de planches
  for (const side of [-1, 1]) {
    const g = box(W * 2 + 0.7, 0.08, D + 0.45, 0, wallY + WALL + 0.24, (side * (D + 0.4)) / 2);
    g.rotateX(side * 0.17);
    g.translate(0, 0, 0);
    parts.push(g);
  }
  parts.push(box(W * 2 + 0.8, 0.12, 0.12, 0, wallY + WALL + 0.34, 0));

  // l'échelle, clouée au poteau arrière
  const lx = W + 0.34;
  const lz = 0.55;
  for (const off of [-0.22, 0.22]) {
    parts.push(beam(1, 0.05, new THREE.Vector3(lx + 0.45, -drop, lz + off), new THREE.Vector3(lx - 0.04, F + 0.1, lz + off)));
  }
  const rungs = Math.floor(F / 0.42);
  for (let i = 1; i <= rungs; i++) {
    const t = i / (rungs + 1);
    parts.push(box(0.06, 0.05, 0.48, lx + 0.45 - t * 0.49, -drop + t * (F + 0.1 + drop), lz));
  }

  // la perche à appelants : elle sort de la cabane côté sentier et porte les perchoirs
  const armY = PALOMBIERE.floor + WALL + 0.9;
  const tip = new THREE.Vector3(-(W + 4.2), armY + 0.5, -0.4);
  parts.push(beam(1, 0.07, new THREE.Vector3(-(W - 0.2), armY - 0.6, 0.1), tip));
  for (const [t, len] of [
    [0.45, 0.9],
    [0.72, 0.75],
    [0.95, 0.6],
  ] as [number, number][]) {
    const base = new THREE.Vector3(-(W - 0.2) - (tip.x + (W - 0.2)) * -t, 0, 0);
    const px = -(W - 0.2) + (tip.x + (W - 0.2)) * t;
    const py = armY - 0.6 + (tip.y - armY + 0.6) * t;
    const pz = 0.1 + (tip.z - 0.1) * t;
    void base;
    parts.push(box(len, 0.05, 0.05, px, py + 0.28, pz));
    parts.push(box(0.05, 0.56, 0.05, px, py + 0.02, pz));
  }

  const geo = mergeGeometries(parts)!;
  geo.computeVertexNormals();
  return geo;
}

/** le branchage : ce qui fait disparaître la cabane dans le houppier */
function camouflage() {
  const parts: THREE.BufferGeometry[] = [];
  const F = PALOMBIERE.floor;
  const wallY = F + 0.04;
  // des fagots plaqués contre les parois et sur le toit, orientés dans tous les sens
  for (let i = 0; i < 64; i++) {
    const side = Math.floor(rand() * 4);
    const t = rand() * 2 - 1;
    const y = wallY + 0.1 + rand() * (WALL + 0.5);
    let x = 0;
    let z = 0;
    if (side === 0) {
      x = -W - 0.12;
      z = t * D;
    } else if (side === 1) {
      x = W + 0.12;
      z = t * D;
    } else if (side === 2) {
      x = t * W;
      z = -D - 0.12;
    } else {
      x = t * W;
      z = D + 0.12;
    }
    const r = 0.26 + rand() * 0.3;
    const g = new THREE.IcosahedronGeometry(r, 1);
    // une branche coupée est plate et orientée : une sphère se lit comme un pompon
    g.scale(1.5, 0.3, 0.9);
    g.rotateY(rand() * Math.PI * 2);
    g.rotateZ((rand() - 0.5) * 0.9);
    g.translate(x + (rand() - 0.5) * 0.3, y, z + (rand() - 0.5) * 0.3);
    g.deleteAttribute('uv');
    parts.push(g.toNonIndexed());
  }
  // et une couronne de branches sur le toit, qui dépasse de partout
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rand() * 0.3;
    const r = 0.45 + rand() * 0.5;
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.scale(1.4, 0.25, 0.8);
    g.rotateY(a + (rand() - 0.5) * 0.8);
    g.translate(Math.cos(a) * (W * 0.9), wallY + WALL + 0.42 + rand() * 0.2, Math.sin(a) * (D * 1.1));
    g.deleteAttribute('uv');
    parts.push(g.toNonIndexed());
  }
  const geo = mergeGeometries(parts)!;
  geo.computeVertexNormals();
  return geo;
}

/** les appelants : trois pigeons posés sur leurs perchoirs, au bout de la perche */
function decoys() {
  const parts: THREE.BufferGeometry[] = [];
  const armY = PALOMBIERE.floor + WALL + 0.9;
  const tipX = -(W + 4.2);
  const tipY = armY + 0.5;
  for (const t of [0.45, 0.72, 0.95]) {
    const px = -(W - 0.2) + (tipX + (W - 0.2)) * t;
    const py = armY - 0.6 + (tipY - armY + 0.6) * t + 0.3 + 0.13;
    const pz = 0.1 + (-0.4 - 0.1) * t;
    const body = new THREE.IcosahedronGeometry(0.16, 2);
    body.scale(1.5, 1, 1);
    body.translate(px, py, pz);
    const head = new THREE.IcosahedronGeometry(0.075, 1);
    head.translate(px - 0.21, py + 0.11, pz);
    const tail = new THREE.BoxGeometry(0.2, 0.025, 0.08);
    tail.translate(px + 0.26, py - 0.02, pz);
    for (const g of [body, head, tail]) {
      g.deleteAttribute('uv');
      parts.push(g.toNonIndexed());
    }
  }
  const geo = mergeGeometries(parts)!;
  geo.computeVertexNormals();
  return geo;
}

const vertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vLocal;
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vLocal = position;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

function material(body: string) {
  return new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.DoubleSide,
    vertexShader: vertex,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      void main(){
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 albedo;
        ${body}
        float ndl = max(dot(n, uSunDir), 0.0);
        float shadow = sunShadow(vWorld, ndl);
        vec3 amb = mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient;
        vec3 col = albedo * (uSunColor * ndl * shadow + amb + lantern(vWorld, n));
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
}

export function createPalombiere(groundAt: (x: number, z: number) => number) {
  const group = new THREE.Group();
  const base = groundAt(PALOMBIERE.x, PALOMBIERE.z);
  // les pieds descendent plus bas que le point d'appui : le sol n'est pas plat, et un poteau qui
  // flotte à dix centimètres se voit de loin
  const drop = 1.1;

  const wood = new THREE.Mesh(
    timber(drop),
    material(`
        // bois non traité, gris argent sur les faces au ciel, plus sombre dessous
        float grain = fbm(vec2(vLocal.y * 9.0, (vLocal.x + vLocal.z) * 3.0));
        albedo = mix(vec3(0.10, 0.09, 0.07), vec3(0.24, 0.21, 0.17), grain);
        albedo *= mix(0.6, 1.05, smoothstep(-0.2, 1.0, n.y));`)
  );
  wood.name = 'palombiere-bois';

  const branches = new THREE.Mesh(
    camouflage(),
    material(`
        // branchages coupés depuis quelques jours : le vert vire au roux
        float clump = fbm(vLocal.xz * 1.6 + vLocal.y * 0.7);
        albedo = mix(vec3(0.06, 0.10, 0.05), vec3(0.17, 0.20, 0.08), clump);`)
  );
  branches.name = 'palombiere-branchage';

  const birds = new THREE.Mesh(
    decoys(),
    material(`
        // la palombe : ardoise bleutée, le col plus clair
        float b = fbm(vLocal.xz * 6.0 + vLocal.y * 4.0);
        albedo = mix(vec3(0.09, 0.10, 0.13), vec3(0.22, 0.23, 0.28), b);`)
  );
  birds.name = 'palombiere-appelants';

  group.add(wood, branches, birds);
  group.position.set(PALOMBIERE.x, base, PALOMBIERE.z);
  group.rotation.y = FACING;
  group.name = 'palombiere';
  return group;
}

/** vrai à l'aplomb de la cabane : ni arbre ni sous-bois ne s'y plante */
export function underPalombiere(x: number, z: number) {
  return Math.hypot(x - PALOMBIERE.x, z - PALOMBIERE.z) < PALOMBIERE.clear;
}

/**
 * Le couloir de vue.
 *
 * Trouver le bon angle ne suffit pas : un seul pin planté au hasard entre le sentier et la cabane
 * la masque entièrement, et elle n'existe plus. On réserve donc la bande de terrain par laquelle
 * on la découvre — la lande y reste ouverte, ce qui est aussi ce qui se passe en vrai autour d'une
 * palombière, où l'on dégage le ciel devant la cabane pour voir venir le vol.
 */
const LANE = { ax: 1.4, az: -100, bx: PALOMBIERE.x, bz: PALOMBIERE.z, half: 6 };

export function blocksPalombiere(x: number, z: number) {
  const dx = LANE.bx - LANE.ax;
  const dz = LANE.bz - LANE.az;
  const t = THREE.MathUtils.clamp(((x - LANE.ax) * dx + (z - LANE.az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(x - (LANE.ax + dx * t), z - (LANE.az + dz * t)) < LANE.half;
}
