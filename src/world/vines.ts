import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt } from './terrain';
import { biomeAt, trailDistance } from './paths';
import { glslNoise, glslWorld, world } from './light';

// Le vignoble des graves, avant la lisière.
//
// C'est le seul paysage géométrique et habité de la balade : des rangs parallèles, régulièrement
// espacés, qui filent vers l'horizon, et un château au loin. Le sentier descend une allée, si bien
// que les rangs défilent de part et d'autre.

const ROW_SPACING = 2.05; // écart entre deux rangs, en mètres
const PLANT_SPACING = 0.95; // écart entre deux ceps sur le rang
const REACH = 42; // on ne plante pas au-delà : ce qu'on ne voit pas coûte pour rien

let seed = 1337;
const rand = () => {
  seed = (seed * 48271) % 2147483647;
  return (seed - 1) / 2147483646;
};

function plant() {
  const parts: THREE.BufferGeometry[] = [];
  // cep : un tronc court et tordu, taillé en gobelet
  const trunk = new THREE.CylinderGeometry(0.045, 0.075, 0.52, 5);
  trunk.translate(0, 0.26, 0);
  trunk.rotateZ(0.08);
  parts.push(trunk.toNonIndexed());
  // bras de taille, sur le fil de fer
  for (const s of [-1, 1]) {
    const arm = new THREE.CylinderGeometry(0.028, 0.035, 0.5, 4);
    arm.rotateZ(Math.PI / 2);
    arm.translate(s * 0.26, 0.54, 0);
    parts.push(arm.toNonIndexed());
  }
  // Feuillage : un boudin couché dans l'axe du rang, qui déborde sur le cep voisin. En cube, la
  // vigne se lisait comme une rangée de caisses.
  const leaves = new THREE.CylinderGeometry(0.42, 0.42, 1.32, 9, 2);
  leaves.rotateX(Math.PI / 2);
  leaves.scale(0.74, 1, 1);
  const p = leaves.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const k = Math.sin(p.getX(i) * 7.3 + p.getZ(i) * 4.1) * Math.cos(p.getY(i) * 5.9);
    p.setXYZ(i, p.getX(i) + k * 0.07, p.getY(i) + k * 0.08, p.getZ(i) + k * 0.05);
  }
  leaves.translate(0, 1.0, 0);
  parts.push(leaves.toNonIndexed());

  const geo = mergeGeometries(parts)!;
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  // aHeight : 0 au pied, 1 en haut — sert à l'occlusion et au vent
  geo.computeBoundingBox();
  const h = geo.boundingBox!.max.y;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const rel = new Float32Array(pos.count);
  const wood = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    rel[i] = THREE.MathUtils.clamp(pos.getY(i) / h, 0, 1);
    // le bois est en bas et sur les bras, le feuillage au-dessus
    wood[i] = pos.getY(i) < 0.62 ? 1 : 0;
  }
  geo.setAttribute('aHeight', new THREE.BufferAttribute(rel, 1));
  geo.setAttribute('aWood', new THREE.BufferAttribute(wood, 1));
  return geo;
}

/** piquet de bout de rang, avec son fil */
function post() {
  const g = new THREE.BoxGeometry(0.08, 1.6, 0.08);
  g.translate(0, 0.8, 0);
  const flat = g.toNonIndexed();
  flat.deleteAttribute('uv');
  flat.computeVertexNormals();
  const pos = flat.attributes.position as THREE.BufferAttribute;
  const rel = new Float32Array(pos.count);
  const wood = new Float32Array(pos.count).fill(1);
  for (let i = 0; i < pos.count; i++) rel[i] = THREE.MathUtils.clamp(pos.getY(i) / 1.6, 0, 1);
  flat.setAttribute('aHeight', new THREE.BufferAttribute(rel, 1));
  flat.setAttribute('aWood', new THREE.BufferAttribute(wood, 1));
  return flat;
}

