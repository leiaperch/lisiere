import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { LAKE, trailPoint } from './terrain';
import { glslNoise, glslWorld, world } from './light';

// Ciel, étoiles, lune, lucioles et lac.

export function createSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world },
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // toujours au fond
      }`,
    fragmentShader: /* glsl */ `
      ${glslNoise}
      ${glslWorld}
      varying vec3 vDir;
      void main(){
        vec3 dir = normalize(vDir);
        vec3 col = skyColor(dir);
        // disque du soleil, adouci par la brume au ras de l'horizon
        float sd = dot(dir, uSunDir);
        col += uSunColor * smoothstep(0.9993, 0.9998, sd) * 2.5;
        // étoiles : n'apparaissent qu'avec la nuit, scintillent à peine
        float night = smoothstep(0.2, 1.0, uMoon);
        vec2 sp = vec2(atan(dir.x, dir.z), dir.y) * vec2(180.0, 160.0);
        float star = step(0.9965, hash12(floor(sp)));
        float tw = 0.6 + 0.4 * sin(uTime * 2.0 + hash12(floor(sp) + 3.0) * 30.0);
        col += vec3(0.8, 0.85, 1.0) * star * tw * night * smoothstep(0.05, 0.4, dir.y) * 0.9;
        // lune : disque avec un léger relief, halo dans le brouillard
        float md = dot(dir, uMoonDir);
        float disc = smoothstep(0.99962, 0.99975, md);
        float mare = 0.8 + 0.2 * vnoise(dir.xy * 900.0);
        col += vec3(0.95, 0.93, 0.85) * disc * mare * uMoon * 1.6;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), mat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

// Lucioles : quelques centaines de points qui dérivent et clignotent au-dessus de l'herbe
export function createFireflies(count = 420) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 2);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    // regroupées dans la seconde moitié de la balade, de part et d'autre du sentier
    const u = 0.52 + Math.random() * 0.47;
    trailPoint(u, p);
    const side = (Math.random() - 0.5) * 28;
    pos.set([p.x + side, p.y + 0.4 + Math.random() * 2.4, p.z + (Math.random() - 0.5) * 12], i * 3);
    seed.set([Math.random(), Math.random()], i * 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 2));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...world, uAmount: { value: 0 }, uPixel: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec2 aSeed;
      uniform float uTime;
      uniform float uAmount;
      uniform float uPixel;
      uniform vec4 uLantern;
      varying float vGlow;
      void main(){
        vec3 p = position;
        float t = uTime * (0.25 + aSeed.x * 0.3);
        p += vec3(sin(t + aSeed.y * 20.0), sin(t * 1.3 + aSeed.x * 11.0) * 0.5, cos(t * 0.8 + aSeed.y * 7.0)) * 0.9;
        // celles qui sont proches de la lanterne viennent tourner autour
        vec3 toL = uLantern.xyz - p;
        float pull = clamp(uLantern.w / 3.2, 0.0, 1.0) * (1.0 - smoothstep(2.0, 11.0, length(toL)));
        float ang = uTime * (0.6 + aSeed.x) + aSeed.y * 6.28;
        vec3 orbit = vec3(cos(ang), sin(ang * 0.7) * 0.4, sin(ang)) * (0.5 + aSeed.x * 0.9);
        p = mix(p, uLantern.xyz + orbit, pull * 0.85);
        // chaque luciole s'allume à son rythme, et seulement quand la nuit tombe
        float blink = smoothstep(0.1, 0.9, sin(uTime * (0.8 + aSeed.x) + aSeed.y * 40.0));
        vGlow = blink * step(aSeed.x, uAmount);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uPixel * 26.0 / -mv.z * (0.3 + vGlow * 0.9);
      }`,
    fragmentShader: /* glsl */ `
      varying float vGlow;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        float core = smoothstep(0.12, 0.0, d);
        float halo = smoothstep(0.5, 0.0, d) * 0.35;
        gl_FragColor = vec4(vec3(1.0, 0.86, 0.42) * (core * 3.0 + halo) * vGlow, 1.0);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

