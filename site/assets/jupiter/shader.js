// Jupiter — GLSL sources.
// Three passes:
//   BAKE      renders the *static* cloud turbulence field (and the polar
//             cyclone field) into an equirectangular atlas, once. It is a
//             function of the sheared planet-frame unit vector only, so it
//             never has to be re-baked; every animated term stays on screen.
//   PLANET    renders the shaded disc into an offscreen texture with analytic
//             limb coverage in alpha and *premultiplied* colour in rgb. In
//             `baked` mode it samples the atlas instead of evaluating ~18
//             simplex octaves per pixel; in `procedural` mode (still frames,
//             or hardware that cannot bake) it evaluates the same functions
//             directly. Both modes share every other formula.
//   COMPOSITE upsamples to the canvas, blends against the ground colour, adds
//             a tight bloom from the bright cloud tops, optional grain, dithers.
//
// Two planet paths, chosen by the renderer:
//   halfFloat:false  (LDR) — tonemap (ACES) + gamma-encode in the planet pass;
//                           the FBO is RGBA8, so the pass dithers before the write.
//   halfFloat:true   (HDR) — write linear radiance; composite tonemaps + encodes.
//
// All shading happens in linear light. Palette stops are authored as sRGB hex
// below and linearised here so the shader receives exact constants.

const srgbToLinear = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.pow(v / 255, 2.2).toFixed(5);
  return `vec3(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
};

// Cloud-altitude ramp, deep → high (brief §1.3).
export const PALETTE = {
  C0: '#40190F', // deep chromophores
  C1: '#944426', // rust / brick
  C2: '#D0853A', // ochre / amber
  C3: '#EAD5A8', // cream
  C4: '#FBF3E3', // ammonia plume tops
  GRS_CORE: '#953A1F',
  GRS_MANTLE: '#CF6A36',
  GRS_COLLAR: '#EAD5A8',
  POLE: '#5A6675',
  AMBIENT: '#141522',   // coloured shadow — never black
  TWILIGHT: '#CC5E24',  // warm terminator
  RAYLEIGH: '#7E90A8',  // blue-grey limb scatter
};

const defines = Object.entries(PALETTE)
  .map(([k, v]) => `#define ${k} ${srgbToLinear(v)}`)
  .join('\n');

// Ground colour as the composite writes it: sRGB-encoded #0F0906 — must match
// --ground in site.css. Exported so the renderer can clear to the same value.
export const GROUND_RGB = [0.0588, 0.0353, 0.0235];
const GROUND_SRGB = `vec3(${GROUND_RGB.join(', ')})`;

// Fixed per-octave rotation for fbm/ridged: non-trivial angles about all three
// axes so no two octave lattices share an orientation (brief §2.1). Baked once
// here — no trig in the shader.
const OCTAVE_ROT = (() => {
  const [ax, ay, az] = [0.61, 1.07, 0.43];
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  // R = Rz * Ry * Rx, column-major for GLSL mat3
  const m = [
    cy * cz,                 cy * sz,                -sy,
    sx * sy * cz - cx * sz,  sx * sy * sz + cx * cz,  sx * cy,
    cx * sy * cz + sx * sz,  cx * sy * sz - sx * cz,  cx * cy,
  ];
  return `mat3(${m.map((v) => v.toFixed(7)).join(', ')})`;
})();

// ---------------------------------------------------------------------------
// Latitude LUT (brief §2.5). jets() and bands() are functions of latitude only;
// they are evaluated here on the CPU and sampled as one LINEAR texture read.
// The formulas are the ones the shader used to evaluate per pixel — keep them
// byte-identical to preserve the look.
// ---------------------------------------------------------------------------
export const LUT_SIZE = 512;

const g = (x, w) => Math.exp(-Math.pow(x / w, 2));

