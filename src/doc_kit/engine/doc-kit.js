// doc-kit runtime. A deck page only needs:
//   <body data-deck="deck.md"><script type="module" src="../../engine/doc-kit.js"></script>
// Modes: default = present, ?speaker = speaker view, ?print / ?print=steps = PDF layout.

import { splitFrontMatter, expandUses, splitSlides } from './source.js';
import { createRenderer, indexSteps, applyStep } from './render.js';
import { mountComponents, rethemeComponents } from './components.js';
import { expandMath, parseMacros } from './math.js';

const ENGINE = new URL('./', import.meta.url);
const VENDOR = new URL('vendor/', ENGINE);
const params = new URLSearchParams(location.search);
const MODE = params.has('print') ? 'print' : params.has('speaker') ? 'speaker' : 'present';
const SLIDE_W = 1280, SLIDE_H = 720;

const report = {
  errors: [], tbds: [],
  error(msg) { this.errors.push(msg); console.error('[doc-kit]', msg); },
  tbd(msg) { this.tbds.push(msg); },
};
let readyResolve;
const api = (window.docKit = { report, isReady: false, ready: new Promise((r) => (readyResolve = r)) });
window.addEventListener('error', (e) => report.error(`script: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => report.error(`promise: ${e.reason?.message || e.reason}`));

const loadScript = (url) => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = url;
  s.onload = resolve;
  s.onerror = () => reject(new Error(`failed to load ${url}`));
  document.head.appendChild(s);
});
const loadCss = (url) => new Promise((resolve) => {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = url;
  l.onload = resolve;
  l.onerror = () => { report.error(`failed to load ${url}`); resolve(); };
  document.head.appendChild(l);
});
async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

/* ------------------------------------------------------------------ theme */

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
function initialTheme(meta) {
  return params.get('theme') || store.get('doc-kit:theme') || meta.theme || 'light';
}
async function setTheme(t, deck, persist = true) {
  document.documentElement.dataset.theme = t;
  if (persist) store.set('doc-kit:theme', t);
  if (deck) {
    await rethemeComponents(document, deck.ctx);
    for (const sl of deck.slides) indexSteps(sl.el);
    deck.onRetheme?.();
  }
}

/* ------------------------------------------------------------------ build */

async function loadDeck() {
  await Promise.all([
    loadCss(new URL('base.css', ENGINE)),
    loadCss(new URL('katex/katex.min.css', VENDOR)),
    loadScript(new URL('markdown-it.min.js', VENDOR)),
    loadScript(new URL('katex/katex.min.js', VENDOR)),
    loadScript(new URL('js-yaml.min.js', VENDOR)),
  ]);
  const deckUrl = new URL(document.body.dataset.deck || 'deck.md', location.href).href;
  const source = await fetchText(deckUrl);
  const { meta, body } = splitFrontMatter(source);
  // `pack:` is a name or a path (resolved by the server); the engine addresses it by its last segment.
  const packName = meta.pack ? String(meta.pack).replace(/\/+$/, '').split('/').pop() : null;

  const assetsRoot = meta.assets ? new URL(meta.assets.replace(/\/?$/, '/'), deckUrl) : new URL('../assets/', ENGINE);
  // A pack is assets/<name>/pack.yaml plus math/ (.tex) and graphics/ (.md, .mmd, .svg, theme).
  const packCache = new Map();
  const loadPack = (name) => {
    if (!packCache.has(name)) {
      const url = new URL(`${name}/`, assetsRoot);
      packCache.set(name, fetchText(new URL('pack.yaml', url)).then((t) => {
        const cfg = jsyaml.load(t) || {};
        return { name, url, cfg, prefix: cfg.latex?.prefix || name, math: new URL(`${cfg.math || 'math'}/`, url), graphics: new URL(`${cfg.graphics || 'graphics'}/`, url) };
      }));
    }
    return packCache.get(name);
  };
  let pack = {}, packUrl = null;
  if (packName) {
    try {
      const pk = await loadPack(packName);
      pack = pk.cfg; packUrl = pk.url;
    } catch (err) { report.error(`pack ${packName}: ${err.message}`); }
    for (const sheet of [].concat(pack.styles || [])) await loadCss(new URL(sheet, packUrl));
  }
  for (const sheet of [].concat(meta.styles || [])) await loadCss(new URL(sheet, deckUrl));
  document.documentElement.dataset.theme = initialTheme(meta);

  const resolve = async (name) => {
    // "name" resolves in the deck's pack, "otherpack:name" in another pack.
    // Unprefixed names try math/<name>.tex, then graphics/<name>.md;
    // a leading "math/" or "graphics/" picks one explicitly.
    const [p, n] = name.includes(':') ? name.split(':', 2) : [packName, name];
    if (!p) throw new Error('no pack selected (set `pack:` in the front matter)');
    const pk = await loadPack(p);
    const kinds = n.startsWith('math/') ? [['tex', n.slice(5)]] : n.startsWith('graphics/') ? [['md', n.slice(9)]] : [['tex', n], ['md', n]];
    for (const [kind, rel] of kinds) {
      const url = new URL(kind === 'tex' ? `${rel}.tex` : `${rel}.md`, kind === 'tex' ? pk.math : pk.graphics).href;
      try { return { url, kind, name: rel, pack: pk, text: await fetchText(url) }; } catch { /* try the next kind */ }
    }
    throw new Error(`not found in pack "${p}" (looked for ${kinds.map(([k, r]) => (k === 'tex' ? `math/${r}.tex` : `graphics/${r}.md`)).join(', ')})`);
  };
  const math = (asset, args) => expandMath(asset.name, args, {
    prefix: asset.pack.prefix,
    load: (n) => fetchText(new URL(`${n}.tex`, asset.pack.math)),
  });
  const expanded = await expandUses(body, resolve, { deckParams: meta.params || {}, errors: report.errors, deckUrl, math });

  const libs = [];
  if (/^\s*(`{3,}|~{3,})\s*mermaid/m.test(expanded)) libs.push(loadScript(new URL('mermaid.min.js', VENDOR)));
  if (/^\s*(`{3,}|~{3,})\s*(plot|fnplot)/m.test(expanded)) libs.push(loadScript(new URL('d3.min.js', VENDOR)));
  await Promise.all(libs);

  // `macros:` is a map, or the path of a .tex file of \newcommand/\providecommand lines (shared with LaTeX).
  const readMacros = async (spec, base) => {
    if (!spec) return {};
    if (typeof spec === 'object') return spec;
    try { return parseMacros(await fetchText(new URL(spec, base))); } catch (err) { report.error(`macros ${spec}: ${err.message}`); return {}; }
  };
  const macros = { ...(await readMacros(pack.macros, packUrl)), ...(await readMacros(meta.macros, deckUrl)) };
  const renderer = createRenderer({ macros, report });
  const logo = pack.logo && packUrl ? await fetchText(new URL(pack.logo, packUrl)).catch(() => '') : '';
  const sources = splitSlides(expanded);
  const slides = [];
  let inherited = {};
  sources.forEach((src, i) => {
    const sl = renderer.slide(src, i, inherited);
    inherited = { section: sl.attrs.section };
    slides.push(sl);
  });
  const footerText = meta.footer ?? pack.footer ?? meta.short ?? '';
  for (const sl of slides) {
    for (const el of sl.el.querySelectorAll('.sk-c-logo')) el.innerHTML = logo;
    if (sl.attrs.footer === 'false' || ['title', 'blank'].includes(sl.attrs.layout)) continue;
    const f = document.createElement('footer');
    f.className = 'sk-footer';
    f.innerHTML = `<span class="sk-footer-logo">${logo}</span><span class="sk-footer-section"></span><span class="sk-footer-text"></span><span class="sk-footer-num">${sl.el.dataset.index * 1 + 1}</span>`;
    f.querySelector('.sk-footer-section').textContent = sl.attrs.section || '';
    f.querySelector('.sk-footer-text').textContent = footerText;
    sl.el.appendChild(f);
  }
  document.title = meta.title || 'doc-kit';
  const deck = { meta, pack, slides, deckUrl, ctx: { renderer, report, deckUrl } };
  return deck;
}

async function mountAll(deck, container) {
  for (const sl of deck.slides) container.appendChild(sl.el);
  await Promise.all(deck.slides.map((sl) => mountComponents(sl.el, deck.ctx)));
  for (const sl of deck.slides) sl.steps = indexSteps(sl.el);
  await document.fonts.ready;
}

/* ---------------------------------------------------------------- present */

function fit(viewport, deckEl, w = SLIDE_W, h = SLIDE_H) {
  const r = viewport.getBoundingClientRect();
  const k = Math.min(r.width / w, r.height / h);
  deckEl.style.transform = `translate(${(r.width - w * k) / 2}px, ${(r.height - h * k) / 2}px) scale(${k})`;
}

function navigator(deck, onChange) {
  const st = { i: 0, s: 0 };
  const n = deck.slides.length;
  const go = (i, s, quiet) => {
    i = Math.max(0, Math.min(n - 1, i | 0));
    s = Math.max(0, Math.min(deck.slides[i].steps, s | 0));
    st.i = i; st.s = s;
    onChange(st, quiet);
  };
  const next = () => (st.s < deck.slides[st.i].steps ? go(st.i, st.s + 1) : st.i < n - 1 && go(st.i + 1, 0));
  const prev = () => (st.s > 0 ? go(st.i, st.s - 1) : st.i > 0 && go(st.i - 1, deck.slides[st.i - 1].steps));
  const peek = () => (st.s < deck.slides[st.i].steps ? [st.i, st.s + 1] : st.i < n - 1 ? [st.i + 1, 0] : null);
  return { st, go, next, prev, peek };
}

function showSlide(deck, i, s) {
  deck.slides.forEach((sl, k) => sl.el.classList.toggle('sk-active', k === i));
  applyStep(deck.slides[i].el, s);
}

function keyHandler(nav, extra = {}) {
  let typed = '';
  return (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (/^\d$/.test(k)) { typed += k; return; }
    if (k === 'Enter' && typed) { nav.go(+typed - 1, 0); typed = ''; return; }
    typed = '';
    if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'n'].includes(k)) nav.next();
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'p', 'Backspace'].includes(k)) nav.prev();
    else if (k === 'Home') nav.go(0, 0);
    else if (k === 'End') nav.go(Infinity, 0);
    else if (extra[k]) extra[k]();
    else return;
    e.preventDefault();
  };
}

function channelFor(deck) {
  try { return new BroadcastChannel(`doc-kit:${deck.deckUrl}`); } catch { return null; }
}

function parseHash() {
  const m = /^#\/(\d+)(?:\.(\d+))?/.exec(location.hash);
  return m ? [+m[1] - 1, +(m[2] || 0)] : [0, 0];
}

async function present(deck) {
  document.body.classList.add('sk-mode-present');
  document.body.innerHTML = '<div class="sk-viewport"><div class="sk-deck"></div></div><div class="sk-progress"><i></i></div><div class="sk-help" hidden></div>';
  const viewport = document.querySelector('.sk-viewport');
  const deckEl = document.querySelector('.sk-deck');
  await mountAll(deck, deckEl);
  const chan = channelFor(deck);
  const bar = document.querySelector('.sk-progress i');
  const nav = navigator(deck, (st, quiet) => {
    showSlide(deck, st.i, st.s);
    history.replaceState(null, '', `#/${st.i + 1}${st.s ? '.' + st.s : ''}`);
    bar.style.width = `${(100 * (st.i + 1)) / deck.slides.length}%`;
    if (!quiet) chan?.postMessage({ type: 'go', i: st.i, s: st.s });
  });
  deck.onRetheme = () => showSlide(deck, nav.st.i, nav.st.s);
  chan && (chan.onmessage = (e) => e.data.type === 'go' && nav.go(e.data.i, e.data.s, true));
  const help = document.querySelector('.sk-help');
  help.innerHTML = '<b>Keys</b><br>→ / space: next · ←: back · Home/End<br>number + Enter: go to slide<br>t: light/dark · s: speaker view · f: fullscreen · ?: this help';
  const extra = {
    t: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', deck),
    s: () => window.open(`${location.pathname}?speaker${location.hash}`, 'doc-kit-speaker', 'width=1280,height=800'),
    f: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()),
    '?': () => (help.hidden = !help.hidden),
  };
  document.addEventListener('keydown', keyHandler(nav, extra));
  viewport.addEventListener('click', (e) => {
    if (e.target.closest('a, button, iframe, .sk-plot, input, summary')) return;
    (e.clientX < window.innerWidth / 4 ? nav.prev : nav.next)();
  });
  window.addEventListener('hashchange', () => { const [i, s] = parseHash(); if (i !== nav.st.i || s !== nav.st.s) nav.go(i, s); });
  window.addEventListener('resize', () => fit(viewport, deckEl));
  fit(viewport, deckEl);
  const [i, s] = parseHash();
  nav.go(i, s, true);
  watchSource(deck);
  // Hooks for tools/check.py and tools/export_pdf.py.
  Object.assign(api, {
    count: () => deck.slides.length,
    steps: (k) => deck.slides[k].steps,
    go: (k, st) => nav.go(k, st, true),
    theme: (t) => setTheme(t, deck, false),
    overflow: (k) => overflow(deck.slides[k].el),
    notes: (k) => deck.slides[k].notes,
  });
}

