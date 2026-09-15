// Jupiter — scroll director + page bootstrap.
//
// Scroll position, in viewport heights, is damped every frame and the damped
// value drives everything:
//   push  y / 2.5vh, smoothstep → zoom 1 → 3.2 and the camera drifts onto the
//                                 Great Red Spot; a slow camera dolly, not a snap
//   tail  rest of the page, ≥ 3vh → zoom 3.2 → 4.5, a barely-there drift
//   look  y / 1.5vh, smoothstep → blur 0 → 14px, brightness 1 → .42,
//                                 saturation 1 → .8, veil 0 → .9,
//                                 light bleed 1 → .15, quality intent 1 → .25
// The look curve lands early so the copy is legible before the dolly ends.
// Blur is CSS (GPU-composited, free). The renderer is told the *intent*
// (setQuality) and decides how to spend it; a blurred canvas needs none.
//
// Still-frame pages (any non-home page, phones, reduced motion) render exactly
// one frame — planet.renderOnce() while not running is the renderer's `still`
// tier — and scrolling there only moves the (still damped) CSS.

import { mountJupiter, grsLongitude } from './planet.js';

const PUSH_VH = 2.5;              // viewports of scroll for the main push
const LOOK_VH = 1.5;              // viewports for blur / brightness / veil / bleed
const ZOOM_PUSH = 3.2, ZOOM_END = 4.5;
const TAIL_MIN_VH = 3;            // the drift takes at least this long, so a short page never hurries it
const BLUR_MAX = 14;
const DAMP = 0.10;                // fraction of the remaining distance per 60Hz frame
const SETTLE = 1e-3;              // viewport heights; below this we snap and stop

const clamp01 = (t) => Math.min(Math.max(t, 0), 1);
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };   // ease-in-out; peak rate 1.5× the mean
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));               // → (-π, π]

