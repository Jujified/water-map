import * as THREE from 'three';
import type { MapData } from './data';
import { fullscreenQuad } from './gpu';
import { dotFrag, dotVert, decodeVert, stateFrag } from './shaders';

const STATE_W = 1024;

/**
 * Equal-area pointillist field. Dots are rejection-sampled against the
 * area-scale raster so each represents the same patch of Earth. A per-dot
 * "wetness" state lives in a ping-pong texture so dots that cross the
 * waterline fade their colour over ~300 ms.
 */
export class AbstractLayer {
  points: THREE.Points;
  material: THREE.RawShaderMaterial;
  count: number;
  private state: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private stateScene = new THREE.Scene();
  private stateMat: THREE.RawShaderMaterial;
  private cam = new THREE.Camera();
  private init = true;

  constructor(d: MapData, data: THREE.Texture, sphereTex: THREE.Texture, count: number) {
    this.count = count;
    const H = Math.ceil(count / STATE_W);
    const pos = new Float32Array(count * 3);
    const dotsUV = new Float32Array(STATE_W * H * 2);
    const rnd = new Uint8Array(count * 4);
    const A = d.area;
    const ag = d.meta.areaGrid;
    let n = 0;
    while (n < count) {
      const u = Math.random();
      const v = Math.random();
      const a = A[Math.floor((1 - v) * ag) * ag + Math.floor(u * ag)] ?? 0;
      if (Math.random() >= a) continue;
      pos[3 * n] = u;
      pos[3 * n + 1] = v;
      dotsUV[2 * n] = u;
      dotsUV[2 * n + 1] = v;
      rnd[4 * n] = (Math.random() * 256) | 0;
      rnd[4 * n + 1] = (Math.random() * 256) | 0;
      rnd[4 * n + 2] = (Math.random() * 256) | 0;
      rnd[4 * n + 3] = (Math.random() * 256) | 0;
      n++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4, true));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);

    const dotsTex = new THREE.DataTexture(dotsUV, STATE_W, H, THREE.RGFormat, THREE.FloatType);
    dotsTex.minFilter = dotsTex.magFilter = THREE.NearestFilter;
    dotsTex.needsUpdate = true;

    // radius factor per hypsometric bin: sqrt(area fraction / max)
    const fr = d.stats.histogram.fractions;
    const fmax = Math.max(...fr);
    const sizes = new Float32Array(fr.map((x) => Math.sqrt(x / fmax)));
    const sizesTex = new THREE.DataTexture(sizes, sizes.length, 1, THREE.RedFormat, THREE.FloatType);
    sizesTex.minFilter = sizesTex.magFilter = THREE.NearestFilter;
    sizesTex.needsUpdate = true;

    const rt = () =>
      new THREE.WebGLRenderTarget(STATE_W, H, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        generateMipmaps: false,
      });
    this.state = [rt(), rt()];

    this.stateMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: decodeVert,
      fragmentShader: stateFrag,
      uniforms: {
        uData: { value: data },
        uDots: { value: dotsTex },
        uPrev: { value: null },
        uLevel: { value: 0 },
        uStep: { value: 0.05 },
        uInit: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.stateScene.add(fullscreenQuad(this.stateMat));

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: dotVert,
      fragmentShader: dotFrag,
      uniforms: {
        uData: { value: data },
        uState: { value: this.state[0].texture },
        uSphere: { value: sphereTex },
        uSizes: { value: sizesTex },
        uStateW: { value: STATE_W },
        uGrid: { value: d.meta.lonlatGrid },
        uBins: { value: sizes.length },
        uBinStart: { value: d.stats.histogram.binStart },
        uBinSize: { value: d.stats.histogram.binSize },
        uLevel: { value: 0 },
        uMorph: { value: 1 },
        uRot: { value: new THREE.Matrix3() },
        uRadius: { value: 0.66 },
        uTime: { value: 0 },
        uPxPerUnit: { value: 400 },
        uDotRadius: { value: count > 500000 ? 0.0019 : 0.0034 },
        uDpr: { value: 1 },
        uDrift: { value: 0.0009 },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
  }

  /** Advance the per-dot wet/dry state toward the current water level. */
  update(renderer: THREE.WebGLRenderer, level: number, dt: number) {
    const [src, dst] = this.state;
    const u = this.stateMat.uniforms;
    u.uPrev.value = src.texture;
    u.uLevel.value = level;
    u.uStep.value = Math.min(1, dt / 0.3);
    u.uInit.value = this.init ? 1 : 0;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(dst);
    renderer.render(this.stateScene, this.cam);
    renderer.setRenderTarget(prev);
    this.state = [dst, src];
    this.material.uniforms.uState.value = dst.texture;
    this.init = false;
  }

  /** Snap all dots to their current wet/dry state on the next update. */
  snap() {
    this.init = true;
  }
}
