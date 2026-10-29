// Source handling: front matter, asset expansion, slide splitting, slide
// directives and ::: containers. Pure text in, plain objects out; no DOM.

const FENCE = /^\s*(`{3,}|~{3,})/;

/** Split a leading `---` YAML block off a document. */
export function splitFrontMatter(text) {
  text = text.replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  return { meta: jsyaml.load(m[1]) || {}, body: text.slice(m[0].length) };
}

/** Parse `key=value key="quoted value" flag` into an object. */
export function parseArgs(s) {
  const out = {};
  const positional = [];
  const re = /([\w.-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) {
    if (m[1]) out[m[1]] = m[2] ?? m[3] ?? m[4];
    else positional.push(m[5] ?? m[6]);
  }
  out._ = positional;
  return out;
}

/** Replace {{name}} and {{name|fallback}} with params. */
function substitute(text, params) {
  return text.replace(/\{\{\s*([\w.-]+)\s*(?:\|([^}]*))?\}\}/g, (all, key, dflt) =>
    params[key] !== undefined ? String(params[key]) : dflt !== undefined ? dflt.trim() : all);
}

/** Pull the body of `::: part NAME` out of an asset (nesting-aware). */
function extractPart(text, name) {
  const lines = text.split('\n');
  let depth = 0, start = -1, inFence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) { inFence = inFence ? (line.trim().startsWith(inFence) ? null : inFence) : f[1]; continue; }
    if (inFence) continue;
    const open = /^:::\s*([\w-]+)(.*)$/.exec(line);
    if (open) {
      if (start < 0 && open[1] === 'part' && parseArgs(open[2])._[0] === name) { start = i + 1; depth = 1; continue; }
      if (start >= 0) depth++;
    } else if (/^:::\s*$/.test(line) && start >= 0 && --depth === 0) {
      return lines.slice(start, i).join('\n');
    }
  }
  return null;
}

/** Drop `::: part` wrapper lines, keeping their contents. */
function unwrapParts(text) {
  const lines = text.split('\n'), out = [], stack = [];
  let inFence = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f) { inFence = inFence ? (line.trim().startsWith(inFence) ? null : inFence) : f[1]; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    const open = /^:::\s*([\w-]+)/.exec(line);
    if (open) { stack.push(open[1] === 'part'); if (open[1] !== 'part') out.push(line); continue; }
    if (/^:::\s*$/.test(line)) { if (!stack.pop()) out.push(line); continue; }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Expand `::: use name k=v ...` lines (self-closing) recursively.
 * `resolve(name)` returns { url, text, kind } or throws; kind 'tex' is a math
 * asset, expanded by `ctx.math(asset, params)` and shown as display math
 * (inline math with the `inline` flag).
 */
export async function expandUses(text, resolve, ctx, depth = 0) {
  if (depth > 8) throw new Error('asset nesting deeper than 8 (cycle?)');
  const lines = text.split('\n');
  const out = [];
  let inFence = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f) inFence = inFence ? (line.trim().startsWith(inFence) ? null : inFence) : f[1];
    const m = !inFence && /^([ \t]*):::\s*use\s+(\S+)(.*)$/.exec(line);
    if (!m) { out.push(line); continue; }
    // An indented `use` (e.g. inside a list item) indents everything it inserts.
    const [, indent, name, rest] = m;
    const args = parseArgs(rest);
    try {
      const asset = await resolve(name);
      if (asset.kind === 'tex') {
        const { _, inline, ...mathArgs } = args;
        const tex = await ctx.math(asset, mathArgs);
        const block = _.includes('inline') || inline ? `$${tex}$` : `$$\n${tex}\n$$`;
        out.push(block.replace(/^(?=.)/gm, indent));
        continue;
      }
      const { meta, body } = splitFrontMatter(asset.text);
      const params = { ...(meta.params || {}), ...ctx.deckParams, ...args };
      delete params._;
      let content = substitute(body, params);
      if (args.part) {
        const part = extractPart(content, args.part);
        if (part === null) throw new Error(`asset "${name}" has no part "${args.part}"`);
        content = part;
      }
      content = unwrapParts(content);
      const text = rebase(await expandUses(content, resolve, ctx, depth + 1), asset.url, ctx.deckUrl);
      out.push(text.replace(/^(?=.)/gm, indent));
    } catch (err) {
      ctx.errors.push(`use ${name}: ${err.message}`);
      out.push(`::: missing\n**Missing asset** \`${name}\`: ${err.message}\n:::`);
    }
  }
  return out.join('\n');
}