const vertex = /* glsl */ `
  attribute float aHeight;
  attribute float aWood;
  attribute vec2 aVar;
  uniform float uTime;
  uniform float uWind;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vHeight;
  varying float vWood;
  varying vec2 vVar;
  void main(){
    vec3 p = position;
    // seul le feuillage bouge, et peu : une vigne palissée ne ploie pas comme une herbe
    float sway = aHeight * aHeight * uWind * (1.0 - aWood) * 0.45;
    p.x += sin(uTime * 1.4 + aVar.y * 6.28) * 0.05 * sway;
    p.z += cos(uTime * 1.1 + aVar.y * 4.1) * 0.04 * sway;
    vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(instanceMatrix) * normal);
    vHeight = aHeight;
    vWood = aWood;
    vVar = aVar;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const fragment = /* glsl */ `
  ${glslNoise}
  ${glslWorld}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vHeight;
  varying float vWood;
  varying vec2 vVar;
  void main(){
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 v = normalize(cameraPosition - vWorld);
    float grain = fbm(vWorld.xz * 3.1 + vVar.x * 6.0);
    vec3 leaf = mix(vec3(0.07, 0.12, 0.05), vec3(0.15, 0.21, 0.07), grain * 0.6 + vVar.x * 0.4);
    vec3 bark = mix(vec3(0.16, 0.12, 0.09), vec3(0.28, 0.22, 0.16), grain);
    vec3 albedo = mix(leaf, bark, vWood);

    float wrap = pow(max(dot(n, uSunDir) * 0.5 + 0.5, 0.0), 1.7);
    float ao = mix(0.4, 1.0, smoothstep(0.25, 0.9, vHeight));
    // les feuilles de vigne sont larges et fines : elles s'allument franchement à contre-jour
    float back = pow(max(dot(-v, uSunDir), 0.0), 4.5) * (1.0 - vWood);
    float shadow = sunShadow(vWorld, dot(n, uSunDir));
    vec3 sun = uSunColor * (wrap * ao * shadow * 0.5 + back * 0.55 * vec3(1.0, 0.86, 0.5) * shadow);
    vec3 amb = mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient * ao;
    vec3 col = albedo * (sun + amb + lantern(vWorld, n));
    gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
  }
`;

/**
 * Le château, en silhouette : un corps de logis, un toit à deux pans, deux tours coiffées.
 * On ne le voit qu'à contre-jour, à deux cents mètres — la silhouette suffit, les détails non.
 */
function chateau() {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(17, 7.5, 9);
  body.translate(0, 3.75, 0);
  parts.push(body.toNonIndexed());
  const roof = new THREE.CylinderGeometry(0.001, 6.4, 3.4, 4, 1);
  roof.rotateY(Math.PI / 4);
  roof.scale(1.55, 1, 0.82);
  roof.translate(0, 9.2, 0);
  parts.push(roof.toNonIndexed());
  for (const s of [-1, 1]) {
    const tower = new THREE.CylinderGeometry(2.1, 2.3, 10.5, 10);
    tower.translate(s * 9.4, 5.25, 0.6);
    parts.push(tower.toNonIndexed());
    const cap = new THREE.ConeGeometry(2.7, 4.2, 10);
    cap.translate(s * 9.4, 12.6, 0.6);
    parts.push(cap.toNonIndexed());
  }
  const geo = mergeGeometries(parts)!;
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main(){
        vec3 n = normalize(vNormal);
        vec3 albedo = vec3(0.30, 0.27, 0.23);
        float ndl = max(dot(n, uSunDir), 0.0);
        vec3 amb = mix(uSkyHorizon, uSkyTop, n.y * 0.5 + 0.5) * uAmbient;
        vec3 col = albedo * (uSunColor * ndl * 0.8 + amb);
        gl_FragColor = vec4(applyFog(col, vWorld, cameraPosition), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'chateau';
  return mesh;
}

export function createVineyard() {
  const group = new THREE.Group();
  group.name = 'vignoble';

  // Semis en rangs : on balaie une grille alignée sur l'axe du vignoble, et on ne garde que ce
  // qui tombe dans le biome, assez loin du sentier pour laisser passer l'allée.
  const plants: [number, number, number][] = [];
  const posts: [number, number, number][] = [];
  for (let x = -90; x <= 95; x += ROW_SPACING) {
    let inRow = false;
    for (let z = 176; z >= 14; z -= PLANT_SPACING) {
      const d = trailDistance(x, z);
      const ok = d > 2.6 && d < REACH && biomeAt(x, z) === 'vigne';
      if (ok) {
        const y = heightAt(x, z, d);
        plants.push([x + (rand() - 0.5) * 0.12, y, z]);
        if (!inRow) posts.push([x, y, z + PLANT_SPACING]);
        inRow = true;
      } else if (inRow) {
        posts.push([x, heightAt(x, z, d), z]);
        inRow = false;
      }
    }
  }

  const material = (geo: THREE.BufferGeometry, list: [number, number, number][]) => {
    const mat = new THREE.ShaderMaterial({ uniforms: { ...world }, vertexShader: vertex, fragmentShader: fragment, side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const dummy = new THREE.Object3D();
    const variation = new Float32Array(list.length * 2);
    list.forEach(([x, y, z], i) => {
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, (rand() - 0.5) * 0.25, 0);
      dummy.scale.setScalar(0.9 + rand() * 0.25);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      variation[i * 2] = rand();
      variation[i * 2 + 1] = (x * 0.13 + z * 0.09) % 1;
    });
    geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(variation, 2));
    mesh.frustumCulled = false;
    return mesh;
  };

  const vines = material(plant(), plants);
  vines.name = 'ceps';
  group.add(vines);
  const stakes = material(post(), posts);
  stakes.name = 'piquets';
  group.add(stakes);

  const house = chateau();
  house.position.set(74, heightAt(74, 104) - 0.5, 104);
  house.rotation.y = -0.5;
  group.add(house);

  return { group, count: plants.length };
}
