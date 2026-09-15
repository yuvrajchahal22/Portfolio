// Jupiter — WebGL setup, render passes, quality tiers, lifecycle.
//
//   const planet = mountJupiter(canvas, { onFail(reason), onTier(name, probe) });
//   planet.setView({ zoom, offsetX, offsetY, lat, lon, spinOffset });
//   planet.setQuality(1.0);          // 0..1 intent: 1 at the sharp hero, ~0.25 when blurred
//   planet.setBloom(1); planet.setGrain(0.03);   // grain amplitude in display units, 0 = off
//   planet.start(); planet.stop(); planet.renderOnce();
//   planet.stats                     // { fps, frameMs, superSample, octaves, tier, mode, atlas, … }
//
// No dependencies. Raw WebGL1 for reach.
//
// Two render modes share one shader family:
//   baked       The static cloud turbulence field lives in an equirectangular
//               atlas baked once on the GPU (progressively, a few strips per
//               frame, while the first frames render procedurally). The screen
//               pass then samples it — a handful of noise octaves per pixel
//               remain for the animated warp and the Great Red Spot — and the
//               GL draw runs at 60fps on `high`/`medium` at the tier's full
//               supersample. This is the animated hero.
//   procedural  Every octave evaluated per pixel, draw capped at 30fps (24 on
//               low). Still frames (`still` tier: phones, project pages,
//               reduced motion), the frames before the atlas is ready, and
//               hardware without highp / derivatives.
// The offscreen target is supersampled above the canvas and downsampled with
// LINEAR. A boot-time probe + 20-frame warm-up picks the tier; after that the
// only thing that moves is a slow, hysteretic supersample factor.

import * as SH from './shader.js';

const BASE_FOV_DEG = 38;   // disc ≈ 0.84 × viewport height at zoom 1
const D = 3.6;             // camera distance in planet radii — must match shader.js
const SPIN_RATE = 0.114;   // rad/s → one rotation ≈ 55 s
const DPR_CAP = 2.0;
const GRS_LON0 = -75 * Math.PI / 180;

// Tier table (OPTIMIZATION_BRIEF §3.3, extended). `ss` = supersample vs the
// canvas backing store; `oct` = octave ceiling for the procedural pass;
// `bakeOct` = octave ceiling for the atlas bake; `hf` = half-float FBO if the
// probe allows it; `fps` = procedural draw-rate cap; `bfps` = baked draw-rate
// cap; `bake` = may use the atlas. `still` renders one expensive frame.
const TIERS = {
  high:   { ss: 1.5,  oct: 14, bakeOct: 10, hf: true,  fps: 30, bfps: 60, hq: true,  bake: true  },
  medium: { ss: 1.0,  oct: 10, bakeOct: 8,  hf: false, fps: 30, bfps: 60, hq: false, bake: true  },
  low:    { ss: 0.75, oct: 8,  bakeOct: 8,  hf: false, fps: 24, bfps: 24, hq: false, bake: true  },
  still:  { ss: 1.5,  oct: 12, bakeOct: 0,  hf: true,  fps: 30, bfps: 30, hq: true,  bake: false },
};
const SS_FLOOR = 0.3;            // lowest supersample setQuality may ask for
const OCT_FLOOR = 6;
// Deterministic ceiling on supersampled pixels per frame. A feedback loop
// cannot find this: once the draw rate is capped at the target, the measured
// interval equals the target no matter how much headroom exists, so the loop
// can only ever overshoot and oscillate. The budget is measured — 8.5 Mpx is
// the most this shader sustains at 60fps on an M2-class GPU — and it yields
// 1.5x supersample at 1x DPR and ~1.28x at 2x, both of which hold a true 60.
const PIXEL_BUDGET = { high: 8.5e6, medium: 5.0e6, low: 2.6e6, still: Infinity };
const ADAPT_MIN = 0.45;          // adaptive factor never goes below this
const ADAPT_HOLD_MS = 5000;      // at most one adaptive change per 5 s
const ADAPT_DOWN = 0.15, ADAPT_UP = 0.05;
const WARMUP_DRAWS = 45;   // long enough that the EMA reflects the steady state, not a lucky opening
const LUT_FALLBACK = 512;

// Atlas sizing: rows = next power of two ≥ 1.5 × the hero FBO height (so the
// atlas resolves finer than the pixels it feeds in latitude, where the cloud
// filaments are thin), columns = 2 × rows (features are ~6× longer in
// longitude, so this over-resolves that axis relative to the content). Both
// clamped to [1024, 4096] and MAX_TEXTURE_SIZE. RGBA8 + mips:
//   4096×4096 → 85 MB (high at 2× DPR)   4096×2048 → 43 MB (high/medium at 1×)
//   2048×1024 → 11 MB (low)
const ATLAS_MIN = 1024, ATLAS_MAX = 4096;
const BAKED_MAX_ZOOM = Infinity; // baked mode at every zoom (blur + quality intent hide the atlas' ceiling)
// Atlas mip selection: scale the screen-space gradients by this (LOD bias
// log2 of it). Trilinear filtering is a low-pass the procedural path never
// had; the supersampled target absorbs the aliasing a sharper pick lets
// through, so this brings the baked frame back onto the procedural one.
const ATLAS_GRAD = 0.71;         // LOD −0.5: measured to bring baked sharpness to 92–95% of procedural, no shimmer at 1.5× ss
const LATE_TRIP = 24;            // leaky late-draw score that trips a step down (see slowDraws)

