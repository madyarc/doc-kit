// Components mounted into rendered slides: mermaid diagrams, CSV plots,
// analytic function plots, and figure fallbacks for missing images.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let uid = 0;

export async function mountComponents(slideEl, ctx) {
  // Single-file deck: images come from the bundle (SVG figures are fetched and inlined below instead).
  if (window.docKitBundle) for (const img of slideEl.querySelectorAll('img[src]')) {
    if (img.matches('.sk-figure img[data-pending]') && /\.svg(\?|#|$)/i.test(img.getAttribute('src'))) continue;
    const u = window.docKitBundle.url(img.src);
    if (u) img.src = u;
  }
  for (const img of slideEl.querySelectorAll('.sk-figure img[data-pending]')) await figureFallback(img, ctx);
  const jobs = [];
  for (const el of slideEl.querySelectorAll('.sk-comp')) {
    const comp = ctx.renderer.components[+el.dataset.comp];
    el._sk = comp;
    jobs.push(mountOne(el, comp, ctx).catch((err) => {
      ctx.report.error(`${comp.lang}: ${err.message}`);
      el.innerHTML = `<div class="sk-missing"><b>${esc(comp.lang)} error</b>: ${esc(err.message)}</div>`;
    }));
  }
  await Promise.all(jobs);
}

async function mountOne(el, comp, ctx) {
  if (comp.lang === 'mermaid') return renderMermaid(el, comp, ctx);
  const cfg = jsyaml.load(comp.src) || {};
  if (comp.lang === 'plot') return renderDataPlot(el, cfg, ctx);
  if (comp.lang === 'fnplot') return renderFnPlot(el, cfg, ctx);
}

/** Re-render theme-dependent components (mermaid bakes its colours in). */
export async function rethemeComponents(root, ctx) {
  const jobs = [];
  for (const el of root.querySelectorAll('.sk-comp-mermaid')) if (el._sk) jobs.push(renderMermaid(el, el._sk, ctx));
  await Promise.all(jobs);
}

async function figureFallback(img, ctx) {
  // SVG figures are inlined, so text drawn in currentColor (doc_kit.plots.save) follows the theme.
  if (/\.svg(\?|#|$)/i.test(img.getAttribute('src'))) {
    try {
      const r = await fetch(img.src, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const box = document.createElement('div');
      box.className = 'sk-svg';
      box.innerHTML = (await r.text()).replace(/^[\s\S]*?(<svg\b)/i, '$1');
      const svg = box.querySelector('svg');
      if (!svg) throw new Error('not an SVG');
      if (!svg.getAttribute('viewBox') && svg.getAttribute('width')) svg.setAttribute('viewBox', `0 0 ${parseFloat(svg.getAttribute('width'))} ${parseFloat(svg.getAttribute('height'))}`);
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('role', 'img');
      if (img.alt) svg.setAttribute('aria-label', img.alt);
      img.replaceWith(box);
      return;
    } catch { /* fall through to the placeholder below */ }
  }
  return new Promise((resolve) => {
    const fail = () => {
      ctx.report.tbd(`figure ${img.getAttribute('src')}`);
      const ph = document.createElement('div');
      ph.className = 'sk-placeholder';
      ph.innerHTML = `<div class="sk-ph-tag">Pending figure</div><div class="sk-ph-title">${esc(img.getAttribute('src'))}</div><p>${esc(img.dataset.pending)}</p>`;
      img.replaceWith(ph);
      resolve();
    };
    if (img.complete) return img.naturalWidth ? resolve() : fail();
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', fail, { once: true });
  });
}

/* ------------------------------------------------------------------ mermaid */

/** Mermaid configuration from the current theme's CSS tokens (also used by tools/export_graphics.py). */
export function mermaidTheme() {
  return {
    startOnLoad: false,
    securityLevel: 'loose',
    forceLegacyMathML: true,
    theme: 'base',
    fontFamily: css('--sk-font'),
    themeVariables: {
      fontFamily: css('--sk-font'),
      fontSize: '20px',
      background: css('--sk-bg'),
      primaryColor: css('--sk-surface-2'),
      primaryTextColor: css('--sk-fg'),
      primaryBorderColor: css('--sk-border-strong'),
      secondaryColor: css('--sk-surface-2'),
      tertiaryColor: css('--sk-surface-1'),
      lineColor: css('--sk-muted'),
      textColor: css('--sk-fg'),
      clusterBkg: css('--sk-surface-1'),
      clusterBorder: css('--sk-border'),
      edgeLabelBackground: css('--sk-bg'),
    },
    flowchart: { htmlLabels: true, curve: 'basis', padding: 12, nodeSpacing: 36, rankSpacing: 44 },
  };
}

async function renderMermaid(el, comp, ctx) {
  // ```mermaid src=diagram.mmd loads the diagram from a file; lines in the
  // fence body (e.g. %% step directives) are appended to it.
  const srcFile = /(?:^|\s)src=(\S+)/.exec(comp.info)?.[1];
  if (srcFile && comp.file === undefined) {
    const r = await fetch(new URL(srcFile, ctx.deckUrl), { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${srcFile}`);
    comp.file = await r.text();
  }
  const source = srcFile ? `${comp.file}\n${comp.src}` : comp.src;
  mermaid.initialize(mermaidTheme());
  const { svg } = await mermaid.render(`skmm${++uid}`, source);
  el.innerHTML = svg;
  const svgEl = el.querySelector('svg');
  svgEl.removeAttribute('width');
  svgEl.style.maxWidth = '100%';
  svgEl.style.height = 'auto';
  const maxH = /(?:^|\s)height=(\S+)/.exec(comp.info)?.[1];
  if (maxH) svgEl.style.maxHeight = maxH;
  // `%% step N: a b c` and `%% hl N[-M]: a b` attach reveals/highlights to node ids.
  const nodeStep = new Map();
  for (const line of source.split('\n')) {
    const m = /^\s*%%\s*(step|hl)\s+([\d-]+)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    for (const id of m[3].trim().split(/[\s,]+/)) {
      const targets = mermaidNode(svgEl, id);
      if (!targets.length) ctx.report.error(`mermaid: no node "${id}" for %% ${m[1]}`);
      for (const t of targets) t.dataset[m[1]] = m[2];
      if (m[1] === 'step') nodeStep.set(id, +m[2]);
    }
  }
  if (nodeStep.size) {
    // An edge (and its label) appears with the later of its two endpoints.
    for (const path of svgEl.querySelectorAll('path[data-id^="L_"], path[id^="L_"], path[id^="L-"]')) {
      const key = path.dataset.id || path.id;
      const ends = edgeEnds(key, svgEl);
      if (!ends) continue;
      const n = Math.max(nodeStep.get(ends[0]) || 0, nodeStep.get(ends[1]) || 0);
      if (!n) continue;
      path.dataset.step = n;
      for (const lbl of svgEl.querySelectorAll(`.edgeLabel [data-id="${CSS.escape(key)}"]`)) lbl.closest('.edgeLabel').dataset.step = n;
    }
  }
}

function mermaidNode(svgEl, id) {
  const out = [...svgEl.querySelectorAll(`g.node[id^="flowchart-${CSS.escape(id)}-"], g.node[data-id="${CSS.escape(id)}"], g.cluster[id="${CSS.escape(id)}"], g.cluster[data-id="${CSS.escape(id)}"]`)];
  return out.filter((n) => n.dataset.id === id || n.id === id || new RegExp(`^flowchart-${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(n.id));
}

function edgeEnds(key, svgEl) {
  // Edge keys look like L_<from>_<to>_<n>; node ids may contain "_", so try every split.
  const body = key.replace(/^L[_-]/, '').replace(/[_-]\d+$/, '');
  const ids = new Set([...svgEl.querySelectorAll('g.node')].map((n) => n.dataset.id || n.id.replace(/^flowchart-/, '').replace(/-\d+$/, '')));
  const parts = body.split(/[_-]/);
  for (let i = 1; i < parts.length; i++) {
    const a = parts.slice(0, i).join('_'), b = parts.slice(i).join('_');
    if (ids.has(a) && ids.has(b)) return [a, b];
  }
  return null;
}

/* ---------------------------------------------------------------- plotting */

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const pow10 = (v) => { const e = Math.round(Math.log10(v)); return '10' + String(e).replace(/./g, (c) => SUP[c] ?? c); };

function frame(el, cfg) {
  const W = cfg.width || el.clientWidth || 640;
  const H = cfg.height || el.clientHeight || Math.round(W * 0.55);
  const m = { top: 16, right: cfg.endLabels ? 120 : 24, bottom: cfg.x?.label ? 62 : 40, left: cfg.y?.label ? 86 : 64, ...(cfg.margin || {}) };
  return { W, H, m, iw: W - m.left - m.right, ih: H - m.top - m.bottom };
}

function scale(axis, domain, range) {
  const s = (axis?.log ? d3.scaleLog() : d3.scaleLinear()).domain(domain).range(range);
  if (!axis?.domain) s.nice();
  return s;
}

function drawAxes(g, f, x, y, cfg) {
  const { iw, ih } = f;
  const yTicks = y.ticks(cfg.y?.ticks || 5).filter((t) => !cfg.y?.log || Math.abs(Math.log10(t) % 1) < 1e-9);
  const xTicks = x.ticks(cfg.x?.ticks || 6).filter((t) => !cfg.x?.log || Math.abs(Math.log10(t) % 1) < 1e-9);
  const fmt = (axis, s) => {
    if (axis?.log) return pow10;
    if (axis?.format) return d3.format(axis.format);
    const big = Math.max(...s.domain().map(Math.abs)) >= 1e3;
    return big ? d3.format('~s') : s.tickFormat(6, '~g');
  };
  g.append('g').attr('class', 'sk-grid')
    .selectAll('line').data(yTicks).join('line')
    .attr('x1', 0).attr('x2', iw).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  const ya = g.append('g').attr('class', 'sk-axis');
  ya.selectAll('text').data(yTicks).join('text')
    .attr('x', -10).attr('y', (d) => y(d)).attr('dy', '0.35em').attr('text-anchor', 'end').text(fmt(cfg.y, y));
  const xa = g.append('g').attr('class', 'sk-axis');
  xa.append('line').attr('class', 'sk-baseline').attr('x1', 0).attr('x2', iw).attr('y1', ih).attr('y2', ih);
  xa.selectAll('text').data(xTicks).join('text')
    .attr('x', (d) => x(d)).attr('y', ih + 24).attr('text-anchor', 'middle').text(fmt(cfg.x, x));
  if (cfg.x?.label) g.append('text').attr('class', 'sk-axis-label').attr('x', iw / 2).attr('y', ih + 54).attr('text-anchor', 'middle').text(cfg.x.label);
  if (cfg.y?.label) {
    // Short labels (a symbol) read better upright.
    const upright = [...cfg.y.label].length <= 2;
    g.append('text').attr('class', 'sk-axis-label').attr('text-anchor', 'middle')
      .attr('transform', upright ? `translate(${-f.m.left + 18},${ih / 2})` : `translate(${-f.m.left + 22},${ih / 2}) rotate(-90)`)
      .text(cfg.y.label);
  }
}

function plotTitle(el, cfg) {
  if (!cfg.title) return;
  const div = document.createElement('div');
  div.className = 'sk-plot-title';
  div.textContent = cfg.title;
  el.prepend(div);
}

function legend(el, items) {
  if (items.length < 2) return;
  const div = document.createElement('div');
  div.className = 'sk-legend';
  div.innerHTML = items.map((it) => `<span class="sk-legend-item"${it.follow ? ` data-step-follow="${it.follow}"` : ''}><i style="background:${it.color}${it.dash ? ';background:repeating-linear-gradient(90deg,' + it.color + ' 0 6px,transparent 6px 10px)' : ''}"></i>${esc(it.label)}</span>`).join('');
  el.prepend(div);
}

function seriesColor(s, i) {
  if (s.color) return s.color.startsWith('--') ? `var(${s.color})` : s.color;
  return `var(--sk-series-${(s.slot || i + 1)})`;
}

function stepOf(item, cfg, i) {
  if (item.step !== undefined) return item.step;
  return cfg.reveal === 'series' || cfg.reveal === true ? 'auto' : null;
}

function tooltip(el, svg, f, x, xs, lines) {
  // Crosshair + readout of every visible series at the nearest x.
  const tip = document.createElement('div');
  tip.className = 'sk-tooltip';
  el.appendChild(tip);
  const g = svg.select('g.sk-inner');
  const rule = g.append('line').attr('class', 'sk-crosshair').attr('y1', 0).attr('y2', f.ih).style('display', 'none');
  g.append('rect').attr('width', f.iw).attr('height', f.ih).attr('fill', 'transparent')
    .on('mousemove', (ev) => {
      const [mx] = d3.pointer(ev);
      const xv = x.invert(mx);
      const rows = [];
      for (const ln of lines) {
        if (ln.node.closest('.sk-hidden')) continue;
        const i = Math.max(0, Math.min(ln.data.length - 1, d3.bisector((d) => d[0]).center(ln.data, xv)));
        const d = ln.data[i];
        if (d) rows.push(`<div><i style="background:${ln.color}"></i>${esc(ln.label)}: <b>${d3.format('.4~g')(d[1])}</b></div>`);
      }
      if (!rows.length) return;
      rule.style('display', null).attr('x1', mx).attr('x2', mx);
      tip.innerHTML = `<div class="sk-tooltip-x">${esc(xs)} ${d3.format('~g')(xv)}</div>${rows.join('')}`;
      tip.style.display = 'block';
      const left = f.m.left + mx + 14;
      tip.style.left = `${left + tip.offsetWidth > f.W ? left - tip.offsetWidth - 28 : left}px`;
      tip.style.top = `${f.m.top + 8}px`;
    })
    .on('mouseleave', () => { rule.style('display', 'none'); tip.style.display = 'none'; });
}

/* ---------------------------------------------------------- CSV data plots */

const csvCache = new Map();
async function loadCsv(url) {
  if (!csvCache.has(url)) {
    csvCache.set(url, fetch(url, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }).then((t) => d3.csvParse(t)));
  }
  return csvCache.get(url);
}

function findColumn(cols, want) {
  if (cols.includes(want)) return want;
  // W&B exports name columns "<run> - <metric>"; match on a unique substring,
  // ignoring the __MIN / __MAX companions.
  const hits = cols.filter((c) => c.includes(want) && !/__(MIN|MAX)$/.test(c));
  return hits.length === 1 ? hits[0] : null;
}

async function renderDataPlot(el, cfg, ctx) {
  const series = cfg.series || [];
  const missing = [];
  const loaded = [];
  for (const s of series) {
    const src = s.src || cfg.src;
    const url = new URL(src, ctx.deckUrl).href;
    let rows;
    try { rows = await loadCsv(url); } catch { missing.push(`<li><code>${esc(src)}</code> (columns: <code>${esc(s.x || cfg.x?.column || 'Step')}</code>, <code>${esc(s.y)}</code>)</li>`); continue; }
    const cols = rows.columns;
    const xc = findColumn(cols, s.x || cfg.x?.column || 'Step');
    const yc = findColumn(cols, s.y);
    if (!xc || !yc) { missing.push(`<li><code>${esc(src)}</code>: no column matching <code>${esc(!xc ? s.x || 'Step' : s.y)}</code></li>`); continue; }
    loaded.push({ s, rows, xc, yc, lo: cols.includes(yc + '__MIN') ? yc + '__MIN' : null, hi: cols.includes(yc + '__MAX') ? yc + '__MAX' : null });
  }
  if (missing.length) {
    ctx.report.tbd(`plot data: ${cfg.title || series.map((s) => s.src || cfg.src).join(', ')}`);
    el.innerHTML = `<div class="sk-placeholder"><div class="sk-ph-tag">Pending data</div><div class="sk-ph-title">${esc(cfg.title || 'Plot')}</div><p>Drop these CSV exports into the talk folder and refresh:</p><ul>${[...new Set(missing)].join('')}</ul></div>`;
    return;
  }
  return cfg.kind === 'bar' ? barPlot(el, cfg, loaded) : linePlot(el, cfg, loaded);
}

function ema(data, a) {
  if (!a) return data;
  let v = null;
  return data.map(([x, y]) => [x, (v = v === null ? y : a * v + (1 - a) * y)]);
}

function linePlot(el, cfg, loaded) {
  el.innerHTML = '';
  const holder = document.createElement('div');
  holder.className = 'sk-plot';
  el.appendChild(holder);
  const items = loaded.map((L, i) => {
    const num = (r, c) => (r[c] === '' || r[c] == null ? NaN : +r[c]);
    let data = L.rows.map((r) => [num(r, L.xc), num(r, L.yc), L.lo ? num(r, L.lo) : NaN, L.hi ? num(r, L.hi) : NaN])
      .filter((d) => Number.isFinite(d[0]) && Number.isFinite(d[1]) && (!cfg.y?.log || d[1] > 0));
    data.sort((a, b) => a[0] - b[0]);
    const sm = L.s.smooth ?? cfg.smooth;
    if (sm) data = ema(data, sm);
    return { ...L.s, data, color: seriesColor(L.s, i), label: L.s.label || L.yc, stepv: stepOf(L.s, cfg, i) };
  });
  const f = frame(holder, cfg);
  const all = items.flatMap((it) => it.data);
  const x = scale(cfg.x, cfg.x?.domain || d3.extent(all, (d) => d[0]), [0, f.iw]);
  const ys = all.flatMap((d) => [d[1], ...(Number.isFinite(d[2]) ? [d[2], d[3]] : [])]).filter((v) => !cfg.y?.log || v > 0);
  const y = scale(cfg.y, cfg.y?.domain || d3.extent(ys), [f.ih, 0]);
  const svg = d3.select(holder).append('svg').attr('viewBox', `0 0 ${f.W} ${f.H}`).attr('width', f.W).attr('height', f.H).attr('class', 'sk-plot-svg');
  const g = svg.append('g').attr('class', 'sk-inner').attr('transform', `translate(${f.m.left},${f.m.top})`);
  drawAxes(g, f, x, y, cfg);
  const clip = `skclip${++uid}`;
  svg.append('clipPath').attr('id', clip).append('rect').attr('width', f.iw).attr('height', f.ih);
  const lines = [];
  for (const it of items) {
    const sg = g.append('g').attr('clip-path', `url(#${clip})`).attr('class', 'sk-series');
    if (it.stepv) sg.attr('data-step', it.stepv).attr('data-key', (it.key = `sks${++uid}`));
    if (it.hl) sg.attr('data-hl', it.hl);
    if (cfg.band !== false && it.data.some((d) => Number.isFinite(d[2]))) {
      sg.append('path').attr('class', 'sk-band').style('fill', it.color)
        .attr('d', d3.area().x((d) => x(d[0])).y0((d) => y(d[2])).y1((d) => y(d[3])).defined((d) => Number.isFinite(d[2]) && Number.isFinite(d[3]))(it.data));
    }
    sg.append('path').attr('class', 'sk-line').style('stroke', it.color)
      .attr('stroke-dasharray', it.dash ? '7 5' : null)
      .attr('d', d3.line().x((d) => x(d[0])).y((d) => y(d[1]))(it.data));
    const last = it.data.at(-1);
    if (last) {
      sg.append('circle').attr('class', 'sk-dot').attr('r', 4.5).attr('cx', x(last[0])).attr('cy', y(last[1])).style('fill', it.color);
      if (cfg.endLabels) sg.append('text').attr('class', 'sk-end-label').attr('x', x(last[0]) + 10).attr('y', y(last[1])).attr('dy', '0.35em').text(it.label);
    }
    lines.push({ node: sg.node(), data: it.data, color: it.color, label: it.label });
  }
  legend(holder, items.map((it) => ({ label: it.label, color: it.color, dash: it.dash, follow: it.key })));
  plotTitle(holder, cfg);
  tooltip(holder, svg, f, x, cfg.x?.label || 'x', lines);
}

function barPlot(el, cfg, loaded) {
  // Grouped bars: categories from the x column of the first series' file.
  el.innerHTML = '';
  const holder = document.createElement('div');
  holder.className = 'sk-plot';
  el.appendChild(holder);
  const cats = [...new Set(loaded.flatMap((L) => L.rows.map((r) => r[L.xc])))];
  const items = loaded.map((L, i) => ({ ...L.s, color: seriesColor(L.s, i), label: L.s.label || L.yc, stepv: stepOf(L.s, cfg, i), vals: new Map(L.rows.map((r) => [r[L.xc], +r[L.yc]])) }));
  const f = frame(holder, cfg);
  const x0 = d3.scaleBand().domain(cats).range([0, f.iw]).paddingInner(0.25).paddingOuter(0.1);
  const x1 = d3.scaleBand().domain(items.map((_, i) => i)).range([0, x0.bandwidth()]).padding(0.08);
  const vals = items.flatMap((it) => [...it.vals.values()]).filter((v) => Number.isFinite(v) && (!cfg.y?.log || v > 0));
  const y = scale(cfg.y, cfg.y?.domain || (cfg.y?.log ? d3.extent(vals) : [0, d3.max(vals)]), [f.ih, 0]);
  const svg = d3.select(holder).append('svg').attr('viewBox', `0 0 ${f.W} ${f.H}`).attr('width', f.W).attr('height', f.H).attr('class', 'sk-plot-svg');
  const g = svg.append('g').attr('class', 'sk-inner').attr('transform', `translate(${f.m.left},${f.m.top})`);
  const fakeX = { ticks: () => [] };
  drawAxes(g, f, fakeX, y, { ...cfg, x: { ...cfg.x, label: cfg.x?.label } });
  g.append('g').attr('class', 'sk-axis').selectAll('text').data(cats).join('text')
    .attr('x', (d) => x0(d) + x0.bandwidth() / 2).attr('y', f.ih + 24).attr('text-anchor', 'middle').text((d) => d);
  const bw = Math.min(x1.bandwidth(), 40);
  const base = cfg.y?.log ? f.ih : y(0);
  items.forEach((it, i) => {
    const sg = g.append('g').attr('class', 'sk-series');
    if (it.stepv) sg.attr('data-step', it.stepv).attr('data-key', (it.key = `sks${++uid}`));
    for (const c of cats) {
      const v = it.vals.get(c);
      if (!Number.isFinite(v) || (cfg.y?.log && v <= 0)) continue;
      const bx = x0(c) + x1(i) + (x1.bandwidth() - bw) / 2, top = y(v), r = Math.min(4, (base - top) / 2);
      sg.append('path').style('fill', it.color)
        .attr('d', `M${bx},${base}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + bw - r}Q${bx + bw},${top} ${bx + bw},${top + r}V${base}Z`)
        .append('title').text(`${it.label} · ${c}: ${d3.format('.4~g')(v)}`);
    }
  });
  legend(holder, items.map((it) => ({ label: it.label, color: it.color, follow: it.key })));
  plotTitle(holder, cfg);
}

/* ------------------------------------------------------ analytic fn plots */

function renderFnPlot(el, cfg, ctx) {
  el.innerHTML = '';
  const holder = document.createElement('div');
  holder.className = 'sk-plot';
  el.appendChild(holder);
  const v = cfg.var || 'x';
  const define = cfg.define || '';
  const compile = (expr) => new Function(v, `"use strict"; const {${Object.getOwnPropertyNames(Math).join(',')}} = Math; ${define}; return (${expr});`);
  const f = frame(holder, cfg);
  const [x0, x1] = cfg.x.domain;
  const x = scale(cfg.x, cfg.x.domain, [0, f.iw]);
  const y = scale(cfg.y, cfg.y.domain, [f.ih, 0]);
  const [ylo, yhi] = cfg.y.domain;
  const span = yhi - ylo;
  const svg = d3.select(holder).append('svg').attr('viewBox', `0 0 ${f.W} ${f.H}`).attr('width', f.W).attr('height', f.H).attr('class', 'sk-plot-svg');
  const g = svg.append('g').attr('class', 'sk-inner').attr('transform', `translate(${f.m.left},${f.m.top})`);
  const clip = `skclip${++uid}`;
  svg.append('clipPath').attr('id', clip).append('rect').attr('width', f.iw).attr('height', f.ih);
  const tag = (sel, item) => {
    if (item.step !== undefined) sel.attr('data-step', item.step);
    if (item.hl !== undefined) sel.attr('data-hl', item.hl);
    return sel;
  };
  const colorOf = (c, i) => seriesColor(c, i);

  // Bands go under everything else.
  for (const b of cfg.bands || []) {
    const bg = tag(g.append('g').attr('class', 'sk-region').attr('clip-path', `url(#${clip})`), b);
    const bx0 = x(b.x ? b.x[0] : x0), bx1 = x(b.x ? b.x[1] : x1);
    const by0 = y(b.y ? b.y[1] : yhi), by1 = y(b.y ? b.y[0] : ylo);
    const fill = b.color ? (b.color.startsWith('--') ? `var(${b.color})` : b.color) : 'var(--sk-accent)';
    bg.append('rect').attr('x', Math.min(bx0, bx1)).attr('width', Math.abs(bx1 - bx0)).attr('y', by0).attr('height', by1 - by0)
      .style('fill', fill).attr('class', b.hatch ? 'sk-hatch' : 'sk-band-rect');
    if (b.label) bg.append('text').attr('class', 'sk-region-label').attr('x', (bx0 + bx1) / 2).attr('y', b.labelY !== undefined ? y(b.labelY) : by0 + 22).attr('text-anchor', 'middle').text(b.label);
  }
  drawAxes(g, f, x, y, cfg);
  for (const h of cfg.hlines || []) {
    const hg = tag(g.append('g'), h);
    hg.append('line').attr('class', 'sk-refline').attr('x1', 0).attr('x2', f.iw).attr('y1', y(h.y)).attr('y2', y(h.y));
    if (h.label) hg.append('text').attr('class', 'sk-ref-label').attr('x', f.iw - 6).attr('y', y(h.y) - 8).attr('text-anchor', 'end').text(h.label);
  }
  for (const vl of cfg.vlines || []) {
    const vg = tag(g.append('g'), vl);
    vg.append('line').attr('class', 'sk-refline').attr('x1', x(vl.x)).attr('x2', x(vl.x)).attr('y1', 0).attr('y2', f.ih);
    if (vl.label) vg.append('text').attr('class', 'sk-ref-label').attr('x', x(vl.x) + 6).attr('y', 18).text(vl.label);
  }
  const legendItems = [];
  (cfg.curves || []).forEach((c, i) => {
    let fn;
    try { fn = compile(c.fn); } catch (err) { ctx.report.error(`fnplot: ${c.fn}: ${err.message}`); return; }
    const n = c.samples || 1200;
    const pts = d3.range(n + 1).map((k) => { const t = x0 + (x1 - x0) * k / n; return [t, fn(t)]; });
    const color = colorOf(c, i);
    const cg = tag(g.append('g').attr('class', 'sk-series').attr('clip-path', `url(#${clip})`), c);
    const key = c.step !== undefined ? `sks${++uid}` : null;
    if (key) cg.attr('data-key', key);
    cg.append('path').attr('class', 'sk-line').style('stroke', color).attr('stroke-dasharray', c.dash ? '8 6' : null)
      .attr('d', d3.line().defined((d) => Number.isFinite(d[1]) && d[1] > ylo - 4 * span && d[1] < yhi + 4 * span).x((d) => x(d[0])).y((d) => y(d[1])).curve(d3.curveLinear)(pts));
    if (c.label) legendItems.push({ label: c.label, color, dash: c.dash, follow: key });
  });
  for (const a of cfg.notes || []) {
    tag(g.append('text').attr('class', 'sk-annot').attr('x', x(a.x)).attr('y', y(a.y)).attr('text-anchor', a.anchor || 'middle'), a).text(a.text);
  }
  legend(holder, legendItems);
  plotTitle(holder, cfg);
}