/** Elements that stick out of the slide body or out of their column (in slide pixels). */
function overflow(slideEl) {
  const body = slideEl.querySelector('.sk-body');
  const k = slideEl.getBoundingClientRect().width / SLIDE_W || 1;
  const out = [];
  const seen = new Set();
  for (const container of [body, ...body.querySelectorAll('.sk-col')]) {
    const box = container.getBoundingClientRect();
    const inCol = container !== body;
    for (const el of container.querySelectorAll('*')) {
      if (seen.has(el) || (el.closest('.sk-hidden, .sk-tooltip, .katex-mathml, style, svg') && el.tagName !== 'svg')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const dx = (r.right - box.right) / k, dy = inCol ? 0 : (r.bottom - box.bottom) / k, dl = (box.left - r.left) / k;
      if (dx > 2 || dy > 2 || dl > 2) {
        seen.add(el);
        out.push({ tag: el.tagName.toLowerCase(), where: inCol ? 'column' : 'slide', text: (el.textContent || '').trim().slice(0, 60), right: Math.round(dx), bottom: Math.round(dy), left: Math.round(dl) });
      }
    }
  }
  // Report outermost offenders only.
  return out.filter((o, idx) => !out.slice(0, idx).some((p) => p.text.includes(o.text) && p.text.length > o.text.length)).slice(0, 6);
}

/** On localhost, reload when the deck source changes (authors edit and save). */
function watchSource(deck) {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || params.has('nowatch')) return;
  let last = null;
  setInterval(async () => {
    try {
      const t = await fetchText(deck.deckUrl);
      if (last !== null && t !== last) location.reload();
      last = t;
    } catch { /* server gone; keep the current view */ }
  }, 1500);
}