// Lac : miroir (rendu en demi-résolution, seulement quand il est à l'écran), rides et lune
export interface Lake {
  mesh: THREE.Mesh;
  ripple: (x: number, z: number, time: number) => void;
}

export function createLake(pixelRatio: number): Lake {
  const geo = new THREE.CircleGeometry(LAKE.radius * 1.35, 96);
  const reflector = new Reflector(geo, {
    textureWidth: Math.round(window.innerWidth * pixelRatio * 0.5),
    textureHeight: Math.round(window.innerHeight * pixelRatio * 0.5),
    clipBias: 0.003,
    color: 0xffffff,
  });
  reflector.rotation.x = -Math.PI / 2;
  reflector.position.set(LAKE.x, LAKE.level, LAKE.z);

  // le shader d'origine est remplacé : rides, fresnel, brouillard, lune
  const mat = reflector.material as THREE.ShaderMaterial;
  // jusqu'à 6 ricochets en même temps : x, z, instant, force
  const ripples = Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, -100, 0));
  mat.uniforms = { ...mat.uniforms, ...world, uRipples: { value: ripples } };
  mat.vertexShader = /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main(){
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`;
  mat.fragmentShader = /* glsl */ `
    ${glslNoise}
    ${glslWorld}
    uniform sampler2D tDiffuse;
    uniform vec4 uRipples[6];
    varying vec4 vUv;
    varying vec3 vWorld;
    void main(){
      vec3 v = normalize(cameraPosition - vWorld);
      // rides : deux bruits qui glissent, pour déformer le reflet
      vec2 q = vWorld.xz * 0.35;
      float r1 = vnoise(q + vec2(uTime * 0.15, uTime * 0.08));
      float r2 = vnoise(q * 2.3 - vec2(uTime * 0.11, -uTime * 0.13));
      vec2 ripple = (vec2(r1, r2) - 0.5) * 0.035;
      // ricochets : anneaux qui s'élargissent et s'amortissent
      float crest = 0.0;
      for (int i = 0; i < 6; i++) {
        vec4 r = uRipples[i];
        float age = uTime - r.z;
        if (age < 0.0 || age > 6.0) continue;
        vec2 d = vWorld.xz - r.xy;
        float dist = length(d);
        float front = dist - age * 2.6;
        float wave = sin(front * 7.0) * exp(-abs(front) * 1.4) * exp(-age * 0.7) * r.w;
        ripple += normalize(d + 1e-4) * wave * 0.06;
        crest += max(wave, 0.0);
      }
      vec4 uv = vUv;
      uv.xy += ripple * uv.w;
      vec3 refl = texture2DProj(tDiffuse, uv).rgb;
      float fresnel = 0.25 + 0.75 * pow(1.0 - max(v.y, 0.0), 4.0);
      vec3 deep = vec3(0.02, 0.035, 0.05);
      vec3 col = mix(deep, refl, fresnel);
      // traînée de lune scintillante sur l'eau
      vec3 r = reflect(-v, normalize(vec3(ripple.x * 8.0, 1.0, ripple.y * 8.0)));
      float glint = pow(max(dot(r, uMoonDir), 0.0), 180.0);
      col += vec3(0.9, 0.92, 1.0) * glint * uMoon * 2.2;
      float sglint = pow(max(dot(r, uSunDir), 0.0), 120.0);
      col += uSunColor * sglint * 0.8;
      // les crêtes des ondes accrochent la lumière du ciel
      col += (uSkyHorizon * 0.6 + vec3(0.6, 0.65, 0.8) * uMoon) * crest * 0.35;
      col = applyFog(col, vWorld, cameraPosition);
      gl_FragColor = vec4(col, 1.0);
    }`;
  mat.needsUpdate = true;
  let next = 0;
  return {
    mesh: reflector,
    ripple(x, z, time) {
      ripples[next].set(x, z, time, 1);
      next = (next + 1) % ripples.length;
    },
  };
}
