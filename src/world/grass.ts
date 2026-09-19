import * as THREE from 'three';
import { CLEARING, LAKE, heightAt, trailDistance } from './terrain';
import { glslNoise, glslWorld, world } from './light';

// Herbes hautes le long du sentier et dans la clairière : un brin = 5 sommets, des dizaines de
// milliers d'instances, animées par le vent dans le shader, éclairées par transparence à contre-jour.

let seed = 11;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

export function createGrass(count: number) {
  // brin effilé, légèrement courbé
  const blade = new THREE.BufferGeometry();
  const w = 0.045;
  const h = 1;
  blade.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-w, 0, 0, w, 0, 0, -w * 0.7, h * 0.45, 0.02, w * 0.7, h * 0.45, 0.02, 0, h, 0.09]), 3)
  );
  blade.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4]);

  const offsets = new Float32Array(count * 4); // x, y, z, hauteur
  const params = new Float32Array(count * 3); // rotation, teinte, phase
  let n = 0;
  for (let i = 0; n < count && i < count * 8; i++) {
    // on sème près du sentier (où passe la caméra) et dans la clairière
    const inClearing = rand() < 0.3;
    let x: number;
    let z: number;
    if (inClearing) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * CLEARING.radius * 1.05;
      x = CLEARING.x + Math.cos(a) * r;
      z = CLEARING.z + Math.sin(a) * r;
    } else {
      x = (rand() - 0.5) * 70;
      z = 34 - rand() * 250;
    }
    const d = trailDistance(x, z);
    if (d < 1.4 || d > 26) continue;
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.radius * 1.02) continue;
    const tall = 0.35 + rand() * 0.45 + THREE.MathUtils.smoothstep(d, 2, 8) * 0.35;
    offsets.set([x, heightAt(x, z, d), z, tall], n * 4);
    params.set([rand() * Math.PI, rand(), rand()], n * 3);
    n++;
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = blade.index;
  geo.setAttribute('position', blade.attributes.position);
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 4));
  geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 3));
  geo.instanceCount = n;

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      ${glslNoise}
      attribute vec4 aOffset;
      attribute vec3 aParams;
      uniform float uTime;
      uniform float uWind;
      varying vec3 vWorld;
      varying float vTip;
      varying float vHue;
      varying vec3 vNormal;
      void main(){
        float t = position.y;
        float c = cos(aParams.x), s = sin(aParams.x);
        vec3 p = vec3(position.x * c - position.z * s, position.y * aOffset.w, position.x * s + position.z * c);
        vec3 base = aOffset.xyz;
        // rafales qui traversent l'herbe : un bruit qui défile, plus une petite oscillation propre à chaque brin
        float gust = vnoise(base.xz * 0.08 + vec2(uTime * 0.35, uTime * 0.12));
        float bend = (gust * 0.9 + 0.15 * sin(uTime * 2.3 + aParams.z * 6.28)) * uWind;
        p.x += bend * t * t * 0.55;
        p.z += bend * t * t * 0.25;
        p.y -= bend * bend * t * t * 0.12;
        vec4 w = modelMatrix * vec4(p + base, 1.0);
        vWorld = w.xyz;
        vTip = t;
        vHue = aParams.y;
        vNormal = normalize(vec3(-s * 0.3, 1.0, c * 0.3));
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vWorld;
      varying float vTip;
      varying float vHue;
      varying vec3 vNormal;
      void main(){
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 base = vec3(0.05, 0.08, 0.025);
        vec3 tip = mix(vec3(0.30, 0.34, 0.12), vec3(0.46, 0.36, 0.14), vHue);
        vec3 albedo = mix(base, tip, smoothstep(0.0, 1.0, vTip));
        float shadow = groundShadow(vWorld);
        float ndl = max(dot(normalize(vNormal), uSunDir), 0.0) * 0.6 + 0.4;
        // les pointes s'allument quand on regarde vers le soleil
        float back = pow(max(dot(-v, uSunDir), 0.0), 4.0) * vTip;
        vec3 sun = uSunColor * (ndl * 0.7 + back * 1.8 * vec3(1.0, 0.8, 0.4)) * shadow;
        vec3 amb = mix(uSkyHorizon, uSkyTop, 0.6) * uAmbient * (0.35 + vTip * 0.65);
        vec3 col = albedo * (sun + amb + lantern(vWorld, vec3(0.0, 1.0, 0.0)));
        col = applyFog(col, vWorld, cameraPosition);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}