// Measured zonal wind, normalised. Prograde equatorial jet, alternating beyond.
function jets(d) {
  const a = Math.abs(d);
  return 1.00 * g(d, 9.5)
       - 0.52 * g(a - 17.0, 5.5)
       + 0.46 * g(a - 25.0, 5.0)
       - 0.34 * g(a - 35.0, 6.0)
       + 0.27 * g(a - 45.0, 6.5)
       - 0.20 * g(a - 56.0, 7.5)
       + 0.13 * g(a - 67.0, 8.0);
}
// Belt / zone structure as a base cloud altitude.
function bands(d) {
  let b = 0.48 + 0.22 * jets(d);
  b += 0.06 * g(d, 6.0);          // Equatorial Zone, high & bright
  b -= 0.36 * g(d - 16.5, 5.0);   // NEB
  b -= 0.33 * g(d + 16.0, 5.5);   // SEB
  b -= 0.12 * g(d - 31.0, 4.0);   // NTB
  b -= 0.10 * g(d + 33.0, 4.5);   // STB
  return b;
}

// R = wind, [-1,1] → [0,255]; G = band altitude, clamped [0,1] → [0,255];
// B, A = 255 (spare). Texel i is centred on latitude −90 + 180·(i+0.5)/N, which
// is exactly where texture2D(uLut, vec2((lat+90)/180, 0.5)) lands with LINEAR
// filtering, so the sample reproduces the formula without a half-texel skew.
export function buildLatitudeLUT() {
  const out = new Uint8Array(LUT_SIZE * 4);
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < LUT_SIZE; i++) {
    const lat = -90 + 180 * (i + 0.5) / LUT_SIZE;
    out[i * 4 + 0] = q((jets(lat) + 1) * 0.5);
    out[i * 4 + 1] = q(bands(lat));
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared GLSL fragments
// ---------------------------------------------------------------------------
const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

// ACES filmic tonemap approximation: Krzysztof Narkowicz (used with permission, free to use)
// https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/
const ACES = `
vec3 aces(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
`;

// hash21: Dave Hoskins, "Hash without Sine" (MIT) — https://www.shadertoy.com/view/4djSRW
const HASH21 = `
float hash21(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
`;

// 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT).
// Copyright (C) 2011 Ashima Arts. https://github.com/ashima/webgl-noise
// Gradient noise with a
// tetrahedral lattice: no axis-aligned structure, and the permutation polynomial
// keeps every intermediate small enough to be precision-safe. Returns ~[-1, 1].
const SIMPLEX = `
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 E = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 gg = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - gg;
  vec3 i1 = min(gg.xyz, l.zxy);
  vec3 i2 = max(gg.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - E.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * E.wyz - E.xzx;
  vec4 j  = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x  = x_ * ns.x + ns.yyyy;
  vec4 y  = y_ * ns.x + ns.yyyy;
  vec4 h  = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

// Noise constants + the two multifractals + the cloud fields built from them.
// Shared verbatim by the bake pass and the procedural planet pass so the two
// modes cannot drift apart.
const NOISE_LIB = `
#define MAX_OCT 14
const mat3  ROT  = ${OCTAVE_ROT};            // per-octave lattice rotation
const float LOG2_LACUNARITY = 1.0215;        // log2(2.03)
const float NOISE_FEATURE   = 0.6;           // simplex feature width at octave 0, noise units
const float TURB_SCALE = 5.0;                // turbulence domain scale on the unit sphere
const float TURB_SQUASH = 6.0;               // latitudinal squash: features 6x longer in longitude
const float CYC_SCALE = 16.0;                // polar cyclone domain scale

${SIMPLEX}

float gnoise(vec3 p){ return 0.5 + 0.5 * snoise(p); }   // [0,1], drop-in for the old value noise

// Octave counts are fractional: the last octave fades in with weight k so that
// a count that varies across the disc (it is driven by pixel footprint) never
// produces a visible contour where the count steps.
float fbm(vec3 p, float oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < MAX_OCT; i++){
    float k = clamp(oct - float(i), 0.0, 1.0);
    if (k <= 0.0) break;
    s += a * k * gnoise(p); n += a * k;
    p = ROT * p * 2.03 + 11.7; a *= 0.5;
  }
  return s / max(n, 1e-4);
}
// Ridged multifractal: sharp filaments instead of mush (brief §1.4).
float ridged(vec3 p, float oct){
  float s = 0.0, a = 0.5, n = 0.0, w = 1.0;
  for (int i = 0; i < MAX_OCT; i++){
    float k = clamp(oct - float(i), 0.0, 1.0);
    if (k <= 0.0) break;
    float r = 1.0 - abs(snoise(p));
    r *= r; r *= w;
    w = clamp(r * 1.7, 0.0, 1.0);
    s += a * k * r; n += a * k;
    p = ROT * p * 2.07 + 5.3; a *= 0.5;
  }
  return s / max(n, 1e-4);
}

