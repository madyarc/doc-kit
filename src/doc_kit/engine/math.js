// Math assets: LaTeX bodies shared between slides (KaTeX) and papers (the pack's .sty).
//
// A math asset is a .tex file holding one math body, no blank lines. With a pack
// prefix P (from pack.yaml `latex.prefix`), it may use:
//   \Pdefaults{k=v, ...}   defaults for parameters the caller did not set
//   \Pparam{k}             the value of parameter k
//   \Passet[k=v]{name}     another math asset (parameters are inherited)
// These are the same rules the generated P.sty implements in LaTeX.

/** Read `{...}` starting at text[i] === '{'; returns [content, indexAfter]. */
function braced(text, i) {
  if (text[i] !== '{') throw new Error(`expected "{" at ${i}`);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return [text.slice(i + 1, j), j + 1];
  }
  throw new Error('unbalanced braces');
}

function skipSpace(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** Remove TeX comments the way TeX does: `%` to end of line, including the newline. */
export function stripComments(tex) {
  return tex.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const m = /(^|[^\\])%/.exec(line);
    return m ? { text: line.slice(0, m.index + m[1].length), comment: true } : { text: line, comment: false };
  }).reduce((out, l) => out + l.text + (l.comment ? '' : ' '), '').trim();
}

/** `a=1, b={x, y}` -> {a: '1', b: 'x, y'} (commas inside braces are kept). */
export function parseKeyval(s) {
  const out = {};
  let depth = 0, cur = '';
  const flush = () => {
    if (!cur.trim()) return;
    const eq = cur.indexOf('=');
    const k = (eq < 0 ? cur : cur.slice(0, eq)).trim();
    let v = eq < 0 ? 'true' : cur.slice(eq + 1).trim();
    if (v.startsWith('{') && v.endsWith('}')) v = v.slice(1, -1);
    out[k] = v;
    cur = '';
  };
  for (const ch of s) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) flush();
    else cur += ch;
  }
  flush();
  return out;
}

/** Parse \newcommand / \renewcommand / \providecommand definitions into KaTeX macros. */
export function parseMacros(tex) {
  const src = stripComments(tex);
  const macros = {};
  const re = /\\(?:re)?(?:new|provide)command\*?\s*/g;
  let m;
  while ((m = re.exec(src))) {
    let i = skipSpace(src, re.lastIndex);
    let name;
    if (src[i] === '{') [name, i] = braced(src, i);
    else { const n = /^\\[A-Za-z]+/.exec(src.slice(i)); name = n[0]; i += name.length; }
    i = skipSpace(src, i);
    if (src[i] === '[') { i = src.indexOf(']', i) + 1; i = skipSpace(src, i); }
    if (src[i] === '[') throw new Error(`${name.trim()}: optional arguments are not supported by KaTeX`);
    const [body, end] = braced(src, i);
    macros[name.trim()] = body;
    re.lastIndex = end;
  }
  return macros;
}

/**
 * Expand a math asset to plain LaTeX math.
 * `load(name)` resolves an asset name to its .tex source.
 */
export async function expandMath(name, args, { prefix, load, inherited = {}, depth = 0 }) {
  if (depth > 8) throw new Error('math asset nesting deeper than 8 (cycle?)');
  const raw = await load(name);
  // A blank line is \par, which TeX rejects inside math.
  // Comment-only lines don't count: TeX drops them together with their newline.
  const lines = raw.split(/\r?\n/).filter((l) => !/^\s*%/.test(l)).map((l) => l.trim());
  const first = lines.findIndex(Boolean), lastLine = lines.findLastIndex(Boolean);
  if (first >= 0 && lines.slice(first, lastLine).some((l) => !l)) throw new Error(`${name}: blank line in a math asset`);
  let body = stripComments(raw);

  // \Pdefaults{...} only fills parameters nobody set.
  let defaults = {};
  const dRe = new RegExp(`\\\\${prefix}defaults\\s*`, 'g');
  let m;
  while ((m = dRe.exec(body))) {
    const [kv, end] = braced(body, skipSpace(body, dRe.lastIndex));
    defaults = { ...defaults, ...parseKeyval(kv) };
    body = body.slice(0, m.index) + body.slice(end);
    dRe.lastIndex = m.index;
  }
  const params = { ...defaults, ...inherited, ...args };

  body = body.replace(new RegExp(`\\\\${prefix}param\\s*\\{([^{}]*)\\}`, 'g'), (all, k) => {
    if (!(k.trim() in params)) throw new Error(`${name}: parameter "${k.trim()}" is not set and has no default`);
    return params[k.trim()];
  });

  // Nested \Passet[opts]{name}; names are plain text once parameters are substituted.
  const aRe = new RegExp(`\\\\${prefix}asset\\s*`, 'g');
  let out = '', last = 0;
  while ((m = aRe.exec(body))) {
    let i = skipSpace(body, aRe.lastIndex), opts = {};
    if (body[i] === '[') {
      const close = body.indexOf(']', i);
      opts = parseKeyval(body.slice(i + 1, close));
      i = skipSpace(body, close + 1);
    }
    const [child, end] = braced(body, i);
    out += body.slice(last, m.index) + (await expandMath(child.trim(), opts, { prefix, load, inherited: params, depth: depth + 1 }));
    last = end;
    aRe.lastIndex = end;
  }
  return (out + body.slice(last)).trim();
}