export function grsLongitude(simTime) { return GRS_LON0 - simTime * 0.010; }

export function mountJupiter(canvas, opts = {}) {
  const fail = (why) => { opts.onFail && opts.onFail(why); return null; };

  // ---- context ------------------------------------------------------------
  // First ask for a context that refuses software rendering; if that is all
  // the machine has, accept it and remember (it pins the tier to `low`).
  const attrs = { antialias: false, alpha: false, depth: false, stencil: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: false };
  let gl = null, caveat = false;
  try { gl = canvas.getContext('webgl', { ...attrs, failIfMajorPerformanceCaveat: true }); } catch (e) { /* fall through */ }
  if (!gl) {
    try { gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch (e) { /* fall through */ }
    caveat = !!gl;
  }
  if (!gl) return fail('no-webgl');

  // ---- probe (never the UA string) ----------------------------------------
  let extDeriv, extHF, extHFL, extLose, extLod, extAniso;
  function getExtensions() {
    extDeriv = gl.getExtension('OES_standard_derivatives');
    extHF = gl.getExtension('OES_texture_half_float');
    extHFL = extHF && gl.getExtension('OES_texture_half_float_linear');
    extLose = gl.getExtension('WEBGL_lose_context');
    extLod = gl.getExtension('EXT_shader_texture_lod');
    extAniso = gl.getExtension('EXT_texture_filter_anisotropic')
      || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
      || gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
  }
  getExtensions();
  const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const probe = {
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    derivatives: !!extDeriv,
    textureLod: !!extLod,
    anisotropy: extAniso ? gl.getParameter(extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 0,
    highp: !!(hp && hp.precision > 0),
    halfFloat: false,
    cores: navigator.hardwareConcurrency || 0,     // 0 = unknown
    memory: navigator.deviceMemory || 0,           // 0 = unknown (Safari/Firefox)
    caveat,
    dpr: window.devicePixelRatio || 1,
    renderer: null,
  };
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    probe.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { /* diagnostics only */ }
  if (extHF && extHFL) probe.halfFloat = testHalfFloatTarget();
  // The atlas needs highp texture coordinates (4096 texels) and a way to pick
  // mip levels across the equirect seam (derivatives, or an explicit LOD).
  probe.bake = probe.highp && (probe.derivatives || probe.textureLod);

  function testHalfFloatTarget() {
    // A half-float texture is only useful if we can both render into it
    // (framebuffer complete) and sample it with LINEAR (the _linear ext).
    const t = gl.createTexture(), f = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, extHF.HALF_FLOAT_OES, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.getError() === gl.NO_ERROR;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(f); gl.deleteTexture(t);
    return ok;
  }

  const dbg = (k) => (typeof window !== 'undefined' ? window[k] : undefined);   // diagnostics-only overrides
  function forcedTier() {
    let f = opts.forceTier || dbg('__jupiterForceTier');
    try { f = f || new URLSearchParams(location.search).get('tier'); } catch (e) { /* no location */ }
    return f && TIERS[f] ? f : null;
  }
  function chooseTier() {
    const f = forcedTier();
    if (f) return f;
    if (!probe.highp || probe.caveat || probe.maxTex < 2048) return 'low';
    const cores = probe.cores || 4, mem = probe.memory || 8;   // unknown → don't penalise
    if (cores >= 4 && mem >= 4 && probe.maxTex >= 4096 && probe.derivatives) return 'high';
    if (cores >= 2 && mem >= 2) return 'medium';
    return 'low';
  }
  const forced = forcedTier();
  // The simplex permutation overflows fp16, so a fragment shader without highp
  // renders structureless mush rather than clouds — the gradient fallback is honest.
  if (!probe.highp) { opts.onFail && opts.onFail('no-highp'); return null; }
  let tier = chooseTier();          // candidate until the warm-up commits it
  let committed = !!forced;
  let stillMode = false;            // renderOnce() without start() → `still`
  let emitted = null;
  function emitTier() {
    const name = stillMode ? 'still' : tier;
    if (name === emitted) return;
    emitted = name;
    opts.onTier && opts.onTier(name, probe);
  }

  // ---- GL resources (rebuildable after context loss) ----------------------
  let progs = {}, quad = null, tex = null, fbo = null, lut = null;
  let texHF = false, fw = 0, fh = 0, texW = 0, texH = 0, wasRunning = false;
  let atlas = null, atlasFbo = null, aw = 0, ah = 0, atlasReady = false;
  // Bake bookkeeping: `ms` / `mipMs` are GPU-inclusive (the bake ends with a
  // one-pixel read-back, so the numbers are honest, not submit times).
  const bake = { oct: 0, ms: 0, mipMs: 0 };
  const PLANET_U = ['uRes', 'uView', 'uOffset', 'uTime', 'uFov', 'uSpin', 'uOct', 'uLut', 'uPixel', 'uAtlas', 'uAtlasLod', 'uAtlasGrad'];
  const COMP_U = ['uTex', 'uRes', 'uTime', 'uBloom', 'uGrain', 'uTexScale', 'uTexClamp'];
  const BAKE_U = ['uRes', 'uOct'];

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(fs) {
    const p = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, SH.VERT), fsh = compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, vs); gl.attachShader(p, fsh);
    gl.linkProgram(p);
    const ok = gl.getProgramParameter(p, gl.LINK_STATUS) || gl.isContextLost();
    gl.deleteShader(vs); gl.deleteShader(fsh);        // the program keeps its own reference
    if (!ok) { const log = gl.getProgramInfoLog(p); gl.deleteProgram(p); throw new Error(log); }
    const a = gl.getAttribLocation(p, 'a');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    return p;
  }
  const U = (p, names) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
  // Shader sources are functions of the tier (contract §1); accept the older
  // plain-string form too so this file runs against either shader.js.
  const planetSrc = (hq, halfFloat, baked) => typeof SH.FRAG_PLANET === 'function' ? SH.FRAG_PLANET({ hq, halfFloat, baked }) : SH.FRAG_PLANET;
  // The composite must know the texture's encoding (HDR vs LDR), so it gets
  // the same halfFloat flag as the planet pass.
  const compSrc = (hq, halfFloat) => typeof SH.FRAG_COMPOSITE === 'function' ? SH.FRAG_COMPOSITE({ hq, halfFloat }) : SH.FRAG_COMPOSITE;
  const canBake = probe.bake && typeof SH.FRAG_BAKE === 'function';

  function buildPrograms(hq, hf, baked) {
    const key = hq + '|' + hf + '|' + baked;
    if (progs[key]) return progs[key];
    const p = program(planetSrc(hq, hf, baked)), c = program(compSrc(hq, hf));
    return (progs[key] = { p, c, uP: U(p, PLANET_U), uC: U(c, COMP_U) });
  }
  function getPrograms(hq, hf, baked) {
    // A shader that fails at `hq` is retried at the plain variant before we
    // give up on WebGL entirely. The fallback is cached under the REQUESTED
    // key: without that, render() recompiles and re-links every single frame
    // on any driver that rejects the hq variant, leaking both.
    const key = hq + '|' + hf + '|' + baked;
    if (progs[key]) return progs[key];
    try { return buildPrograms(hq, hf, baked); }
    catch (e) { if (!hq) throw e; return (progs[key] = buildPrograms(false, hf, baked)); }
  }
  function getBakeProgram() {
    if (!progs.bake) { const b = program(SH.FRAG_BAKE()); progs.bake = { b, uB: U(b, BAKE_U) }; }
    return progs.bake;
  }

  function createStatic() {
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    // Latitude LUT (LUT_SIZE×1 RGBA8) on unit 1 — white if the shader predates it.
    const size = typeof SH.LUT_SIZE === 'number' ? SH.LUT_SIZE : LUT_FALLBACK;
    let data = null;
    if (typeof SH.buildLatitudeLUT === 'function') data = SH.buildLatitudeLUT();
    if (!(data instanceof Uint8Array) || data.length !== size * 4) data = new Uint8Array(size * 4).fill(255);
    lut = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);

    // Offscreen target; storage is allocated lazily in sizeTargets().
    tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fw = fh = texW = texH = 0; texHF = false;
  }
  function releaseAtlas() {
    if (atlas) gl.deleteTexture(atlas);
    if (atlasFbo) gl.deleteFramebuffer(atlasFbo);
    atlas = atlasFbo = null; aw = ah = 0; atlasReady = false;
  }
  function release() {
    for (const k in progs) { const p = progs[k]; for (const q of [p.p, p.c, p.b]) if (q) gl.deleteProgram(q); }
    progs = {};
    if (quad) gl.deleteBuffer(quad);
    if (tex) gl.deleteTexture(tex);
    if (lut) gl.deleteTexture(lut);
    if (fbo) gl.deleteFramebuffer(fbo);
    releaseAtlas();
    quad = tex = lut = fbo = null; fw = fh = 0;
  }

  try {
    createStatic();
    getPrograms(TIERS[tier].hq, TIERS[tier].hf && probe.halfFloat, false);
  } catch (e) { release(); return fail(e && e.message || 'shader'); }

  // ---- state --------------------------------------------------------------
  const state = {
    zoom: 1, offsetX: 0.55, offsetY: 0.0, lat: 0.06, lon: 0.0, spinOffset: 0,
    quality: 1, bloom: 1.0, grain: 0.0, spin: 0, sim: 0,   // grain is a display-space amplitude (0.03 ≈ film); the page adds its own CSS grain
  };
  let W = 0, H = 0, cssW = 0, cssH = 0, sizeDirty = true;
  let raf = 0, last = 0, running = false, lost = false;
  let adapt = 1;                       // adaptive fraction of the quality target
  let curSS = 0, curOct = 0, lastRect = [0, 0, 0, 0], mode = 'procedural', lastMode = null;
  // Timing. GPU work is asynchronous, so CPU submit time says nothing about
  // cost; the honest signal is how far apart the draws actually land versus
  // the interval we asked for.
  let refresh = 16.7, tickEMA = 16.7, drawEMA = 33.3, drawDue = 0, lastDraw = 0;
  let fps = 0, drawCount = 0, fpsWindow = 0;
  let warmDraws = 0, lastChange = 0, failedLevel = 2, failedUntil = 0, backoff = 30000, slowDraws = 0, calibRounds = 0;

  // A resize is a new regime: re-derive the supersample from the tier ceiling
  // rather than keeping a level calibrated for a different canvas.
  const markDirty = () => {
    sizeDirty = true;
    if (!forced) { adapt = 1; committed = false; warmDraws = 0; calibRounds = 0; slowDraws = 0; }
  };
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(markDirty); ro.observe(canvas); }
  addEventListener('resize', markDirty, { passive: true });

  function measure() {
    if (sizeDirty) { const r = canvas.getBoundingClientRect(); cssW = r.width; cssH = r.height; sizeDirty = false; }
    const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    W = Math.max(2, Math.round(cssW * dpr));
    H = Math.max(2, Math.round(cssH * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  }
  function sizeTargets(ss) {
    measure();
    const spec = TIERS[stillMode ? 'still' : tier];
    const budget = PIXEL_BUDGET[stillMode ? 'still' : tier] || Infinity;
    const cap = Math.min(spec.ss, probe.maxTex / Math.max(W, H), Math.sqrt(budget / Math.max(1, W * H)));
    const s = Math.min(ss, cap);
    fw = Math.max(2, Math.round(W * s)); fh = Math.max(2, Math.round(H * s));
    const wantHF = spec.hf && probe.halfFloat;
    // Allocate ONCE at the tier's ceiling and render into a sub-rectangle.
    // The render size changes continuously while scrolling (quality follows
    // blur), and reallocating this texture — up to 80 MB — 17 times per scroll
    // was the largest single source of scroll jank on a cold GPU allocator.
    const ntw = Math.max(2, Math.round(W * cap)), nth = Math.max(2, Math.round(H * cap));
    if (ntw !== texW || nth !== texH || wantHF !== texHF) {
      texW = ntw; texH = nth; texHF = wantHF;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texW, texH, 0, gl.RGBA, texHF ? extHF.HALF_FLOAT_OES : gl.UNSIGNED_BYTE, null);
    }
    curSS = s;
  }

  // setQuality intent → spend. q=1 is the tier's full supersample and octave
  // ceiling; q≈0.25 lands at ~0.35× and 6 octaves (the page is blurred then).
  function ssFor(spec, q) {
    const t = Math.min(Math.max((q - 0.2) / 0.8, 0), 1);
    return SS_FLOOR + (spec.ss - SS_FLOOR) * t;
  }
  function octFor(spec, q, zoom) {
    const t = Math.min(Math.max((q - 0.25) / 0.75, 0), 1);
    const ceil = OCT_FLOOR + (spec.oct - OCT_FLOOR) * t;
    if (spec === TIERS.still) return ceil;
    // More octaves as the camera closes in — detail per pixel grows with zoom.
    return Math.min(ceil, Math.max(OCT_FLOOR, ceil - 2 + Math.log(Math.max(zoom, 1e-3)) / Math.LN2 * 0.9));
  }

  // ---- cloud atlas ----------------------------------------------------------
  const pot = (v) => Math.pow(2, Math.ceil(Math.log2(Math.max(1, v))));
  function atlasSizeFor(spec) {
    measure();
    const heroH = H * spec.ss;                       // FBO height at the sharp hero
    const cap = Math.min(ATLAS_MAX, probe.maxTex);
    // Derive width from the cap and halve it: clamping the HEIGHT first let
    // w = min(cap, h*2) collapse to a square once h hit the cap, doubling the
    // memory for no latitude detail anyone can see.
    let w = Math.min(cap, Math.max(ATLAS_MIN * 2, pot(heroH * 3)));
    let h = Math.max(ATLAS_MIN, w / 2);
    const o = dbg('__jupiterAtlas');                 // diagnostics: force [w, h]
    if (Array.isArray(o) && o.length === 2) { w = o[0]; h = o[1]; }
    return [w, h];
  }
  function createAtlas(spec) {
    const [w, h] = atlasSizeFor(spec);
    if (atlas && w === aw && h === ah) return;
    releaseAtlas();
    aw = w; ah = h;
    atlas = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);           // longitude wraps
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (extAniso && probe.anisotropy > 1) gl.texParameterf(gl.TEXTURE_2D, extAniso.TEXTURE_MAX_ANISOTROPY_EXT, probe.anisotropy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, aw, ah, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    atlasFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, atlasFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, atlas, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { releaseAtlas(); probe.bake = false; return; }
    bake.oct = spec.bakeOct;
    atlasReady = false;
  }
  // Bake rows [y0, y0+rows) at `oct` octaves, scissored.
  function bakeStrip(y0, rows, oct) {
    const B = getBakeProgram();
    gl.bindFramebuffer(gl.FRAMEBUFFER, atlasFbo);
    gl.viewport(0, 0, aw, ah);
    gl.useProgram(B.b);
    gl.uniform2f(B.uB.uRes, aw, ah);
    gl.uniform1f(B.uB.uOct, oct);
    gl.scissor(0, y0, aw, rows);
    gl.enable(gl.SCISSOR_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // Block until everything queued so far has executed (one-pixel read-back
  // of the atlas). Makes the bake timings GPU-inclusive.
  function syncGPU() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, atlasFbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function generateMips() {
    const t0 = performance.now();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.generateMipmap(gl.TEXTURE_2D);
    syncGPU();
    bake.mipMs = performance.now() - t0;
    return bake.mipMs;
  }
  // The whole atlas in one synchronous go: the field is static, so this
  // happens once per context (~65 ms + ~45 ms of mips for 4096² on an M2;
  // it is issued before the first frame, which would wait on it anyway).
  // Progressive bake: one time-budgeted slice per frame. `atlasReady` stays
  // false throughout, so pickMode() keeps returning 'procedural' and the
  // planet renders at full quality the whole time — this trades no quality,
  // it only stops a ~170 ms synchronous job from blocking the first frames.
  const BAKE_BUDGET_MS = 6;
  let bakeRow = 0, bakeRate = 0, bakeT0 = 0, bakePrepped = false;
  function bakeStep() {
    if (!atlas || atlasReady) return true;
    if (!bakePrepped) {
      bakePrepped = true;
      bakeT0 = performance.now(); bakeRate = 8;   // start tiny; the measured rate ramps it
      const spec = TIERS[tier];
      getBakeProgram();                                            // deferred off the boot path
      getPrograms(spec.hq, spec.hf && probe.halfFloat, true);
      return false;                                                // that compile was this slice's budget
    }
    const t0 = performance.now();
    const rows = Math.max(8, Math.min(ah - bakeRow, Math.round(bakeRate)));
    bakeStrip(bakeRow, rows, bake.oct);
    bakeRow += rows;
    const dt = performance.now() - t0;
    // Ramp at most 2x per slice, so one fast measurement cannot schedule a huge one.
    bakeRate = dt > 0.05 ? Math.max(8, Math.min(ah, bakeRate * Math.min(2, BAKE_BUDGET_MS / dt))) : bakeRate * 2;
    if (bakeRow >= ah) { generateMips(); atlasReady = true; bake.ms = performance.now() - bakeT0; bakeRow = 0; bakePrepped = false; return true; }
    return false;
  }

  function bakeSync(oct) {
    const t0 = performance.now();
    bakeStrip(0, ah, oct == null ? bake.oct : oct);
    syncGPU();
    bake.ms = performance.now() - t0;
    generateMips();
    atlasReady = true;
    return bake.ms;
  }

  // Disc bounding box in FBO pixels. The shader's uv = (frag − 0.5·res)/res.y
  // − uOffset puts the disc centre at uv = 0, and a ray at |uv| leaves the
  // axis at tan θ = 2|uv|·tan(fov/2); the unit sphere bounds the oblate
  // spheroid, so its angular radius asin(1/D) is a safe silhouette. The
  // planet pass needs only the 1-px limb feather beyond it (the bloom reads
  // *from* the disc; it never needs pixels outside it), so the pad is a few
  // pixels, not a percentage.
  function discRect(fov, pad) {
    const cx = 0.5 * fw + state.offsetX * fh, cy = 0.5 * fh + state.offsetY * fh;
    const r = Math.tan(Math.asin(1 / D)) / Math.tan(fov * 0.5) * 0.5 * fh;
    const pr = r + pad;
    const x0 = Math.max(0, Math.floor(cx - pr)), y0 = Math.max(0, Math.floor(cy - pr));
    const x1 = Math.min(fw, Math.ceil(cx + pr)), y1 = Math.min(fh, Math.ceil(cy + pr));
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  }
  const PLANET_PAD = 6;            // FBO px beyond the silhouette: limb feather + downsample footprint
  const BLOOM_REACH = 5.5 * 2.2;   // canvas px: outermost bloom tap (shader.js ring radius × 2.2)

  function pickMode(spec) {
    const o = dbg('__jupiterMode');                      // diagnostics: 'baked' | 'procedural'
    if (o === 'procedural') return o;
    if (o === 'baked' && atlasReady) return o;              // diagnostics may bench the baked path on a still frame
    if (!spec.bake || !atlasReady || stillMode) return 'procedural';
    if (o !== 'baked' && state.zoom > BAKED_MAX_ZOOM) return 'procedural';
    return 'baked';
  }

  function render(full) {
    if (lost) return;
    const spec = TIERS[stillMode ? 'still' : tier];
    const q = full ? 1 : state.quality, a = full ? 1 : adapt;
    mode = pickMode(spec);
    const baked = mode === 'baked';
    const P = getPrograms(spec.hq, spec.hf && probe.halfFloat, baked);
    sizeTargets(+dbg('__jupiterSS') || ssFor(spec, q) * a);   // diagnostics may pin the supersample
    const fov = (BASE_FOV_DEG / state.zoom) * Math.PI / 180;
    curOct = octFor(spec, q, state.zoom);
    const noScissor = !!dbg('__jupiterNoScissor');
    const rect = noScissor ? [0, 0, fw, fh] : discRect(fov, PLANET_PAD);
    lastRect = rect;

    // Planet pass into the supersampled target. Misses are transparent black
    // (premultiplied), so clearing the whole target and shading only the disc's
    // bounding box is exactly equivalent to shading every pixel.
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, fw, fh);
    gl.clearColor(0, 0, 0, 0);
    gl.scissor(0, 0, fw, fh);          // clear only the live sub-rectangle
    gl.enable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lut);
    gl.uniform1i(P.uP.uLut, 1);
    if (baked) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.uniform1i(P.uP.uAtlas, 2);
      // Explicit LOD for hardware without derivatives: FBO pixel vs atlas texel at the disc centre.
      const pxRad = 2 * Math.tan(fov * 0.5) * (D - 1) / fh;
      gl.uniform1f(P.uP.uAtlasLod, Math.max(0, Math.log2(pxRad / (Math.PI / ah)) + 0.5));
      gl.uniform1f(P.uP.uAtlasGrad, +dbg('__jupiterAtlasGrad') || ATLAS_GRAD);
    }
    gl.uniform2f(P.uP.uRes, fw, fh);
    gl.uniform2f(P.uP.uPixel, 1 / fw, 1 / fh);
    gl.uniform2f(P.uP.uView, state.lat, state.lon);
    gl.uniform2f(P.uP.uOffset, state.offsetX, state.offsetY);
    gl.uniform1f(P.uP.uTime, state.sim);
    gl.uniform1f(P.uP.uFov, fov);
    gl.uniform1f(P.uP.uSpin, state.spin + state.spinOffset);
    gl.uniform1f(P.uP.uOct, curOct);
    if (rect[2] > 0 && rect[3] > 0) {
      gl.scissor(rect[0], rect[1], rect[2], rect[3]);
      gl.enable(gl.SCISSOR_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.SCISSOR_TEST);
    }

    // Composite: LINEAR downsample + bloom + grain onto the canvas. Only the
    // disc's rectangle (padded by the bloom's reach) can differ from the
    // ground, so the rest is a clear — unless GL grain covers the whole page.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const G = SH.GROUND_RGB || [0, 0, 0];
    gl.clearColor(G[0], G[1], G[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(P.c);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(P.uC.uTex, 0);
    gl.uniform2f(P.uC.uRes, W, H);
    gl.uniform1f(P.uC.uTime, state.sim);
    gl.uniform1f(P.uC.uBloom, state.bloom);
    gl.uniform1f(P.uC.uGrain, state.grain);
    gl.uniform2f(P.uC.uTexScale, fw / texW, fh / texH);
    gl.uniform2f(P.uC.uTexClamp, (fw - 0.5) / texW, (fh - 0.5) / texH);
    if (!noScissor && state.grain <= 0) {
      const sx = W / fw, pad = Math.ceil(BLOOM_REACH + 2);
      const x0 = Math.max(0, Math.floor(rect[0] * sx) - pad), y0 = Math.max(0, Math.floor(rect[1] * sx) - pad);
      const x1 = Math.min(W, Math.ceil((rect[0] + rect[2]) * sx) + pad), y1 = Math.min(H, Math.ceil((rect[1] + rect[3]) * sx) + pad);
      if (x1 <= x0 || y1 <= y0) return;
      gl.scissor(x0, y0, x1 - x0, y1 - y0);
      gl.enable(gl.SCISSOR_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.SCISSOR_TEST);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    if (dbg('__jupiterDebugScissor')) drawDebugRect(rect);
  }

  // Debug: outline the scissor rect on the canvas (magenta) with scissored clears.
  function drawDebugRect(r) {
    const sx = W / fw, sy = H / fh, t = 2;
    const x = Math.round(r[0] * sx), y = Math.round(r[1] * sy), w = Math.round(r[2] * sx), h = Math.round(r[3] * sy);
    gl.clearColor(1, 0, 1, 1);
    gl.enable(gl.SCISSOR_TEST);
    for (const s of [[x, y, w, t], [x, y + h - t, w, t], [x, y, t, h], [x + w - t, y, t, h]]) {
      gl.scissor(s[0], s[1], Math.max(0, s[2]), Math.max(0, s[3]));
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  // Adaptive supersample: hysteretic and slow. Step down at once when draws
  // land well past the interval; step up in small increments, never within
  // 5 s of the last change, and never back onto a level that already failed
  // until its (doubling) backoff has passed.
  function adaptStep(now, interval) {
    if (!committed) {
      if (++warmDraws < WARMUP_DRAWS) return;
      const wload = drawEMA / interval;
      if (wload > 1.5 && tier !== 'low') {           // far off: demote and measure again
        tier = tier === 'high' ? 'medium' : 'low';
        warmDraws = 0; drawEMA = interval; return;
      }
      // Calibrate: the tier's ceiling is a maximum, not a promise. If draws land
      // more than 5% late, step the supersample down and re-measure before
      // committing, and remember the level that failed so the steady-state loop
      // does not climb straight back onto it. On this M2 at 2× DPR that lands
      // 1.5× → 1.35× and holds a true 60.
      if (wload > 1.05 && adapt > ADAPT_MIN && calibRounds < 4) {
        failedLevel = adapt; failedUntil = now + 180000; backoff = 60000;
        adapt = Math.max(ADAPT_MIN, +(adapt - 0.1).toFixed(3));
        calibRounds++; warmDraws = 0; drawEMA = interval; return;
      }
      committed = true; lastChange = now;
      emitTier();
      return;
    }
    if (now - lastChange < ADAPT_HOLD_MS) return;
    const load = drawEMA / interval;
    if (load > 1.04 && slowDraws >= LATE_TRIP && adapt > ADAPT_MIN) {
      failedLevel = adapt; failedUntil = now + backoff; backoff = Math.min(backoff * 2, 240000);
      adapt = Math.max(ADAPT_MIN, adapt - ADAPT_DOWN);
      slowDraws = 0; lastChange = now;
    }
    // There is deliberately no step *up*. Once the draw rate is capped at the
    // target, drawEMA == interval no matter how much headroom exists, so a
    // load-based climb cannot detect spare capacity — it can only overshoot,
    // fail, and step down again, which is exactly the visible pulsing this
    // loop exists to prevent (measured: 1.35 -> 1.425 -> 41fps -> back).
    // The level is instead re-derived from scratch whenever the regime
    // changes: a resize, a mode change or a tier change resets the warm-up.
  }

  const drawInterval = () => 1000 / (mode === 'baked' ? TIERS[tier].bfps : TIERS[tier].fps);

  function frame(now) {
    if (!running || lost) { raf = 0; return; }
    const ms = now - last; last = now;
    const dt = Math.min(0.05, ms / 1000);
    state.spin = (state.spin + dt * SPIN_RATE) % (Math.PI * 2);   // float32 uniforms quantize once this grows large
    state.sim += dt;
    if (ms > 0 && ms < 250) {          // ignore tab-switch gaps
      tickEMA = tickEMA * 0.9 + ms * 0.1;
      // The display's refresh interval is the fastest *plausible* tick — a
      // lone glitch far below the running average must not pin it.
      if (ms >= tickEMA * 0.5) refresh = Math.min(refresh, Math.max(4, ms));
    }
    // Draw on the mode's own interval. `drawDue` accumulates so the mean
    // spacing equals the interval on any refresh rate (24fps on a 60Hz
    // panel alternates 2 and 3 ticks); a half-tick of slack catches jitter.
    const interval = drawInterval();
    if (now >= drawDue - refresh * 0.5) {
      drawDue = (now - drawDue > interval) ? now + interval : drawDue + interval;
      const gap = now - lastDraw; lastDraw = now;
      if (gap < 500) drawEMA = drawEMA * 0.85 + gap * 0.15;
      // Sustained overload = many consecutive draws landing late; a lone
      // hitch (GC, a tab waking up) resets the count and never costs quality.
      // Leaky integrator, not a consecutive run: at 2x DPR the draw gap sits
    // right on the deadline and alternates over/under, which reset a
    // consecutive counter forever and pinned the page at ~52fps.
    slowDraws = Math.max(0, Math.min(LATE_TRIP * 2, slowDraws + (gap > interval * 1.04 ? 1 : -1)));
      // A mode change is a new timing regime (16.7 vs 33 ms intervals), so
      // the load estimate and the warm-up start over there: the tier is
      // judged in the mode it will actually run.
      render(false);
      if (mode !== lastMode) {
        lastMode = mode;
        drawEMA = drawInterval(); drawDue = now + drawEMA;
        // A new regime gets a fresh calibration budget: without resetting
        // calibRounds the baked mode inherits an exhausted one and parks at a
        // supersample that misses the frame deadline (measured: 54fps).
        if (!forced) { committed = false; warmDraws = 0; calibRounds = 0; }
      }
      drawCount++;
      if (now - fpsWindow >= 1000) { fps = drawCount * 1000 / (now - fpsWindow); drawCount = 0; fpsWindow = now; }
      adaptStep(now, drawInterval());
      // Advance the atlas after the draw, so the frame the user sees is never
      // delayed by it. Skipped while frames are already running late.
      if (!atlasReady && atlas && gap < interval * 1.3) { try { bakeStep(); } catch (e) { releaseAtlas(); probe.bake = false; } }
    }
    if (running) raf = requestAnimationFrame(frame);
  }
  function schedule() {
    if (raf || !running || lost) return;
    last = performance.now(); lastDraw = 0; drawDue = 0; fpsWindow = last; drawCount = 0;
    raf = requestAnimationFrame(frame);
  }
  // The atlas is only worth building for the animated page; still frames
  // stay procedural (one frame, every octave, no 43 MB texture). Any failure
  // (compile, framebuffer, GL error) drops back to procedural for good.
  function ensureAtlas(force) {
    if (!canBake || !probe.bake || (stillMode && !force)) return;
    const spec = TIERS[tier];
    if (!spec.bake) return;
    try {
      if (!atlas) { createAtlas(spec); if (!atlas) return; bakeRow = 0; bakePrepped = false; }   // bake/baked programs compile on the first slice
      if (!atlasReady && force) bakeSync();      // a still frame needs it now or not at all
    } catch (e) { releaseAtlas(); probe.bake = false; }
  }

  // ---- lifecycle ------------------------------------------------------------
  function onLost(e) {
    e.preventDefault();
    lost = true; wasRunning = wasRunning || running; running = false;   // latch: pagehide may have cleared `running` already
    if (raf) cancelAnimationFrame(raf);
    raf = 0; fps = 0; progs = {}; quad = tex = lut = fbo = null; fw = fh = 0;
    atlas = atlasFbo = null; aw = ah = 0; atlasReady = false;
    lastMode = null;
  }
  function onRestored() {
    lost = false;
    try {
      getExtensions();               // extension objects die with the old context
      if (probe.halfFloat && !(extHF && extHFL)) probe.halfFloat = false;
      createStatic();
      const spec = TIERS[stillMode ? 'still' : tier];
      getPrograms(spec.hq, spec.hf && probe.halfFloat, false);
    } catch (e) { running = false; lost = true; release(); fail(e && e.message || 'shader'); return; }
    sizeDirty = true;
    if (wasRunning) { running = true; wasRunning = false; ensureAtlas(); schedule(); }
    else if (stillMode) render(true);
  }
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);
  // Leaving the page: stop timers and hand the GPU back. If the page comes
  // back out of the bfcache, restore the context and rebuild.
  addEventListener('pagehide', () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    // Only hand the GPU back if we can ask for it again. loseContext() fires
    // 'webglcontextlost' asynchronously and a bfcache freeze suspends the page
    // before that task runs, so `lost` must be set here — otherwise pageshow
    // sees lost === false and the planet never returns after a Back press.
    if (!lost && extLose) { lost = true; wasRunning = wasRunning || running; running = false; release(); extLose.loseContext(); }
  });
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    if (extLose && gl.isContextLost()) extLose.restoreContext();
    else if (lost) onRestored();
  });

  const api = {
    get spin() { return state.spin; },
    get sim() { return state.sim; },
    setView(v) { Object.assign(state, v); },
    setQuality(q) { state.quality = Math.min(1, Math.max(0, +q || 0)); },
    setBloom(b) { state.bloom = Math.max(0, +b || 0); },
    setGrain(g) { state.grain = Math.max(0, +g || 0); },
    start() {
      if (running) return;
      running = true; stillMode = false;
      if (committed) emitTier();
      ensureAtlas();
      schedule();
    },
    stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
    // A complete frame at the tier's full quality. Off the animation loop that
    // is the `still` tier: 1.5× supersample, 12 octaves, half-float if available.
    renderOnce() {
      if (!running) { stillMode = true; emitTier(); }
      render(true);
    },
    get running() { return running; },
    get stats() {
      return {
        fps: +fps.toFixed(1), frameMs: +drawEMA.toFixed(2), tickMs: +tickEMA.toFixed(2), refreshMs: +refresh.toFixed(2),
        superSample: +curSS.toFixed(3), octaves: +curOct.toFixed(2),
        tier: stillMode ? 'still' : tier, committed, quality: state.quality, adapt: +adapt.toFixed(3),
        fbo: [fw, fh], texture: [texW, texH], canvas: [W, H], scissor: lastRect.slice(), halfFloat: texHF, probe,
        mode, atlas: [aw, ah], atlasBytes: atlas ? Math.round(aw * ah * 4 * 4 / 3) : 0,
        bakeProgress: atlasReady ? 1 : 0, bakeMs: +bake.ms.toFixed(1), mipMs: +bake.mipMs.toFixed(1), bakeOct: bake.oct,
        drawCapFps: mode === 'baked' ? TIERS[tier].bfps : TIERS[tier].fps,
      };
    },
    // Diagnostics only (not part of the scroll.js contract).
    _debug: {
      bakeSync, bake, get gl() { return gl; },
      // Rebuild the atlas at [w, h] and bake it synchronously at `oct` octaves; returns ms.
      rebake(w, h, oct) { window.__jupiterAtlas = [w, h]; releaseAtlas(); ensureAtlas(true); return atlas ? bakeSync(oct) : -1; },
      mipSync: generateMips,
    },
  };
  return api;
}
