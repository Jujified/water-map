import * as THREE from 'three';
import { sphereAt, type MapData } from './data';

export const T_SPIN = 2.2;
export const T_TURN = 3.8;
export const T_UNWRAP = 6.4;
export const T_BG = 7.4;
export const T_END = 8.0;

export interface IntroFrame {
  rot: THREE.Matrix3;
  morph: number;
  bg: number; // 0 = space, 1 = paper / ultramarine
  edge: number; // edge fade amount for the realistic map
  ui: number;
}

const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

function quatFromRows(r1: THREE.Vector3, r2: THREE.Vector3, r3: THREE.Vector3): THREE.Quaternion {
  const m = new THREE.Matrix4().set(
    r1.x, r1.y, r1.z, 0,
    r2.x, r2.y, r2.z, 0,
    r3.x, r3.y, r3.z, 0,
    0, 0, 0, 1,
  );
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/**
 * Builds the globe -> square timeline. Sphere coordinates have z = north;
 * screen has +y up and +z toward the camera.
 */
export class Intro {
  private final: THREE.Quaternion;
  private centerLon: number;
  private tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.32);

  constructor(d: MapData) {
    const c = new THREE.Vector3(...sphereAt(d, 0.5, 0.5));
    const up = new THREE.Vector3(...sphereAt(d, 0.5, 0.505)).sub(c);
    up.addScaledVector(c, -up.dot(c)).normalize();
    const right = new THREE.Vector3().crossVectors(up, c);
    const east = new THREE.Vector3(...sphereAt(d, 0.505, 0.5)).sub(c);
    if (right.dot(east) < 0) console.warn('map is mirrored relative to the globe');
    this.final = quatFromRows(right, up, c);
    this.centerLon = Math.atan2(c.y, c.x);
  }

  private spin(t: number): THREE.Quaternion {
    const th = this.centerLon - THREE.MathUtils.degToRad(30) - THREE.MathUtils.degToRad(32) * (T_SPIN - t);
    const s = Math.sin(th);
    const co = Math.cos(th);
    const q = quatFromRows(new THREE.Vector3(-s, co, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(co, s, 0));
    return this.tilt.clone().multiply(q);
  }

  frame(t: number): IntroFrame {
    let q: THREE.Quaternion;
    if (t < T_SPIN) q = this.spin(t);
    else if (t < T_TURN) q = this.spin(T_SPIN).slerp(this.final, ease((t - T_SPIN) / (T_TURN - T_SPIN)));
    else q = this.final.clone();
    const rot = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
    const morph = ease((t - T_TURN) / (T_UNWRAP - T_TURN));
    const bg = ease((t - (T_UNWRAP - 0.5)) / (T_BG - T_UNWRAP + 0.5));
    return { rot, morph, bg, edge: bg, ui: ease((t - T_BG) / (T_END - T_BG)) };
  }
}
