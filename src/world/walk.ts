import * as THREE from 'three';
import { TRAIL, heightAt, trailPoint } from './terrain';

// La marche : la caméra avance sur le sentier à hauteur d'yeux. Le défilement choisit la position,
// un amorti léger la rejoint. Le regard suit le chemin, avec des intentions par chapitre
// (lever les yeux vers la canopée, se tourner vers la clairière, suivre les lucioles, s'arrêter au lac).

interface Gaze {
  u: number;
  yaw: number; // radians, positif vers la gauche
  pitch: number; // radians, positif vers le haut
  eye: number; // hauteur des yeux au-dessus du sol
}

const GAZE: Gaze[] = [
  { u: 0.0, yaw: 0.18, pitch: 0.06, eye: 1.7 },
  { u: 0.12, yaw: 0.05, pitch: 0.02, eye: 1.65 },
  { u: 0.26, yaw: -0.12, pitch: 0.34, eye: 1.6 }, // sous-bois : on lève les yeux vers la canopée
  { u: 0.36, yaw: 0.0, pitch: 0.05, eye: 1.65 },
  { u: 0.47, yaw: -0.55, pitch: 0.02, eye: 1.7 }, // clairière, à droite du sentier
  { u: 0.58, yaw: -0.2, pitch: 0.0, eye: 1.65 },
  { u: 0.72, yaw: 0.35, pitch: -0.04, eye: 1.5 }, // lucioles dans l'herbe à gauche
  { u: 0.86, yaw: 0.0, pitch: 0.02, eye: 1.65 },
  { u: 1.0, yaw: -0.08, pitch: 0.06, eye: 2.4 }, // rive : on se redresse face au lac
];

export class Walk {
  u = 0; // position visée (défilement)
  current = 0; // position réelle, amortie
  private yaw = 0;
  private pitch = 0;
  private eye = 1.7;
  private look = new THREE.Vector2(); // regard libre à la souris
  private lookTarget = new THREE.Vector2();
  private p = new THREE.Vector3();
  private ahead = new THREE.Vector3();
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private stride = 0;

  constructor(private camera: THREE.PerspectiveCamera) {
    window.addEventListener('pointermove', (e) => {
      this.lookTarget.set((e.clientX / window.innerWidth - 0.5) * -0.22, (e.clientY / window.innerHeight - 0.5) * -0.12);
    });
  }

  // renvoie vrai tant que la caméra bouge encore
  update(dt: number) {
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * 3.2);
    const before = this.current;
    this.current += (this.u - this.current) * k;
    const speed = Math.abs(this.current - before) / Math.max(dt, 1e-3);

    // intentions du regard, interpolées en douceur entre les repères
    const g = this.gazeAt(this.current);
    const kg = 1 - Math.exp(-dt * 2.4);
    this.yaw += (g.yaw - this.yaw) * kg;
    this.pitch += (g.pitch - this.pitch) * kg;
    this.eye += (g.eye - this.eye) * kg;
    this.look.lerp(this.lookTarget, 1 - Math.exp(-dt * 2));

    trailPoint(this.current, this.p);
    trailPoint(Math.min(this.current + 0.025, 1), this.ahead);
    if (this.current > 0.975) {
      // au bout du sentier, on regarde droit devant, vers le lac
      TRAIL.getTangentAt(1, this.ahead).multiplyScalar(10).add(this.p);
    }
    // pas : léger balancement proportionnel à la vitesse de marche
    this.stride += speed * dt * 900;
    const bob = this.reduced ? 0 : Math.min(speed * 60, 1) * 0.035;
    const ground = heightAt(this.p.x, this.p.z, 0);
    this.camera.position.set(this.p.x + Math.cos(this.stride * 0.5) * bob * 0.6, ground + this.eye + Math.abs(Math.sin(this.stride)) * bob, this.p.z);

    const dir = this.ahead.sub(this.p);
    dir.y = 0;
    dir.normalize();
    const yaw = Math.atan2(-dir.x, -dir.z) + this.yaw + this.look.x;
    const pitch = this.pitch + this.look.y;
    this.camera.rotation.set(pitch, yaw, Math.sin(this.stride * 0.5) * bob * 0.05, 'YXZ');
    return Math.abs(this.u - this.current) > 1e-5 || speed > 1e-4;
  }

  private gazeAt(u: number) {
    let i = 0;
    while (i < GAZE.length - 2 && u > GAZE[i + 1].u) i++;
    const a = GAZE[i];
    const b = GAZE[i + 1];
    let k = THREE.MathUtils.clamp((u - a.u) / (b.u - a.u), 0, 1);
    k = k * k * (3 - 2 * k);
    return { yaw: a.yaw + (b.yaw - a.yaw) * k, pitch: a.pitch + (b.pitch - a.pitch) * k, eye: a.eye + (b.eye - a.eye) * k };
  }
}