/** Rewrite relative src=/![]() paths inside an asset so they resolve against the asset file. */
function rebase(text, assetUrl, deckUrl) {
  const fix = (p) => {
    if (/^([a-z]+:|\/|#|data:)/i.test(p)) return p;
    return relativeTo(new URL(p, assetUrl).href, deckUrl);
  };
  return text
    .replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (a, pre, p) => pre + fix(p))
    .replace(/(^:::.*\bsrc=)("?)([^"\s]+)/gm, (a, pre, q, p) => pre + q + fix(p))
    .replace(/(^\s*(?:`{3,}|~{3,})\s*\w+.*\bsrc=)("?)([^"\s]+)/gm, (a, pre, q, p) => pre + q + fix(p));
}

function relativeTo(target, base) {
  const t = new URL(target), b = new URL(base);
  if (t.origin !== b.origin) return target;
  const tp = t.pathname.split('/'), bp = b.pathname.split('/').slice(0, -1);
  let i = 0;
  while (i < tp.length - 1 && i < bp.length && tp[i] === bp[i]) i++;
  return '../'.repeat(bp.length - i) + tp.slice(i).join('/');
}

/** Split a deck body on lines that are exactly `---` (outside fences and $$ blocks). */
export function splitSlides(body) {
  const slides = [];
  let cur = [], inFence = null, inMath = false;
  for (const line of body.split('\n')) {
    const f = FENCE.exec(line);
    if (f) inFence = inFence ? (line.trim().startsWith(inFence) ? null : inFence) : f[1];
    if (!inFence) {
      const n = (line.match(/\$\$/g) || []).length;
      if (n % 2 === 1) inMath = !inMath;
    }
    if (!inFence && !inMath && /^---\s*$/.test(line)) { slides.push(cur.join('\n')); cur = []; continue; }
    cur.push(line);
  }
  slides.push(cur.join('\n'));
  return slides.filter((s) => s.replace(/<!--[\s\S]*?-->/g, (c) => (/^<!--\s*slide\b/.test(c) ? 'x' : '')).trim());
}

/** Read `<!-- slide k=v -->` directives and strip all other HTML comments. */
export function readDirectives(text) {
  const attrs = {};
  text = text.replace(/<!--([\s\S]*?)-->/g, (all, inner) => {
    const m = /^\s*slide\b([\s\S]*)$/.exec(inner);
    if (m) Object.assign(attrs, parseArgs(m[1].trim()));
    return '';
  });
  delete attrs._;
  return { attrs, text };
}

/**
 * Parse `::: name args` ... `:::` containers into a tree:
 * [ string | { name, args, argText, children } ]
 */
export function parseContainers(text) {
  const root = { children: [] };
  const stack = [root];
  let buf = [], inFence = null;
  const flush = () => { if (buf.length) stack.at(-1).children.push(buf.join('\n')); buf = []; };
  for (const line of text.split('\n')) {
    const f = FENCE.exec(line);
    if (f) inFence = inFence ? (line.trim().startsWith(inFence) ? null : inFence) : f[1];
    if (!inFence) {
      const open = /^:::\s*([\w-]+)\s*(.*)$/.exec(line);
      if (open) {
        flush();
        const node = { name: open[1], argText: open[2], args: parseArgs(open[2]), children: [] };
        stack.at(-1).children.push(node);
        stack.push(node);
        continue;
      }
      if (/^:::\s*$/.test(line) && stack.length > 1) { flush(); stack.pop(); continue; }
    }
    buf.push(line);
  }
  flush();
  return root.children;
}
