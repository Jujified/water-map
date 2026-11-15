import * as THREE from 'three';
import type { MapData } from './data';
import { hexRgb, PAPER } from './palette';
import { realFrag, realVert } from './shaders';

/**
 * Regular grid in map space whose vertices also carry their sphere position
 * (from the lon/lat lookup), so the intro can morph globe <-> square.
 */
export class RealisticLayer {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  constructor(d: MapData, data: THREE.Texture) {
    const g = d.meta.lonlatGrid;
    const pos = new Float32Array(g * g * 3);
    const uv = new Float32Array(g * g * 2);
    const sph = new Float32Array(g * g * 3);
    for (let j = 0; j < g; j++) {
      for (let i = 0; i < g; i++) {
        const k = j * g + i;
        const u = i / (g - 1);
        const v = 1 - j / (g - 1); // lookup row 0 is the top of the map
        pos[3 * k] = u * 2 - 1;
        pos[3 * k + 1] = v * 2 - 1;
        uv[2 * k] = u;
        uv[2 * k + 1] = v;
        sph.set(d.sphere.subarray(3 * k, 3 * k + 3), 3 * k);
      }
    }
    const idx = new Uint32Array((g - 1) * (g - 1) * 6);
    let p = 0;
    for (let j = 0; j < g - 1; j++) {
      for (let i = 0; i < g - 1; i++) {
        const a = j * g + i;
        const b = a + 1;
        const c = a + g;
        const e = c + 1;
        idx.set([a, c, b, b, c, e], p);
        p += 6;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('sphere', new THREE.BufferAttribute(sph, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: realVert,
      fragmentShader: realFrag,
      uniforms: {
        uData: { value: data },
        uLevel: { value: 0 },
        uOpacity: { value: 1 },
        uEdge: { value: 1 },
        uTexel: { value: 1 / d.size },
        // nominal ground size of a texel; Spilhaus scale varies, this only
        // calibrates hillshade strength
        uKmPerTexel: { value: (2 * d.meta.halfWidth) / d.size / 1000 },
        uGrat: { value: 0.22 },
        uPaper: { value: new THREE.Vector3(...hexRgb(PAPER)) },
        uRot: { value: new THREE.Matrix3() },
        uMorph: { value: 1 },
        uRadius: { value: 0.66 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
  }
}