// Octave budget from a footprint in squashed turbulence-noise units: octave i
// has features ~NOISE_FEATURE/2.03^i wide; octaves stop once features drop
// below ~a quarter of the footprint (the last one fades in fractionally).
float octaveBudget(float fp){ return log2(NOISE_FEATURE / max(fp, 1e-9)) / LOG2_LACUNARITY + 2.0; }

// The cloud turbulence field: fBm / ridged mix, evaluated at a unit vector in
// the sheared planet frame (post-warp). Squashed 6x in latitude.
float turbAt(vec3 q, float oct){
  vec3  qq = vec3(q.x, q.y * TURB_SQUASH, q.z) * TURB_SCALE;
  float f1 = fbm(qq, oct - 1.0);
  float r1 = ridged(qq * 1.35 + 7.1, oct);
  return mix(f1, r1, 0.45);
}
// Polar cyclone cells (only read where the polar hood is visible, |lat| > 60).
float cycAt(vec3 q, float oct){ return ridged(q * CYC_SCALE + 3.3, min(oct, 7.0)); }
`;

// Cloud fields → linear albedo. Identical in both planet modes.
//   turb  turbulence [0,1]        cyc  polar cyclone field [0,1]
//   prof  latitude LUT (wind, band altitude)   dLat  degrees
//   lat/lon  planet-frame radians (for the Great Red Spot)
// The ammonia-plume HDR overshoot is applied last, weighted by how much of
// the pixel is still plain cloud (not hood, not spot) — plumes only exist in
// the equatorial zone, so this equals the old pre-mix overshoot everywhere it
// can be seen, and it keeps the overshoot a scalar on top of a [0,1] albedo.
const ALBEDO_LIB = `
vec3 albedo(float turb, float cyc, vec2 prof, float dLat, float lat, float lon, float oct){
  // ---- cloud altitude → colour ----
  float alt = prof.y + (turb - 0.5) * 0.40;
  alt = clamp(alt, 0.0, 1.0);
  alt = mix(alt, alt * alt * (3.0 - 2.0 * alt), 0.55);      // gentle S-curve

  vec3 c = mix(C0, C1, smoothstep(0.00, 0.35, alt));
  c = mix(c, C2, smoothstep(0.35, 0.62, alt));
  c = mix(c, C3, smoothstep(0.62, 0.82, alt));
  c = mix(c, C4, smoothstep(0.90, 1.00, alt));
  float plume = smoothstep(0.955, 1.0, alt);

  // vibrance: lift saturation in the mids only
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, 1.0 + 0.14 * (1.0 - abs(2.0 * alt - 1.0)));

  // ---- blue-grey polar hoods with cyclone cells ----
  float pole = smoothstep(60.0, 80.0, abs(dLat));
  vec3 pc = mix(POLE * 0.55, POLE * 1.55, cyc);
  c = mix(c, pc, pole);

  // ---- Great Red Spot: always procedural (its spiral turns 16 deg/s) ----
  float m = 0.0;
  {
    float gLon = radians(-75.0) - uTime * 0.010;
    float dl = mod(lon - gLon + PI, 2.0 * PI) - PI;
    vec2  gv = vec2(dl * cos(lat) / radians(12.5), (lat - radians(-22.0)) / radians(7.5));
    float r  = length(gv);
    m = smoothstep(1.22, 0.42, r);
    if (m > 0.002){
      float ang = atan(gv.y, gv.x) + (1.3 - min(r, 1.3)) * 2.7 + uTime * 0.28;
      vec2  gs  = vec2(cos(ang), sin(ang)) * r;
      float gn  = ridged(vec3(gs * 3.4, 5.0), min(oct, 8.0));
      vec3  gc  = mix(GRS_CORE, GRS_MANTLE, gn);
      gc = mix(gc, GRS_COLLAR * 1.15, smoothstep(0.92, 1.18, r) * 0.75);
      c = mix(c, gc, m);
    }
  }

  c *= 1.0 + plume * 0.55 * (1.0 - pole) * (1.0 - m);      // HDR overshoot, thin plume tops only
  return c;
}
`;

export const VERT = `
attribute vec2 a;
void main(){ gl_Position = vec4(a, 0.0, 1.0); }
`;

// ---------------------------------------------------------------------------
// Bake pass — the static cloud atlas
// ---------------------------------------------------------------------------
// Equirectangular over the unit sphere in the *sheared* planet frame:
//   u → longitude (−π..π, wraps), v → latitude (−π/2..π/2).
//   R = turbulence, G = polar cyclone field (|lat| > 55° only), B = 0, A = 1.
// Octaves are capped by the texel footprint with the same rule the screen pass
// uses for pixels, so the atlas holds exactly the detail it can represent and
// the count varies smoothly with latitude (no contours).
// Uniforms: uRes = atlas size | uOct = octave ceiling
export function FRAG_BAKE() {
  return `${PRECISION}
