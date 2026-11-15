import * as THREE from 'three';
import type { MapData } from './data';
import { decodeFrag, decodeVert } from './shaders';

function rawTexture(img: ImageBitmap): THREE.Texture {
  const t = new THREE.Texture(img);
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

let quadGeo: THREE.BufferGeometry | null = null;
export function fullscreenQuad(material: THREE.Material): THREE.Mesh {
  if (!quadGeo) {
    quadGeo = new THREE.BufferGeometry();
    quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  }
  const m = new THREE.Mesh(quadGeo, material);
  m.frustumCulled = false;
  return m;
}

/**
 * Decode the packed 8-bit PNGs into one RGBA half-float texture on the GPU:
 * r = elevation, g = flood level, b = ice fraction, a = km inland.
 */
export function decodeData(renderer: THREE.WebGLRenderer, d: MapData): THREE.WebGLRenderTarget {
  const n = d.size;
  const target = new THREE.WebGLRenderTarget(n, n, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
  });
  target.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const terrain = rawTexture(d.terrain);
  const flood = rawTexture(d.flood);
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: decodeVert,
    fragmentShader: decodeFrag,
    uniforms: {
      uTerrain: { value: terrain },
      uFlood: { value: flood },
      uOffset: { value: d.meta.elevationOffset },
      uDistUnit: { value: d.meta.distUnitKm },
      uSize: { value: n },
    },
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  scene.add(fullscreenQuad(mat));
  const cam = new THREE.Camera();
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  terrain.dispose();
  flood.dispose();
  mat.dispose();
  return target;
}

/** 513x513 RGBA32F texture of unit vectors for the vertex shaders. */
export function sphereTexture(d: MapData): THREE.DataTexture {
  const g = d.meta.lonlatGrid;
  const data = new Float32Array(g * g * 4);
  for (let i = 0; i < g * g; i++) {
    data[4 * i] = d.sphere[3 * i];
    data[4 * i + 1] = d.sphere[3 * i + 1];
    data[4 * i + 2] = d.sphere[3 * i + 2];
    data[4 * i + 3] = 1;
  }
  const t = new THREE.DataTexture(data, g, g, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
