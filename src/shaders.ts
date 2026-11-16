import { glslRamp, REAL_LAND, REAL_WATER, ABS_LAND, ABS_WATER } from './palette';

// ---------------------------------------------------------------------------
// Decode pass: RGB8 packed PNGs -> one RGBA half-float texture
//   r = elevation (m), g = flood level (m), b = ice fraction, a = km inland
// Output row 0 is the bottom of the map so `uv` (v up) samples it directly.
// ---------------------------------------------------------------------------
export const decodeVert = /* glsl */ `
in vec3 position;
void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const decodeFrag = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uTerrain;
uniform sampler2D uFlood;
uniform float uOffset;
uniform float uFloodBias;
uniform float uDistUnit;
uniform int uSize;
out vec4 outColor;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = uSize - 1 - p.y;           // PNG row 0 is the top of the map
  vec3 t = texelFetch(uTerrain, p, 0).rgb * 255.0;
  vec3 f = texelFetch(uFlood, p, 0).rgb * 255.0;
  float elev = t.r * 256.0 + t.g - uOffset;
  float flood = elev + f.r * 256.0 + f.g - uFloodBias;   // stored as flood - elevation + bias
  outColor = vec4(elev, flood, t.b / 255.0, f.b * uDistUnit);
}
`;

const common = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){ float s = 0.0, a = 0.5; for(int i=0;i<3;i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; } return s; }
// water test shared by both modes: rises use the priority-flood level,
// drops below 0 m use raw elevation. Present-day lakes carry flood = -11000,
// so min(elevation, flood) keeps them wet when the sea drops too.
float waterValue(vec4 d, float level){ return level >= 0.0 ? d.g : min(d.r, d.g); }
// 1 inside present-day lakes (flood far below the ground), 0 elsewhere
float lakeness(vec4 d){ return clamp((d.r - d.g - 2.0) / 60.0, 0.0, 1.0); }  // ocean: g == r, land: g >= r
`;

// ---------------------------------------------------------------------------
// Realistic map mesh
// ---------------------------------------------------------------------------
export const realVert = /* glsl */ `
in vec3 sphere;
uniform mat3 uRot;
uniform float uMorph;
uniform float uRadius;
out vec2 vUv;
out vec3 vSphere;
out float vFront;
void main(){
  vec3 s = uRot * sphere;
  vec3 p = mix(s * uRadius, position, uMorph);
  vUv = uv;
  vSphere = sphere;
  vFront = s.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const realFrag = /* glsl */ `
precision highp float;
uniform sampler2D uData;
uniform float uLevel;
uniform float uOpacity;
uniform float uEdge;      // 0 = full globe, 1 = edge-faded map
uniform float uTexel;     // 1 / texture size
uniform float uKmPerTexel;
uniform float uGrat;
uniform vec3 uPaper;
in vec2 vUv;
in vec3 vSphere;
in float vFront;
out vec4 outColor;
${common}
${glslRamp('landRamp', REAL_LAND)}
${glslRamp('waterRamp', REAL_WATER)}

float graticule(vec3 s){
  s = normalize(s);
  float lat = degrees(asin(clamp(s.z, -1.0, 1.0)));
  float lon = degrees(atan(s.y, s.x));
  float fl = abs(fract(lat / 15.0 + 0.5) - 0.5) * 15.0;
  float fo = abs(fract(lon / 15.0 + 0.5) - 0.5) * 15.0;
  float wl = fwidth(lat), wo = fwidth(lon);
  // avoid the atan seam blowing up fwidth
  wo = wo > 90.0 ? wl : wo;
  float ll = 1.0 - smoothstep(0.35, 1.1, fl / max(wl, 1e-4));
  float lo = 1.0 - smoothstep(0.35, 1.1, fo / max(wo, 1e-4));
  lo *= 1.0 - smoothstep(75.0, 84.0, abs(lat)); // meridians stop short of the poles
  return max(ll, lo);
}

void main(){
  vec4 d = texture(uData, vUv);
  float elev = d.r;
  float cmp = waterValue(d, uLevel);
  float aa = max(fwidth(cmp) * 0.6, 0.5);
  float water = 1.0 - smoothstep(-aa, aa, cmp - uLevel);

  // hillshade from elevation normals, footprint-aware so it holds at any zoom
  vec2 fw = max(fwidth(vUv), vec2(uTexel));
  float o = max(fw.x, fw.y) * 1.2;
  float eL = texture(uData, vUv - vec2(o, 0.0)).r;
  float eR = texture(uData, vUv + vec2(o, 0.0)).r;
  float eD = texture(uData, vUv - vec2(0.0, o)).r;
  float eU = texture(uData, vUv + vec2(0.0, o)).r;
  float span = 2.0 * (o / uTexel) * uKmPerTexel * 1000.0;
  vec2 grad = vec2(eR - eL, eU - eD) / span;
  float exag = mix(22.0, 12.0, water);
  vec3 n = normalize(vec3(-grad * exag, 1.0));
  vec3 L = normalize(vec3(-1.0, 1.0, 1.35));
  float shade = dot(n, L) / dot(vec3(0,0,1), L);

  float h = elev - uLevel;
  vec3 land = landRamp(max(h, 0.0));
  land = mix(land, vec3(0.97, 0.975, 0.985), smoothstep(0.35, 0.8, d.b));
  float lake = lakeness(d);
  vec3 sea = mix(waterRamp(max(-h, 0.0)), waterRamp(40.0), lake);
  vec3 col = mix(land * clamp(mix(1.0, shade, 0.85), 0.45, 1.35),
                 sea * clamp(mix(1.0, shade, 0.55), 0.7, 1.2), water);

  col = mix(col, vec3(1.0), uGrat * graticule(vSphere));

  // dissolve land into paper with distance inland from today's ocean
  // distance is per-mille of the map width, so compact continents near the
  // centre (Africa, Australia) stay whole while the inflated interiors near
  // the square's edges dissolve, as on the reference map
  float nz = (fbm(vUv * 34.0) - 0.5) * 14.0 + (fbm(vUv * 180.0) - 0.5) * 5.0;
  float dist = d.a + nz;
  float landA = 1.0 - smoothstep(36.0, 55.0, dist);
  float seaA = 1.0 - smoothstep(70.0, 110.0, dist);
  landA = max(landA, smoothstep(0.35, 0.8, d.b)); // ice sheets stay white, as in the reference map
  float a = mix(landA, seaA, water * (1.0 - lake)); // lakes fade with the land
  a = mix(1.0, a, uEdge);
  // warm the fringe toward the paper so the fade reads as pigment, not alpha
  col = mix(col, mix(col, uPaper, 0.35), (1.0 - a) * uEdge);
  outColor = vec4(col, a * uOpacity);
}
`;

// ---------------------------------------------------------------------------
// Abstract particle field
// ---------------------------------------------------------------------------
export const stateFrag = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uData;
uniform sampler2D uDots;   // RG32F: map uv per dot
uniform sampler2D uPrev;
uniform float uLevel;
uniform float uStep;       // dt / 0.3 s
uniform float uInit;
out vec4 outColor;
${common}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 uv = texelFetch(uDots, p, 0).rg;
  vec4 d = textureLod(uData, uv, 0.0);
  float target = waterValue(d, uLevel) <= uLevel ? 1.0 : 0.0;
  float prev = texelFetch(uPrev, p, 0).r;
  float w = uInit > 0.5 ? target : prev + clamp(target - prev, -uStep, uStep);
  outColor = vec4(w, 0.0, 0.0, 1.0);
}
`;

export const dotVert = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position;      // (u, v, unused)
in vec4 aRand;         // phase, delay, tone, size jitter
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform sampler2D uData;
uniform sampler2D uState;
uniform sampler2D uSphere;   // RGBA32F 513x513, row 0 = top
uniform sampler2D uSizes;    // R32F, radius factor per histogram bin
uniform int uStateW;
uniform int uGrid;
uniform int uBins;
uniform float uBinStart;
uniform float uBinSize;
uniform float uLevel;
uniform float uMorph;
uniform mat3 uRot;
uniform float uRadius;
uniform float uTime;
uniform float uPxPerUnit;
uniform float uDotRadius;   // map units for the most common elevation
uniform float uDpr;
uniform float uDrift;
out vec3 vColor;
out float vAlpha;
${glslRamp('landRamp', ABS_LAND)}
${glslRamp('waterRamp', ABS_WATER)}
${common}

vec3 sphereAt(vec2 uv){
  float g = float(uGrid - 1);
  vec2 f = vec2(uv.x, 1.0 - uv.y) * g;
  ivec2 i = ivec2(min(floor(f), vec2(g - 1.0)));
  vec2 t = f - vec2(i);
  vec3 a = texelFetch(uSphere, i, 0).xyz;
  vec3 b = texelFetch(uSphere, i + ivec2(1,0), 0).xyz;
  vec3 c = texelFetch(uSphere, i + ivec2(0,1), 0).xyz;
  vec3 e = texelFetch(uSphere, i + ivec2(1,1), 0).xyz;
  return normalize(mix(mix(a, b, t.x), mix(c, e, t.x), t.y));
}

void main(){
  int id = gl_VertexID;
  vec2 uv = position.xy;
  vec4 d = textureLod(uData, uv, 0.0);
  float wet = texelFetch(uState, ivec2(id % uStateW, id / uStateW), 0).r;

  // size: radius ~ sqrt(area fraction of this elevation bin)
  int bin = clamp(int(floor((d.r - uBinStart) / uBinSize)), 0, uBins - 1);
  float f = texelFetch(uSizes, ivec2(bin, 0), 0).r * (0.85 + 0.3 * aRand.w);

  // colour: elevation relative to the water level
  float h = d.r - uLevel;
  vec3 land = landRamp(max(h, 0.0));
  float lake = lakeness(d);
  vec3 sea = mix(waterRamp(max(-h, 0.0)), waterRamp(40.0), lake);
  vec3 col = mix(land, sea, wet);
  // pointillist variation: most dots near the ramp, some lifted toward white,
  // some pushed darker
  float tone = aRand.z;
  col *= 0.9 + 0.2 * fract(tone * 7.31);
  col = mix(col, vec3(1.0), smoothstep(0.82, 1.0, tone) * mix(0.55, 0.35, wet));
  col = mix(col, col * col * 0.9, smoothstep(0.18, 0.0, tone) * 0.8);
  col = mix(col, vec3(1.0), smoothstep(0.55, 0.9, d.b) * (1.0 - wet) * 0.8);
  vColor = col;

  // position: sphere -> map, per-dot delay
  vec2 plane = uv * 2.0 - 1.0;
  float ph = aRand.x * 6.2831853;
  plane += uDrift * vec2(sin(uTime * 0.61 + ph), cos(uTime * 0.47 + ph * 1.7));
  float dly = 0.4 * clamp(length(uv - 0.5) * 1.4142, 0.0, 1.0) + 0.2 * aRand.y;
  float m = clamp((uMorph * 1.6 - dly) / 1.0, 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  vec3 s = vec3(0.0, 0.0, 1.0);
  vec3 p = vec3(plane, 0.0);
  if (m < 1.0) {  // the sphere lookup is only needed during the intro
    s = uRot * sphereAt(uv);
    p = mix(s * uRadius * (1.0 + 0.004 * aRand.z), p, m);
  }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);

  float diam = 2.0 * uDotRadius * f * uPxPerUnit;
  gl_PointSize = max(diam, 1.0) * uDpr;
  vAlpha = mix(smoothstep(-0.2, 0.15, s.z), 1.0, m) * clamp(diam, 0.35, 1.0);
}
`;

export const dotFrag = /* glsl */ `
precision highp float;
uniform float uOpacity;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float a = 1.0 - smoothstep(0.55, 1.0, r);
  if (a <= 0.0) discard;
  outColor = vec4(vColor, a * 0.9 * vAlpha * uOpacity);
}
`;