${defines}
uniform vec2  uRes;
uniform float uOct;

const float PI = 3.14159265359;
${NOISE_LIB}

void main(){
  vec2  uv  = gl_FragCoord.xy / uRes;
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (uv.y - 0.5) * PI;
  float cl  = cos(lat);
  vec3  q   = vec3(cl * cos(lon), sin(lat), cl * sin(lon));

  float tx = 2.0 * PI / uRes.x * cl, ty = PI / uRes.y;    // texel on the sphere, radians
  float fp = sqrt((TURB_SCALE * tx) * (TURB_SCALE * TURB_SQUASH * ty));
  float oct = clamp(min(uOct, octaveBudget(fp)), 1.0, float(MAX_OCT));
  float turb = turbAt(q, oct);

  float cyc = 0.0;
  if (abs(degrees(lat)) > 55.0){
    float fpc = sqrt((CYC_SCALE * tx) * (CYC_SCALE * ty));
    cyc = cycAt(q, clamp(min(uOct, octaveBudget(fpc)), 1.0, float(MAX_OCT)));
  }
  gl_FragColor = vec4(turb, cyc, 0.0, 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// Planet pass
// ---------------------------------------------------------------------------
// opts.baked emits #define BAKED: the turbulence / cyclone fields come from
// the atlas (uAtlas, unit 2) instead of being evaluated per pixel.
export function FRAG_PLANET({ hq = false, halfFloat = false, baked = false } = {}) {
  return `#extension GL_OES_standard_derivatives : enable
${baked ? '#extension GL_EXT_shader_texture_lod : enable' : ''}
${PRECISION}
${defines}
${halfFloat ? '#define HDR 1' : ''}
${hq ? '#define HQ 1' : ''}
${baked ? '#define BAKED 1' : ''}

uniform vec2  uRes;
uniform vec2  uView;     // camera lat, lon (radians, world frame)
uniform vec2  uOffset;   // screen offset in height-units
uniform float uTime, uFov, uSpin, uOct;
uniform sampler2D uLut;  // latitude LUT: R = wind, G = band altitude
uniform vec2  uPixel;    // 1 / FBO size
#ifdef BAKED
uniform sampler2D uAtlas;   // equirect cloud atlas: R = turbulence, G = cyclones
uniform float uAtlasLod;    // explicit LOD when derivatives are unavailable
uniform float uAtlasGrad;   // gradient scale (< 1 = sharper mip pick; the supersample absorbs the aliasing)
#endif

const float PI   = 3.14159265359;
const float CAMD = 3.6;                      // camera distance, planet radii
const vec3  RAD  = vec3(1.0, 0.9351, 1.0);   // oblateness 1/15.4
// Zonal shear grows without bound with uTime, and after ~60 s every cloud
// feature is stretched into a sub-pixel line (no octave policy can filter
// that). SHEAR_TAU saturates the shear clock, t -> TAU*(1 - exp(-t/TAU)),
// so the pattern settles instead of thinning forever.
const float SHEAR_TAU = 12.0;

${NOISE_LIB}
${ACES}
${HASH21}
${ALBEDO_LIB}

mat3 rotY(float t){ float c = cos(t), s = sin(t); return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c); }

// Latitude profile from the LUT (brief §2.5): x = wind [-1,1], y = band altitude.
vec2 latProfile(float dLat){
  vec4 t = texture2D(uLut, vec2((dLat + 90.0) / 180.0, 0.5));
  return vec2(t.r * 2.0 - 1.0, t.g);
}

#ifdef BAKED
// Atlas fetch with the equirect seam handled. lon = atan() is discontinuous
// at ±π, so the hardware derivative along that line is ~1 and mip selection
// would drop to the smallest level — a seam that sweeps across the disc as
// the planet spins. Two candidate u coordinates with branch cuts half a turn
// apart: whichever has the smaller screen-space derivative is continuous
// here, and REPEAT wrapping makes the two address the same texels.
vec4 atlasFetch(vec3 q){
  float lat = asin(clamp(q.y, -1.0, 1.0));
  float lon = atan(q.z, q.x);
  float v  = lat / PI + 0.5;
  float u1 = lon / (2.0 * PI) + 0.5;
  float u2 = fract(u1 + 0.5);
#ifdef GL_OES_standard_derivatives
  vec2 d1 = vec2(dFdx(u1), dFdy(u1));
  vec2 d2 = vec2(dFdx(u2), dFdy(u2));
  bool two = dot(d2, d2) < dot(d1, d1);
  float u  = two ? u2 - 0.5 : u1;
  vec2  du = two ? d2 : d1;
  #ifdef GL_EXT_shader_texture_lod
  return texture2DGradEXT(uAtlas, vec2(u, v), vec2(du.x, dFdx(v)) * uAtlasGrad, vec2(du.y, dFdy(v)) * uAtlasGrad);
  #else
  return texture2D(uAtlas, vec2(u, v));   // derivatives are per-quad, so the choice is quad-uniform
  #endif
#elif defined(GL_EXT_shader_texture_lod)
  return texture2DLodEXT(uAtlas, vec2(u1, v), uAtlasLod);
#else
  return texture2D(uAtlas, vec2(u1, v));  // never selected by the renderer
#endif
}
#endif

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y - uOffset;

  float cl = uView.x, cn = uView.y;
  vec3 ro = CAMD * vec3(cos(cl) * sin(cn), sin(cl), cos(cl) * cos(cn));
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
  vec3 up = cross(fw, rt);
  float tanHalf = tan(uFov * 0.5);
  vec3 rd = normalize(fw / tanHalf + rt * (uv.x * 2.0) + up * (uv.y * 2.0));

  // ---- ray / ellipsoid, with analytic limb coverage (brief §2.3) ----
  // In the unit-sphere frame the ray's impact parameter is bp; the limb is
  // bp = 1. d(bp)/d(pixel) at the limb is analytic, so the edge is feathered
  // over exactly ~1 pixel regardless of zoom or FBO size.
  vec3 o = ro / RAD, dr = rd / RAD;
  float A = dot(dr, dr), B = dot(o, dr), C = dot(o, o) - 1.0;
  float h  = B * B - A * C;
  float bp = sqrt(max(C + 1.0 - B * B / A, 0.0));    // dot(o,o) = C + 1
  float cosE = sqrt(1.0 - 1.0 / (CAMD * CAMD));
  float dbp = 2.0 * CAMD * tanHalf * cosE * cosE * cosE * uPixel.y;
  float coverage = 1.0 - smoothstep(-0.5, 0.5, (bp - 1.0) / dbp);

  // Surface point. Misses inside the feather take the ray's closest approach,
  // snapped onto the ellipsoid, so the AA fringe is shaded like the limb.
  vec3 p  = ro + rd * ((-B - sqrt(max(h, 0.0))) / A);
  vec3 q  = normalize(p / RAD);
  p = q * RAD;
  vec3 n  = normalize(q / RAD);
  vec3 qr = rotY(-uSpin) * q;

  float lat  = asin(clamp(qr.y, -1.0, 1.0));
  float lon  = atan(qr.z, qr.x);
  float dLat = degrees(lat);
  vec2  prof = latProfile(dLat);
  float shearT = SHEAR_TAU > 0.0 ? SHEAR_TAU * (1.0 - exp(-uTime / SHEAR_TAU)) : uTime;
  vec3  qs   = rotY(prof.x * shearT * 0.085) * qr;     // sheared by the wind profile

  // ---- octave budget from actual pixel footprint (brief §2.4) ----
  // Derivatives are taken before any divergent branch so they are defined for
  // the whole 2x2 quad (everything above is cheap). The footprint is the area
  // of the pixel's image in noise space (the y-squash makes it strongly
  // anisotropic; sqrt(area) is the isotropic-equivalent size).
  float oct = min(uOct, float(MAX_OCT));
#ifdef GL_OES_standard_derivatives
  {
    vec3 qb = vec3(qs.x, qs.y * TURB_SQUASH, qs.z) * TURB_SCALE;
    vec3 dx = dFdx(qb), dy = dFdy(qb);
    float fp = sqrt(max(length(cross(dx, dy)), 1e-12));
    oct = clamp(min(oct, octaveBudget(fp)), 1.0, float(MAX_OCT));
  }
#endif

  // ---- domain warp (animated, low frequency: 5 octaves) ----
  // The displaced point is re-projected onto the sphere so the turbulence is a
  // field over the sphere in both modes; the pattern slowly boils with uTime.
  float w  = fbm(qs * 2.6 + vec3(0.0, uTime * 0.008, 0.0), min(oct, 5.0));
  vec3  qw = normalize(qs + (w - 0.5) * 0.30 * vec3(1.0, 0.22, 1.0));

#ifdef BAKED
  // Sampled before the coverage branch: the fetch's derivatives need the
  // whole quad to be live.
  vec2 fields = atlasFetch(qw).rg;
  if (coverage <= 0.0){ gl_FragColor = vec4(0.0); return; }
  float turb = fields.x, cyc = fields.y;
#else
  if (coverage <= 0.0){ gl_FragColor = vec4(0.0); return; }
  float turb = turbAt(qw, oct);
  float cyc  = abs(dLat) > 55.0 ? cycAt(qw, oct) : 0.0;
#endif

  vec3 c = albedo(turb, cyc, prof, dLat, lat, lon, oct);

  // ---- lighting (linear) ----
  vec3  L    = normalize(vec3(-0.55, 0.36, 0.75));
  float ndl  = dot(n, L);
  float wrap = clamp((ndl + 0.18) / 1.18, 0.0, 1.0);
  float day  = smoothstep(-0.10, 0.30, ndl);
  float mu   = max(dot(n, -rd), 0.0);
  float limb = pow(mu, 0.45);

  vec3 key      = vec3(1.0, 0.95, 0.88) * 1.02;
  vec3 twilight = mix(TWILIGHT * 1.5, vec3(1.0), smoothstep(-0.05, 0.14, ndl));
  vec3 lit = c * key * wrap * twilight * mix(0.55, 1.0, limb);
  lit += c * AMBIENT * 6.0 * (1.0 - day) + AMBIENT * 3.0;    // coloured shadow
  lit += RAYLEIGH * pow(1.0 - mu, 4.0) * day * 0.42;          // limb scatter

#ifdef HDR
  vec3 outc = lit;                                          // linear radiance; composite tonemaps
#else
  vec3 outc = pow(aces(lit), vec3(1.0 / 2.2));              // display-encoded
#endif

  // Premultiplied by coverage; ±0.5/255 hash dither before the write so an
  // 8-bit target never bakes in banding (brief §2.2).
  vec3 rgb = outc * coverage;
  rgb += (hash21(gl_FragCoord.xy + fract(uTime * 0.37) * vec2(31.0, 17.0)) - 0.5) / 255.0;
  gl_FragColor = vec4(max(rgb, 0.0), coverage);
}
`;
}

// ---------------------------------------------------------------------------
// Composite pass
// ---------------------------------------------------------------------------
// Bloom mask thresholds: the planet pass used to mask on linear radiance
// max(lit) ∈ [1.10, 1.90]. The LDR texture holds display-encoded values, so
// the same thresholds are mapped through ACES + gamma here.
const acesJS = (x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const enc = (x) => Math.pow(acesJS(x), 1 / 2.2).toFixed(5);
const BLOOM_LO_LIN = 1.10, BLOOM_HI_LIN = 1.90;

// NOTE: the composite must know whether the planet texture is display-encoded
// (LDR) or linear radiance (HDR). The §1 contract lists only { hq } here, so
// `halfFloat` is accepted as an optional extra key (default false = LDR). The
// renderer must pass the same halfFloat it passed to FRAG_PLANET.
export function FRAG_COMPOSITE({ hq = false, halfFloat = false } = {}) {
  return `${PRECISION}
${hq ? '#define HQ 1' : ''}
${halfFloat ? '#define HDR 1' : ''}
uniform sampler2D uTex;
uniform vec2  uRes;
uniform float uTime, uBloom, uGrain;
// The planet target is allocated once at the tier's ceiling and only a
// sub-rectangle is rendered, so canvas uv must be scaled into it. uTexClamp is
// that sub-rectangle inset by half a texel, so bilinear taps never reach
// outside the rendered region.
uniform vec2  uTexScale, uTexClamp;

const vec3 GROUND = ${GROUND_SRGB};   // #0F0906, sRGB

${ACES}
${HASH21}

// Display-encode a texel. The planet texture is premultiplied by coverage:
// LDR texels are already encoded (identity); HDR texels are linear radiance
// and must be un-premultiplied before the (non-linear) tonemap.
vec3 encodeLDR(vec4 t){ return t.rgb; }
vec3 encodeHDR(vec4 t){ return pow(aces(t.rgb / max(t.a, 1e-4)), vec3(1.0 / 2.2)) * t.a; }
#ifdef HDR
#define ENCODE encodeHDR
#else
#define ENCODE encodeLDR
#endif

// Bloom mask from brightness (alpha is coverage now, not a highlight mask).
float bright(vec4 t){
  vec3 u = t.rgb / max(t.a, 1e-4);                          // un-premultiply
  float m = max(max(u.r, u.g), u.b);
#ifdef HDR
  return smoothstep(${BLOOM_LO_LIN.toFixed(2)}, ${BLOOM_HI_LIN.toFixed(2)}, m);
#else
  return smoothstep(${enc(BLOOM_LO_LIN)}, ${enc(BLOOM_HI_LIN)}, m);
#endif
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 s = texture2D(uTex, min(uv * uTexScale, uTexClamp));
  vec3 c = ENCODE(s);                                       // premultiplied, encoded
  float lit = s.a;                                          // > 0 where anything but ground is written

  // tight bloom: 12-tap ring, masked by brightness (bright cloud tops only)
  if (uBloom > 0.0){
    vec2 px = 1.0 / uRes;
    float r = 5.5;
    vec3 b = vec3(0.0);
    for (int i = 0; i < 12; i++){
      float a = float(i) * 0.5236;
      vec2 d = vec2(cos(a), sin(a)) * r * px;
      vec4 t = texture2D(uTex, clamp((uv + d) * uTexScale, vec2(0.0), uTexClamp));
      b += ENCODE(t) * bright(t);
      t = texture2D(uTex, clamp((uv + d * 2.2) * uTexScale, vec2(0.0), uTexClamp));
      b += ENCODE(t) * bright(t) * 0.5;
    }
    c += b * (uBloom / 18.0);
    lit += b.r + b.g + b.b;
  }

  // blend over the ground: rgb is premultiplied by coverage
  c += GROUND * (1.0 - s.a);

  // fine monochrome film grain, gamma space, new frame ~6x per second
  if (uGrain > 0.0){
    float gsd = floor(uTime * 6.0);
    c += (hash21(gl_FragCoord.xy + gsd * vec2(17.0, 29.0)) - 0.5) * 2.0 * uGrain;
    lit = 1.0;
  }

  // dither — kills 8-bit banding on the smooth gradients. Pure ground pixels
  // are left exact so they match the ground the renderer clears outside the
  // disc's rectangle.
  c += (hash21(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0 * step(1e-6, lit);
  gl_FragColor = vec4(c, 1.0);
}
`;
}
