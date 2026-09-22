import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { glslNoise, glslWorld, world } from './light';

// Les deux arrivées : l'airial et le village ostréicole.
//
// Les deux branches sortaient du sauvage pour s'arrêter dans un fourré ou sur une vasière. Elles
// débouchent maintenant sur un lieu habité — une maison sous les chênes d'un côté, une rangée de
// cabanes et un ponton de l'autre. Dans les deux cas la lumière est allumée à l'intérieur, et
// c'est la seule chose chaude du paysage à cette heure-là.

/** la clairière habitée, au bout du delta */
export const AIRIAL = { x: 186, z: -116, radius: 30 };
/** le village, au bout du bassin */
export const VILLAGE = { x: 130, z: -256 };

// Toutes les pièces doivent porter exactement les mêmes attributs, sinon la fusion échoue : on
// retire donc les UV dès la source, le toit n'en ayant pas.
const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const flat = g.toNonIndexed();
  flat.deleteAttribute('uv');
  return flat;
};

/**
 * Toit à deux pans : un prisme triangulaire, arête faîtière dans l'axe de la profondeur.
 * Un cône à trois faces mis à l'échelle donnait une flèche de cathédrale, pas un toit.
 */
function gable(w: number, h: number, d: number, x: number, y: number, z: number) {
  const hw = w / 2;
  const hd = d / 2;
  const v = {
    bl: [-hw, 0, -hd], br: [hw, 0, -hd], fl: [-hw, 0, hd], fr: [hw, 0, hd],
    rb: [0, h, -hd], rf: [0, h, hd],
  } as Record<string, number[]>;
  const tri: number[][] = [
    // pan gauche, pan droit
    v.bl, v.rb, v.rf, v.bl, v.rf, v.fl,
    v.br, v.fr, v.rf, v.br, v.rf, v.rb,
    // pignons
    v.bl, v.br, v.rb, v.fl, v.rf, v.fr,
    // sous-face, pour que le toit ne soit pas creux vu d'en dessous
    v.bl, v.fl, v.fr, v.bl, v.fr, v.br,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tri.flat().map((n, i) => n + [x, y, z][i % 3]), 3));
  g.computeVertexNormals();
  return g;
}

