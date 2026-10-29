// Rendering: Markdown + KaTeX + containers -> slide DOM, and the step model.

import { readDirectives, parseContainers } from './source.js';

const COMPONENT_LANGS = new Set(['mermaid', 'plot', 'fnplot']);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Step/highlight macros available in every deck. \step{2}{x} shows x from
// step 2; \hl{2}{x} highlights x at step 2 (also "2-4" or "2-").
const ENGINE_MACROS = {
  '\\step': '\\htmlData{step=#1}{#2}',
  '\\hl': '\\htmlData{hl=#1}{#2}',
  '\\hlb': '\\htmlData{hl=#1, hlc=b}{#2}',
};

export function createRenderer({ macros = {}, report }) {
  const md = markdownit({ html: true, linkify: false, typographer: false });
  const components = [];
  const katexMacros = { ...ENGINE_MACROS, ...macros };

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const tok = tokens[idx];
    const [lang, ...rest] = tok.info.trim().split(/\s+/);
    if (!COMPONENT_LANGS.has(lang)) return defaultFence(tokens, idx, opts, env, self);
    components.push({ lang, src: tok.content, info: rest.join(' ') });
    return `<div class="sk-comp sk-comp-${lang}" data-comp="${components.length - 1}"></div>\n`;
  };

  function tex(src, display) {
    try {
      return katex.renderToString(src, {
        displayMode: display, throwOnError: true, trust: true, strict: 'ignore',
        macros: { ...katexMacros },
      });
    } catch (err) {
      report.error(`KaTeX: ${err.message}`);
      return `<code class="sk-math-error" title="${esc(err.message)}">${esc(src)}</code>`;
    }
  }

  // Math and inline code are lifted out before Markdown sees the text, so
  // `_`, `*` and `|` inside formulas are never parsed as Markdown.
  function markdown(text) {
    const math = [];
    const protectedText = text.replace(
      /^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[ \t]*$|(`+)[^`\n][\s\S]*?\3|\\\$|\$\$([\s\S]+?)\$\$|\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$/gm,
      (all, ind, fence, tick, disp, inl) => {
        if (fence || tick) return all;
        if (all === '\\$') return '&#36;';
        math.push(disp !== undefined ? tex(disp.trim(), true) : tex(inl, false));
        return `@@SKM${math.length - 1}${disp !== undefined ? 'D' : 'I'}@@`;
      });
    let html = md.render(protectedText);
    html = html
      .replace(/<p>\s*@@SKM(\d+)D@@\s*<\/p>/g, (a, i) => `<div class="sk-math">${math[i]}</div>`)
      .replace(/@@SKM(\d+)[DI]@@/g, (a, i) => math[i])
      .replace(/<code[\s\S]*?<\/code>|\[\[tbd(?::\s*([^\]]*))?\]\]/g, (a, note) => {
        if (a.startsWith('<code')) return a;
        report.tbd(note || 'value');
        return `<span class="sk-tbd" title="${esc(note || 'pending')}">${esc(note || 'tbd')}</span>`;
      });
    return html;
  }

  function stepAttr(args) {
    return args.step !== undefined ? ` data-step="${esc(args.step === 'true' ? 'auto' : args.step)}"` : '';
  }

  function container(node, slide) {
    const inner = () => nodes(node.children, slide);
    const a = node.args;
    const cls = a.class ? ' ' + esc(a.class) : '';
    switch (node.name) {
      case 'notes':
        slide.notes.push(inner());
        return '';
      case 'col': {
        const w = a.w || a.width || a._[0] || 1;
        return `<div class="sk-col${cls}" style="flex:${esc(w)} 1 0"${stepAttr(a)}>${inner()}</div>`;
      }
      case 'step':
        return `<div class="sk-step-block${cls}" data-step="${esc(a._[0] || a.step || 'auto')}">${inner()}</div>`;
      case 'steps':
        return `<div class="sk-steps${cls}" data-mode="${esc(a._[0] || 'items')}"${a.start ? ` data-start="${esc(a.start)}"` : ''}>${inner()}</div>`;
      case 'figure': {
        const cap = a.caption ? `<figcaption>${markdown(a.caption).replace(/^<p>|<\/p>\s*$/g, '')}</figcaption>` : '';
        const style = a.height ? ` style="--fig-h:${esc(a.height)}"` : '';
        if (!a.src) return `<figure class="sk-figure${cls}"${style}${stepAttr(a)}>${inner()}${cap}</figure>`;
        return `<figure class="sk-figure${cls}"${style}${stepAttr(a)}><img src="${esc(a.src)}" alt="${esc(a.alt || a.caption || '')}" data-pending="${esc(node.children.join('\n').trim() || a.src)}">${cap}</figure>`;
      }
      case 'placeholder':
        report.tbd(node.argText || 'placeholder');
        return `<div class="sk-placeholder${cls}"${stepAttr(a)}><div class="sk-ph-tag">Pending</div><div class="sk-ph-title">${esc(a.title || node.argText)}</div>${inner()}</div>`;
      case 'frame':
        return `<div class="sk-frame${cls}"${stepAttr(a)}><iframe src="${esc(a.src)}" loading="lazy" title="${esc(a.title || 'embedded frame')}"></iframe></div>`;
      case 'missing':
        return `<div class="sk-missing">${inner()}</div>`;
      default: {
        // `::: small muted` -> classes sk-c-small sk-c-muted
        const extra = a._.map((c) => ` sk-c-${esc(c)}`).join('');
        return `<div class="sk-c sk-c-${esc(node.name)}${extra}${cls}"${stepAttr(a)}>${inner()}</div>`;
      }
    }
  }

  // Consecutive `::: col` siblings are wrapped in one flex row.
  function nodes(list, slide) {
    let html = '';
    let cols = null;
    const closeCols = () => {
      if (cols) html += `<div class="sk-cols"${slide.attrs.gap ? ` style="gap:${esc(slide.attrs.gap)}"` : ''}>${cols}</div>`;
      cols = null;
    };
    for (const n of list) {
      if (typeof n === 'string') {
        if (cols !== null && !n.trim()) continue;
        closeCols();
        html += markdown(n);
      } else if (n.name === 'col') {
        cols = (cols || '') + container(n, slide);
      } else {
        closeCols();
        html += container(n, slide);
      }
    }
    closeCols();
    return html;
  }

  function slide(src, index, inherited) {
    const { attrs, text } = readDirectives(src);
    const s = { attrs: { ...inherited, ...attrs }, notes: [], index };
    const layout = s.attrs.layout || 'default';
    const el = document.createElement('section');
    el.className = `sk-slide layout-${layout}${s.attrs.class ? ' ' + s.attrs.class : ''}`;
    el.dataset.index = index;
    if (s.attrs.id) el.id = s.attrs.id;
    const body = document.createElement('div');
    body.className = 'sk-body';
    body.innerHTML = nodes(parseContainers(text), s);
    if (layout !== 'title' && layout !== 'blank') {
      const first = body.firstElementChild;
      if (first && /^H[12]$/.test(first.tagName)) {
        const header = document.createElement('header');
        header.className = 'sk-header';
        header.appendChild(first);
        el.appendChild(header);
      }
    }
    el.appendChild(body);
    return { el, notes: s.notes.join('\n'), attrs: s.attrs, title: el.querySelector('.sk-header h1, .sk-header h2, h1, h2')?.textContent || `Slide ${index + 1}` };
  }

  return { slide, markdown, components, tex };
}