export function bootJupiter() {
  const stage = document.querySelector('.jupiter-stage');
  const canvas = stage && stage.querySelector('canvas.jupiter');
  const veil = stage && stage.querySelector('.veil');
  if (!stage || !canvas) return;
  const root = document.documentElement;

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const narrow = () => window.innerWidth < 760;
  const isProject = !document.body.classList.contains('page-home'); // every non-home page gets a still frame
  const fail = (why) => { stage.classList.add('is-fallback'); stage.dataset.failReason = String(why || 'unknown'); };

  const planet = mountJupiter(canvas, { onFail: fail });
  if (!planet) return;
  window.__jupiter = planet;   // diagnostics only
  const diag = window.__jupiterScroll = {   // diagnostics only
    target: 0, current: 0, p: 0, e: 0, look: 0, zoom: 1, blur: 0, quality: 1, bleed: 1, still: false,
  };

  // Framing per viewport shape. Height-units: width = aspect, height = 1;
  // offsetY is up. The disc is ≈ 0.84·zoom of the viewport height across.
  function framing() {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    if (isProject) return { offsetX: aspect * 0.40, offsetY: 0.40, zoom: 1.15 };
    if (aspect < 0.9) {
      // Portrait: centred, and small enough that the whole disc reads as an
      // object floating above the headline (zoom 0.4 → disc ≈ a third of the
      // viewport height, its centre ~15% down). The bright equatorial band
      // clears the eyebrow; the scrim carries the dim bottom limb behind it.
      return { offsetX: 0, offsetY: aspect < 0.6 ? 0.345 : 0.27, zoom: 0.40 };
    }
    return { offsetX: 0.60, offsetY: 0.02, zoom: 1.0 };
  }

  const baseLat = 0.06, grsLat = -22 * Math.PI / 180;
  const still = () => reduce || narrow() || isProject;

  // `tgt` is what the page says (viewport heights); `cur` chases it.
  let tgt = 0, cur = 0, lastT = 0, delta = 0, idle = 0, cssRaf = 0, needsStill = true;

  function readTarget() {
    const y = window.scrollY || 0;
    tgt = y / Math.max(1, window.innerHeight);
    document.body.classList.toggle('is-scrolled', y > 24);
  }
  // Exponential smoothing, frame-rate independent: DAMP of the remaining
  // distance per 60Hz frame whatever the real tick length. Returns whether
  // anything moved (one final true lands exactly on the target).
  function damp(now) {
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
    lastT = now;
    const d = tgt - cur;
    if (Math.abs(d) <= SETTLE) { cur = tgt; return d !== 0; }
    cur += d * (1 - Math.pow(1 - DAMP, dt * 60));
    return true;
  }
  function curves() {
    const vh = Math.max(1, window.innerHeight);
    const totalVh = Math.max(1, root.scrollHeight - vh) / vh;
    const p = clamp01(cur / PUSH_VH);
    const tail = clamp01((cur - PUSH_VH) / Math.max(TAIL_MIN_VH, totalVh - PUSH_VH));
    return { p, e: smooth(p), look: smooth(cur / LOOK_VH), tail };
  }

  // The CSS half — filter, veil, light bleed. Every page, every frame that moves.
  function applyLook(look) {
    const blur = lerp(0, BLUR_MAX, look), bleed = lerp(1, 0.15, look);
    canvas.style.filter = `blur(${blur.toFixed(2)}px) brightness(${lerp(1, 0.42, look).toFixed(3)}) saturate(${lerp(1, 0.80, look).toFixed(3)})`;
    if (veil) veil.style.opacity = Math.max(isProject ? 0.7 : 0, look * 0.9).toFixed(3);
    root.style.setProperty('--bleed-opacity', bleed.toFixed(3));
    diag.blur = blur; diag.bleed = bleed;
    return blur;
  }
  // The GL half — camera, quality intent, bloom. Only while the loop runs.
  function applyView(e, tail, blur) {
    const f = framing();
    const zoom = e < 1 ? lerp(f.zoom, ZOOM_PUSH, e) : lerp(ZOOM_PUSH, ZOOM_END, tail);
    // Bring the Great Red Spot under the (fixed) camera by offsetting the spin.
    // With camera lon 0 the sub-camera longitude is π/2 + spin, so the spin that
    // faces the spot is gLon − π/2. The shortest-arc delta is unwrapped over time
    // so it never flips mid-scroll, and re-centred whenever we are back at the top.
    const spin = planet.spin, sim = planet.sim;
    const raw = wrap((grsLongitude(sim) - Math.PI / 2) - spin);
    delta = e < 0.001 ? raw : delta + wrap(raw - delta);
    planet.setView({
      zoom,
      offsetX: lerp(f.offsetX, 0, e),
      offsetY: lerp(f.offsetY, 0, e),
      lat: lerp(baseLat, grsLat, e),
      lon: 0,
      spinOffset: e * delta,
    });
    const quality = 1 - 0.75 * blur / BLUR_MAX;   // sharp hero 1 → heavily blurred 0.25
    planet.setQuality(quality);
    planet.setBloom(lerp(1.0, 0.4, e));
    diag.zoom = zoom; diag.quality = quality;
  }
  function apply() {
    const { p, e, look, tail } = curves();
    const blur = applyLook(look);
    if (planet.running) applyView(e, tail, blur);
    diag.target = tgt; diag.current = cur; diag.p = p; diag.e = e; diag.look = look; diag.still = !planet.running;
  }
  // One full-quality frame at the resting framing; the renderer's `still` tier.
  function renderStill() {
    const f = framing();
    planet.setView({ zoom: f.zoom, offsetX: f.offsetX, offsetY: f.offsetY, lat: baseLat, lon: 0, spinOffset: 0 });
    planet.setQuality(1);
    planet.setBloom(1.0);
    planet.renderOnce();
    needsStill = false;
    diag.zoom = f.zoom; diag.quality = 1;
  }

  // Main loop — only while the planet's own loop runs. Parked mid-page the spot
  // keeps drifting, so re-aim at a third of the tick rate even when settled.
  function tick(now) {
    if (!planet.running) return;
    const moving = damp(now);
    if (moving || (cur > 0.02 && ++idle % 3 === 0)) apply();
    requestAnimationFrame(tick);
  }
  // Lightweight loop for when GL is not running: damps the CSS only and stops
  // as soon as it settles. Also the place a pending still frame gets drawn.
  function cssTick(now) {
    cssRaf = 0;
    if (planet.running) return;
    const moving = damp(now);
    if (needsStill && still()) renderStill();
    apply();
    if (moving) cssRaf = requestAnimationFrame(cssTick); else lastT = 0;
  }
  function kick() { if (!planet.running && !cssRaf) cssRaf = requestAnimationFrame(cssTick); }
  function run() {
    if (planet.running || still() || document.hidden) return;
    if (cssRaf) { cancelAnimationFrame(cssRaf); cssRaf = 0; }
    planet.start();
    lastT = 0;
    apply();
    requestAnimationFrame(tick);
  }

  function onScroll() { readTarget(); kick(); }
  function onResize() {
    readTarget();
    if (still()) { if (planet.running) planet.stop(); needsStill = true; kick(); }
    else { run(); apply(); }
  }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onResize, { passive: true });

  readTarget();
  cur = tgt;                       // no dolly on load: start where the page is
  if (still()) renderStill();
  apply();
  run();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) planet.stop(); else run();
  });
}