function built(parts: THREE.BufferGeometry[], name: string, tone: number) {
  const geo = mergeGeometries(parts)!;
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world, uTone: { value: tone } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vLocal = position;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      uniform float uTone;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      void main(){
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        float grain = fbm(vec2(vWorld.x * 2.4 + vWorld.z * 1.7, vLocal.y * 5.5));
        // uTone : 0 bois gris des cabanes, 1 torchis clair de la maison landaise
        vec3 wood = mix(vec3(0.13, 0.12, 0.10), vec3(0.28, 0.25, 0.21), grain);
        vec3 daub = mix(vec3(0.42, 0.39, 0.33), vec3(0.58, 0.55, 0.47), grain);
        vec3 albedo = mix(wood, daub, uTone);
        // le toit, plus sombre, prend la lumière du ciel à plat
        albedo *= mix(1.0, 0.55, smoothstep(0.55, 0.85, n.y));
        float ndl = max(dot(n, uSunDir), 0.0);
        float shadow = sunShadow(vWorld, ndl);
        vec3 amb = mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient;
        vec3 col = albedo * (uSunColor * ndl * shadow * 0.55 + amb + lantern(vWorld, n));
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  return mesh;
}

/** les fenêtres éclairées : elles s'allument à mesure que la nuit tombe */
function windows(rects: [number, number, number, number, number, number][]) {
  const parts = rects.map(([w, h, x, y, z, ry]) => {
    const g = new THREE.PlaneGeometry(w, h);
    g.rotateY(ry);
    g.translate(x, y, z);
    return g.toNonIndexed();
  });
  const geo = mergeGeometries(parts)!;
  geo.deleteAttribute('uv');
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
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
      varying vec3 vWorld;
      void main(){
        // la lampe intérieure monte avec la lune : de jour la fenêtre est sombre
        float lit = 0.12 + 0.88 * uMoon;
        vec3 col = vec3(1.0, 0.72, 0.38) * lit;
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 0.25 + 0.6 * lit);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fenetres';
  return mesh;
}

/** un chêne d'airial : tronc court, houppier large et bas, celui qui fait de l'ombre à la maison */
function oak() {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.42, 0.72, 4.2, 8, 1, true);
  trunk.translate(0, 2.1, 0);
  parts.push(trunk.toNonIndexed());
  const blobs: [number, number, number, number][] = [
    [0, 6.4, 0, 3.6],
    [2.8, 5.6, 0.8, 2.6],
    [-2.6, 5.9, -1, 2.5],
    [0.6, 8.1, -1.8, 2.3],
    [-0.9, 5.2, 2.6, 2.4],
  ];
  for (const [x, y, z, r] of blobs) {
    const b = new THREE.IcosahedronGeometry(r, 1);
    b.scale(1, 0.72, 1);
    b.translate(x, y, z);
    parts.push(b.toNonIndexed());
  }
  const geo = mergeGeometries(parts)!;
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const leafy = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) leafy[i] = pos.getY(i) > 3.6 ? 1 : 0;
  geo.setAttribute('aLeaf', new THREE.BufferAttribute(leafy, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aLeaf;
      uniform float uTime;
      uniform float uWind;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vLeaf;
      void main(){
        vec3 p = position;
        p.x += sin(uTime * 0.7 + p.z * 0.2) * 0.14 * uWind * aLeaf;
        vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(instanceMatrix) * normal);
        vLeaf = aLeaf;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vLeaf;
      void main(){
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 v = normalize(cameraPosition - vWorld);
        float grain = fbm(vWorld.xz * 1.4);
        vec3 bark = mix(vec3(0.13, 0.10, 0.08), vec3(0.24, 0.19, 0.14), grain);
        vec3 leaf = mix(vec3(0.10, 0.16, 0.06), vec3(0.22, 0.28, 0.10), grain);
        vec3 albedo = mix(bark, leaf, vLeaf);
        float wrap = pow(max(dot(n, uSunDir) * 0.5 + 0.5, 0.0), 1.8);
        float back = pow(max(dot(-v, uSunDir), 0.0), 4.0) * vLeaf;
        float shadow = sunShadow(vWorld, dot(n, uSunDir));
        vec3 col = albedo * (uSunColor * (wrap * shadow * 0.7 + back * 0.7) + mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient + lantern(vWorld, n));
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  return { geo, mat };
}

/**
 * L'airial : la clairière herbeuse où l'on bâtissait, entourée de ses chênes. On sort du delta et
 * la forêt s'ouvre d'un coup sur une maison basse, la lampe allumée.
 */
export function createAirial(groundAt: (x: number, z: number) => number) {
  const group = new THREE.Group();
  group.name = 'airial';
  const y = groundAt(AIRIAL.x, AIRIAL.z);

  // maison landaise : longue, basse, toit très débordant à deux pans
  const house: THREE.BufferGeometry[] = [];
  house.push(box(13, 3.4, 7.4, 0, 1.7, 0));
  house.push(gable(14.6, 2.6, 9, 0, 4.6, 0));
  // pans de bois apparents
  for (const x of [-5.2, -1.7, 1.7, 5.2]) house.push(box(0.22, 3.4, 0.16, x, 1.7, 3.75));
  house.push(box(13, 0.2, 0.16, 0, 2.6, 3.75));
  // appentis
  house.push(box(4.6, 2.4, 3.4, 8.6, 1.2, 1.4));
  house.push(gable(5.2, 1.4, 4, 8.6, 3.05, 1.4));
  const maison = built(house, 'maison', 1);
  maison.position.set(AIRIAL.x, y, AIRIAL.z);
  maison.rotation.y = -0.35;
  group.add(maison);

  // façade tournée vers le sentier : les fenêtres éclairées doivent être celles qu'on voit
  const lights = windows([
    [1.05, 0.9, -3.2, 1.85, -3.76, Math.PI],
    [1.05, 0.9, 2.4, 1.85, -3.76, Math.PI],
    [0.8, 0.75, 6.55, 1.55, -3.16, Math.PI],
  ]);
  lights.position.copy(maison.position);
  lights.rotation.y = maison.rotation.y;
  group.add(lights);

  // bergerie, à l'écart
  const shed = built([box(7, 2.6, 4.6, 0, 1.3, 0), gable(8, 1.8, 5.4, 0, 3.4, 0)], 'bergerie', 0.55);
  shed.position.set(AIRIAL.x - 19, groundAt(AIRIAL.x - 19, AIRIAL.z + 13), AIRIAL.z + 13);
  shed.rotation.y = 0.9;
  group.add(shed);

  // les chênes : en cercle large autour du bâti, comme sur tous les airials
  const { geo, mat } = oak();
  const spots: [number, number][] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.4;
    const r = AIRIAL.radius * (0.55 + ((i * 7) % 5) / 12);
    spots.push([AIRIAL.x + Math.cos(a) * r, AIRIAL.z + Math.sin(a) * r]);
  }
  const oaks = new THREE.InstancedMesh(geo, mat, spots.length);
  const dummy = new THREE.Object3D();
  spots.forEach(([x, z], i) => {
    dummy.position.set(x, groundAt(x, z) - 0.2, z);
    dummy.rotation.set(0, i * 1.9, 0);
    dummy.scale.setScalar(0.85 + ((i * 13) % 7) / 20);
    dummy.updateMatrix();
    oaks.setMatrixAt(i, dummy.matrix);
  });
  oaks.frustumCulled = false;
  oaks.name = 'chenes';
  group.add(oaks);

  return group;
}

/**
 * Le village ostréicole : une rangée de cabanes basses au bord de l'eau, des pinasses échouées sur
 * la vase, et un ponton qui part vers le large.
 */
export function createVillage(groundAt: (x: number, z: number) => number, waterLevel: number) {
  const group = new THREE.Group();
  group.name = 'village';

  // six cabanes alignées le long de la rive, toutes un peu différentes
  // alignées côté terre, le long du chemin, la façade tournée vers l'eau
  // Reculées d'une dizaine de mètres et rapetissées : une cabane ostréicole est une pièce unique,
  // pas une grange. À cinq mètres du chemin et sept mètres de haut, elles écrasaient tout.
  const cabins: [number, number, number, number][] = [
    [93, -231, 0.3, 0.85],
    [107, -233, 0.26, 0.78],
    [120, -236, 0.34, 0.92],
    [133, -241, 0.24, 0.8],
    [145, -245, 0.38, 0.88],
    [156, -250, 0.3, 0.75],
  ];
  for (const [x, z, ry, scale] of cabins) {
    const w = 5.2 * scale;
    const d = 3.8 * scale;
    const h = 2.15 * scale;
    const parts = [box(w, h, d, 0, h / 2 + 0.4, 0), gable(w * 1.06, 1.05 * scale, d * 1.1, 0, h + 0.4, 0)];
    // pilotis courts : la cabane ne touche pas la vase
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(box(0.2, 0.9, 0.2, (sx * w) / 2.6, 0.25, (sz * d) / 2.6));
    const cabin = built(parts, 'cabane-ostreicole', 0.15);
    const y = groundAt(x, z);
    cabin.position.set(x, y, z);
    cabin.rotation.y = ry;
    group.add(cabin);

    const win = windows([[0.9 * scale, 0.75 * scale, 0, h * 0.6 + 0.4, (-d / 2) * 1.01, Math.PI]]);
    win.position.copy(cabin.position);
    win.rotation.y = ry;
    group.add(win);
  }

  // le ponton : des planches sur pilotis, qui s'avancent dans l'eau
  const deck: THREE.BufferGeometry[] = [];
  const span = 26;
  for (let i = 0; i < span / 0.34; i++) {
    const t = i * 0.34;
    deck.push(box(1.4, 0.06, 0.26, 0, 0, -t));
  }
  deck.push(box(0.12, 0.16, span, -0.58, -0.11, -span / 2 + 0.2));
  deck.push(box(0.12, 0.16, span, 0.58, -0.11, -span / 2 + 0.2));
  for (let i = 0; i < 6; i++) {
    for (const sx of [-0.58, 0.58]) deck.push(box(0.15, 2.2, 0.15, sx, -1.2, -1 - i * 4.8));
  }
  const jetty = built(deck, 'ponton', 0.1);
  // le ponton part droit devant le promeneur qui arrive, et s'avance sur l'eau
  jetty.position.set(153, waterLevel + 1.2, -263);
  jetty.rotation.y = -1.15;
  group.add(jetty);

  // pinasses échouées : coque effilée, fond plat
  for (const [x, z, ry] of [
    [104, -250, 0.8],
    [126, -256, -0.3],
    [142, -264, 1.4],
  ] as [number, number, number][]) {
    const hull = new THREE.CylinderGeometry(0.85, 0.55, 6.4, 6, 1);
    hull.rotateZ(Math.PI / 2);
    hull.scale(1, 0.55, 1);
    const shaped = hull.toNonIndexed();
    shaped.deleteAttribute('uv');
    const p = shaped.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      // l'étrave et la poupe se pincent : c'est ce qui fait la pinasse
      const t = Math.abs(p.getX(i)) / 3.2;
      const k = 1 - t * t * 0.8;
      p.setXYZ(i, p.getX(i), Math.max(p.getY(i) * k, -0.2), p.getZ(i) * k);
    }
    const boat = built([shaped, box(5.2, 0.1, 0.5, 0, 0.32, 0)], 'pinasse', 0.05);
    boat.position.set(x, groundAt(x, z) + 0.25, z);
    boat.rotation.set(0.06, ry, 0.12);
    group.add(boat);
  }

  return group;
}