/** Assign step numbers. Call after components have mounted. */
export function indexSteps(slideEl) {
  for (const box of slideEl.querySelectorAll('.sk-steps')) {
    let targets;
    if (box.dataset.mode === 'rows') targets = box.querySelectorAll(':scope table tbody tr');
    else {
      const kids = [...box.children];
      const list = kids.length === 1 && /^(UL|OL)$/.test(kids[0].tagName) ? kids[0] : null;
      targets = list ? list.children : kids;
    }
    // `::: steps start=N` numbers its items N, N+1, ...; otherwise they are auto.
    let k = box.dataset.start ? +box.dataset.start : null;
    for (const t of targets) if (!t.dataset.step) t.dataset.step = k === null ? 'auto' : k++;
  }
  let counter = 0, total = 0;
  for (const el of slideEl.querySelectorAll('[data-step]')) {
    const v = el.dataset.step;
    let n;
    if (v === 'auto' || v === '') n = ++counter;
    else { n = parseInt(v, 10) || 0; counter = Math.max(counter, n); }
    el.dataset.step = n;
    total = Math.max(total, n);
  }
  // Legend entries and similar followers take their series' step.
  for (const el of slideEl.querySelectorAll('[data-step-follow]')) {
    const lead = slideEl.querySelector(`[data-key="${el.dataset.stepFollow}"]`);
    if (lead?.dataset.step) el.dataset.step = lead.dataset.step;
  }
  for (const el of slideEl.querySelectorAll('[data-hl]')) {
    const [a, b] = parseRange(el.dataset.hl);
    total = Math.max(total, a, Number.isFinite(b) ? b : a);
  }
  slideEl.dataset.steps = total;
  return total;
}

function parseRange(v) {
  const m = /^\s*(\d+)\s*(-)?\s*(\d+)?\s*$/.exec(v || '');
  if (!m) return [0, -1];
  const a = +m[1];
  return [a, m[3] ? +m[3] : m[2] ? Infinity : a];
}

export function applyStep(slideEl, step) {
  for (const el of slideEl.querySelectorAll('[data-step]')) {
    const n = +el.dataset.step;
    el.classList.toggle('sk-hidden', n > step);
    el.classList.toggle('sk-new', n === step && step > 0);
  }
  for (const el of slideEl.querySelectorAll('[data-hl]')) {
    const [a, b] = parseRange(el.dataset.hl);
    el.classList.toggle('sk-hl', step >= a && step <= b);
  }
}
