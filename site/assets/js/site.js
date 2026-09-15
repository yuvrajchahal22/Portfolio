/* Shared behaviour: scroll reveals, page-out fade, Jupiter bootstrap.
   Content is readable without this file — reveals are gated on the `js`
   class set in <head>, and the hero never waits on it. */
(function () {
  'use strict';
  // Captured synchronously: it is null inside async callbacks. Used to resolve
  // the planet module relative to THIS file, whatever the page's own URL is.
  var selfSrc = document.currentScript && document.currentScript.src;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    var items = document.querySelectorAll('.reveal');
    function show(el) { el.classList.add('is-in'); }

    if (reduce || !('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(items, show);
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          io.unobserve(en.target);
          var d = parseFloat(en.target.getAttribute('data-delay')) || 0;
          d ? setTimeout(function () { show(en.target); }, d) : show(en.target);
        });
      }, { rootMargin: '0px 0px -8% 0px' });
      Array.prototype.forEach.call(items, function (el) { io.observe(el); });
      // Focus arriving before the observer fires reveals the element immediately.
      document.addEventListener('focusin', function (e) { var r = e.target.closest && e.target.closest('.reveal'); if (r) show(r); });
    }

    document.querySelectorAll('a[data-nav]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#' || href.indexOf('mailto') === 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || reduce) return;
        e.preventDefault();
        document.body.style.transition = 'opacity .28s ease';
        document.body.style.opacity = '0';
        setTimeout(function () { window.location.href = href; }, 280);
      });
    });
  });

  // Contact: "Copy" pill next to the email. Hidden by CSS until this file runs
  // (html:not(.js) .copy-email), so a no-JS visitor never sees a dead button.
  ready(function () {
    document.querySelectorAll('.copy-email').forEach(function (btn) {
      var label = btn.querySelector('.copy-email__label') || btn;
      // Sibling live region: the button's own label flips to "Copied" visually,
      // but its accessible name must stay "Copy email address", so the
      // confirmation is announced from here instead.
      var status = btn.parentNode && btn.parentNode.querySelector('[data-copy-status]');
      var idle = label.textContent, timer = 0;
      function done() {
        label.textContent = 'Copied';
        btn.classList.add('is-copied');
        if (status) status.textContent = 'Email address copied';
        clearTimeout(timer);
        timer = setTimeout(function () {
          label.textContent = idle;
          btn.classList.remove('is-copied');
          if (status) status.textContent = '';   // cleared so the next copy announces again
        }, 1500);
      }
      function fallback(text) {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr-only';
        document.body.appendChild(ta); ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
        document.body.removeChild(ta);
        return ok;
      }
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-copy') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { if (fallback(text)) done(); });
        } else if (fallback(text)) {
          done();
        }
      });
    });
  });

  window.addEventListener('pageshow', function (e) { if (e.persisted) document.body.style.opacity = ''; });

  /* ---- section rail -------------------------------------------------------
     Builds itself from any element carrying data-rail="Label", so a page with
     none simply has no rail. Scroll metrics are cached and only recomputed on
     resize: reading scrollHeight every frame forces a layout flush, and this
     runs alongside the planet's own loop. */
  ready(function () {
    var marks = [].slice.call(document.querySelectorAll('[data-rail]'));
    if (marks.length < 2) return;

    var rail = document.createElement('nav');
    rail.className = 'rail';
    rail.setAttribute('aria-label', 'Sections');
    rail.innerHTML = '<span class="rail__track"></span><span class="rail__fill"></span>';
    var fill = rail.querySelector('.rail__fill');

    var items = marks.map(function (el) {
      var id = el.id || ('rail-' + Math.random().toString(36).slice(2, 8));
      el.id = id;
      var a = document.createElement('a');
      a.className = 'rail__item';
      a.href = '#' + id;
      a.innerHTML = '<span class="rail__dot"></span><span class="rail__label"></span>';
      var name = el.getAttribute('data-rail');
      a.querySelector('.rail__label').textContent = name;
      // The visible label is display:none on narrower desktops, which would
      // strip it from the accessibility tree and leave the link unnamed.
      a.setAttribute('aria-label', name);
      rail.appendChild(a);
      return { el: el, a: a, top: 0, pos: 0 };
    });
    document.body.appendChild(rail);

    var docH = 1, viewH = 1, railH = 1, current = -1;

    function measure() {
      viewH = window.innerHeight || 1;
      docH = Math.max(1, document.documentElement.scrollHeight - viewH);
      railH = rail.clientHeight || 1;
      items.forEach(function (it) {
        it.top = it.el.getBoundingClientRect().top + (window.scrollY || 0);
        // Place each dot at the section's own position in the document, so the
        // rail is a map of the page rather than an evenly spaced menu.
        it.pos = Math.min(1, Math.max(0, (it.top - viewH * 0.35) / docH));
        it.a.style.top = (it.pos * railH) + 'px';
      });
    }

    function update() {
      var y = window.scrollY || 0;
      var p = Math.min(1, Math.max(0, y / docH));
      fill.style.height = (p * railH).toFixed(1) + 'px';
      // Active = the last section whose top has passed the reading line.
      var line = y + viewH * 0.35, idx = 0;
      for (var i = 0; i < items.length; i++) if (items[i].top <= line) idx = i;
      if (idx !== current) {
        items.forEach(function (it, i) {
          it.a.classList.toggle('is-current', i === idx);
          it.a.classList.toggle('is-past', i < idx);
          if (i === idx) it.a.setAttribute('aria-current', 'true');
          else it.a.removeAttribute('aria-current');
        });
        current = idx;
      }
    }

    var queued = false;
    function onScroll() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; update(); });
    }
    function onResize() { measure(); update(); }

    measure(); update();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onResize, { passive: true });
    // Fonts and the late-loading planet can both change the document height.
    addEventListener('load', onResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(onResize);
  });

  // The planet initialises after load, in idle time, so shader compilation can
  // never delay first paint or block the main thread while the page settles.
  window.addEventListener('load', function () {
    if (!document.querySelector('.jupiter-stage')) return;
    var boot = function () {
      var mod = selfSrc ? new URL('../jupiter/scroll.js', selfSrc).href : 'assets/jupiter/scroll.js';
      import(mod).then(function (m) { m.bootJupiter(); })
        .catch(function () { var s = document.querySelector('.jupiter-stage'); if (s) s.classList.add('is-fallback'); });
    };
    if ('requestIdleCallback' in window) requestIdleCallback(boot, { timeout: 1200 });
    else setTimeout(boot, 120);
  });
})();
