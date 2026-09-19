import * as THREE from 'three';

// Rendu en deux temps : la scène en HDR dans une texture (lumière physique, sans limite à 1),
// puis une passe d'étalonnage « cinéma » : exposition, courbe filmique, teinte des ombres selon l'heure,
// vignettage, grain, et un léger flou de mise au point pendant les changements de chapitre.

export class Post {
  readonly target: THREE.WebGLRenderTarget;
  readonly uniforms = {
    tScene: { value: null as THREE.Texture | null },
    uExposure: { value: 1 },
    uGrade: { value: new THREE.Color('#2a2018') },
    uTime: { value: 0 },
    uBlur: { value: 0 },
    uTexel: { value: new THREE.Vector2() },
    uFlash: { value: 0 },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uRays: { value: 0 },
    uRayColor: { value: new THREE.Color(1, 0.8, 0.5) },
  };
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(private renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.uniforms.tScene.value = this.target.texture;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform float uExposure;
        uniform vec3 uGrade;
        uniform float uTime;
        uniform float uBlur;
        uniform vec2 uTexel;
        uniform float uFlash;
        uniform vec2 uSunScreen;
        uniform float uRays;
        uniform vec3 uRayColor;
        varying vec2 vUv;

        vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
        float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

        void main(){
          vec3 col = texture2D(tScene, vUv).rgb;
          // respiration de l'objectif entre deux chapitres : flou doux sur 12 échantillons
          if (uBlur > 0.01) {
            vec3 acc = col;
            for (int i = 0; i < 12; i++) {
              float a = float(i) * 0.5236;
              float r = (i < 6 ? 1.0 : 2.0) * uBlur;
              acc += texture2D(tScene, vUv + vec2(cos(a), sin(a)) * r * uTexel).rgb;
            }
            col = acc / 13.0;
          }
          // rayons de soleil : on remonte vers le soleil à l'écran en accumulant le ciel très lumineux
          // qui passe entre les troncs (le feuillage, plus sombre, coupe les rayons)
          if (uRays > 0.01) {
            vec2 delta = (vUv - uSunScreen) * (0.85 / 18.0);
            vec2 uv = vUv;
            float decay = 1.0;
            float shafts = 0.0;
            for (int i = 0; i < 18; i++) {
              uv -= delta;
              vec3 s = texture2D(tScene, uv).rgb;
              shafts += max(dot(s, vec3(0.2126, 0.7152, 0.0722)) - 1.1, 0.0) * decay;
              decay *= 0.92;
            }
            col += uRayColor * shafts * uRays * 0.04;
          }
          col *= uExposure;
          col = aces(col);
          // étalonnage : ombres teintées par l'heure, hautes lumières légèrement réchauffées
          float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(col, col + uGrade * 0.9, (1.0 - smoothstep(0.0, 0.55, lum)) * 0.6);
          col = mix(col, col * vec3(1.03, 1.0, 0.95), smoothstep(0.5, 1.0, lum));
          // vignettage elliptique
          vec2 c = vUv - 0.5;
          col *= 1.0 - dot(c * vec2(1.1, 1.3), c * vec2(1.1, 1.3)) * 0.65;
          // grain argentique, plus visible dans les ombres
          float g = rnd(vUv * 1000.0 + fract(uTime * 7.3)) - 0.5;
          col += g * 0.022 * (1.0 - lum * 0.6);
          col += uFlash;
          gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  }

  setSize(w: number, h: number, dpr: number) {
    this.target.setSize(Math.round(w * dpr), Math.round(h * dpr));
    this.uniforms.uTexel.value.set(1 / (w * dpr), 1 / (h * dpr));
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    r.render(this.scene, this.camera);
  }
}