/* ---------------------------------------------------------------- speaker */

async function speaker(deck) {
  document.body.classList.add('sk-mode-speaker');
  document.body.innerHTML = `
    <div class="sk-spk">
      <div class="sk-spk-cur"><div class="sk-viewport"><div class="sk-deck"></div></div></div>
      <div class="sk-spk-side">
        <div class="sk-spk-bar">
          <span class="sk-spk-timer" title="click: pause/resume">00:00</span>
          <button class="sk-spk-reset" type="button">reset</button>
          <span class="sk-spk-clock"></span>
          <span class="sk-spk-pos"></span>
        </div>
        <div class="sk-spk-label">Next</div>
        <div class="sk-spk-next"><div class="sk-viewport"><div class="sk-deck"></div></div></div>
        <div class="sk-spk-label">Notes</div>
        <div class="sk-spk-notes"></div>
      </div>
    </div>`;
  const [curVp, nextVp] = document.querySelectorAll('.sk-viewport');
  const [curDeck, nextDeck] = document.querySelectorAll('.sk-deck');
  await mountAll(deck, curDeck);
  const clones = deck.slides.map((sl) => { const c = sl.el.cloneNode(true); nextDeck.appendChild(c); return c; });
  const notesEl = document.querySelector('.sk-spk-notes');
  const pos = document.querySelector('.sk-spk-pos');
  const chan = channelFor(deck);
  const nav = navigator(deck, (st, quiet) => {
    showSlide(deck, st.i, st.s);
    const nx = nav.peek();
    clones.forEach((c, k) => c.classList.toggle('sk-active', nx && k === nx[0]));
    if (nx) applyStep(clones[nx[0]], nx[1]);
    nextVp.classList.toggle('sk-spk-end', !nx);
    notesEl.innerHTML = deck.slides[st.i].notes || '<p class="sk-spk-none">No notes.</p>';
    pos.textContent = `${st.i + 1}/${deck.slides.length} · step ${st.s}/${deck.slides[st.i].steps}`;
    if (!quiet) chan?.postMessage({ type: 'go', i: st.i, s: st.s });
  });
  chan && (chan.onmessage = (e) => e.data.type === 'go' && nav.go(e.data.i, e.data.s, true));
  document.addEventListener('keydown', keyHandler(nav, { t: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', deck) }));
  const refit = () => { fit(curVp, curDeck); fit(nextVp, nextDeck); };
  window.addEventListener('resize', refit);
  refit();

  // Timer: counts up from the first navigation; click to pause.
  const timerEl = document.querySelector('.sk-spk-timer');
  const clockEl = document.querySelector('.sk-spk-clock');
  const budget = (deck.meta.duration || 0) * 60;
  let start = Date.now(), pausedAt = null;
  timerEl.addEventListener('click', () => {
    if (pausedAt) { start += Date.now() - pausedAt; pausedAt = null; } else pausedAt = Date.now();
    timerEl.classList.toggle('sk-paused', !!pausedAt);
  });
  document.querySelector('.sk-spk-reset').addEventListener('click', () => { start = Date.now(); if (pausedAt) pausedAt = start; });
  const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const tick = () => {
    const el = ((pausedAt || Date.now()) - start) / 1000;
    timerEl.textContent = mmss(el) + (budget ? ` / ${mmss(budget)}` : '');
    timerEl.classList.toggle('sk-over', budget > 0 && el > budget);
    clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  setInterval(tick, 500);
  tick();
  const [i, s] = parseHash();
  nav.go(i, s, true);
}

/* ------------------------------------------------------------------ print */

async function print(deck) {
  const perStep = params.get('print') === 'steps';
  document.body.classList.add('sk-mode-print');
  document.body.innerHTML = '<div class="sk-print"></div><div class="sk-stage-hidden"></div>';
  const style = document.createElement('style');
  style.textContent = `@page { size: ${SLIDE_W}px ${SLIDE_H}px; margin: 0; }`;
  document.head.appendChild(style);
  const out = document.querySelector('.sk-print');
  await mountAll(deck, out);
  if (perStep) {
    for (const sl of deck.slides) {
      const pages = [];
      for (let s = 0; s <= sl.steps; s++) {
        const c = s === sl.steps ? sl.el : sl.el.cloneNode(true);
        applyStep(c, s);
        pages.push(c);
      }
      sl.el.replaceWith(...pages);
    }
  } else {
    for (const sl of deck.slides) applyStep(sl.el, sl.steps);
  }
  for (const el of out.children) el.classList.add('sk-active');
  Object.assign(api, { pages: () => out.children.length, theme: (t) => setTheme(t, null, false) });
}

/* ------------------------------------------------------------------- boot */

(async () => {
  try {
    const deck = await loadDeck();
    if (MODE === 'print') await print(deck);
    else if (MODE === 'speaker') await speaker(deck);
    else await present(deck);
  } catch (err) {
    report.error(`fatal: ${err.message}`);
    document.body.innerHTML = `<pre class="sk-fatal">doc-kit could not load this deck:\n${err.message}\n\nServe the repo over HTTP (python3 tools/serve.py) rather than opening the file directly.</pre>`;
  }
  api.isReady = true;
  readyResolve();
})();
