// solve.js — a fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input, byte for byte. It is written from the
// reference semantics (front matter, template dialect, Markdown subset,
// slug rule, build report) as a single optimised pass: run-based HTML
// escaping, range-based inline rendering with no substring copies, a
// manual front-matter scanner, a memoised slugifier and a template
// interpreter that renders into one output array. No vendor code is
// copied. Nothing is kept from one case to the next: the per-run caches
// are rebuilt at the start of every run().

/* ------------------------------------------------------------------ text */

// Per-run caches (rebuilt at the start of every run).
let slugCache;
let dateCache;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** HTML escape entities, by character code. */
const ENT = [];
ENT[34] = '&quot;';
ENT[38] = '&amp;';
ENT[39] = '&#39;';
ENT[60] = '&lt;';
ENT[62] = '&gt;';

/** Whether a character code is JavaScript whitespace (what /\s/ and /\S+/ mean). */
const WS = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS[c] = 1;

/** HTML-escape a whole string; returns the string itself when nothing needs escaping. */
const ESC_TEST = /[&<>"']/;
function escStr(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** HTML-escape s[a..b) into out[]. */
function escInto(s, a, b, out) {
  let i = a;
  while (i < b) {
    let j = i;
    while (j < b && ENT[s.charCodeAt(j)] === undefined) j++;
    if (j >= b) {
      if (b > i) out.push(s.slice(i, b));
      return;
    }
    if (j > i) out.push(s.slice(i, j));
    out.push(ENT[s.charCodeAt(j)]);
    i = j + 1;
  }
}

const MARK_RE = /\p{M}/gu;

/** The slug of `text` (README.md, "Text"). Pure ASCII skips normalisation: NFKD is the identity there. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(MARK_RE, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if (c >= 97 && c <= 122) keep = c;
    else if (c >= 48 && c <= 57) keep = c;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end < out.length) out = out.slice(0, end);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  do {
    out = slug + '-' + n;
    n++;
  } while (taken.has(out));
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const out = Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
  dateCache.set(date, out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/* ------------------------------------------------------------ front matter */

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringValue(key, raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: `key "${key}": a quoted string is not closed` };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        if (i + 1 === raw.length - 1) return { error: `key "${key}": a quoted string holds an escape other than \\" or \\` };
        const n = raw[i + 1];
        if (n !== '"' && n !== '\\') return { error: `key "${key}": a quoted string holds an escape other than \\" or \\` };
        out += n;
        i++;
      } else if (c === '"') return { error: `key "${key}": a quoted string holds a stray quote` };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

/** A date value: YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31. */
function dateValue(raw) {
  let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
  if (ok) {
    for (let i = 0; i < 10; i++) {
      if (i === 4 || i === 7) continue;
      if (!isDigit(raw.charCodeAt(i))) {
        ok = false;
        break;
      }
    }
  }
  const y = ok ? Number(raw.slice(0, 4)) : 0;
  const mo = ok ? Number(raw.slice(5, 7)) : 0;
  const d = ok ? Number(raw.slice(8, 10)) : 0;
  if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
    return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  return { value: raw };
}

/** A tags value: [a, b, c], each name trimmed, none empty or holding " [ or ]. */
function tagsValue(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const tags = [];
  for (const p of inner.split(',')) {
    const t = p.trim();
    if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    tags.push(t);
  }
  return { value: tags };
}

/** A template name: a-z, 0-9 and -. */
function isName(s) {
  if (s === '') return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** A slug: a-z and 0-9, single - between, at most 64 characters. */
function isSlug(s) {
  if (s === '' || s.length > 64) return false;
  const n = s.length;
  let i = 0;
  for (;;) {
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
      else break;
    }
    if (j === i) return false;
    if (j === n) return true;
    if (s.charCodeAt(j) !== 45) return false;
    i = j + 1;
    if (i === n) return false;
  }
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return stringValue(key, raw);
    case 'date':
      return dateValue(raw);
    case 'tags':
      return tagsValue(raw);
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether a line is blank (spaces and tabs only). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  if ((nl0 === -1 ? text : text.slice(0, nl0)) !== '---') return { error: 'no front matter' };
  if (nl0 === -1) return { error: 'the front matter is not closed' };
  // Scan for the closing line; line numbers count from 1 at the opening '---'.
  let pos = nl0 + 1;
  let lineNo = 1;
  let closeEnd = -1;
  const fmLines = [];
  while (pos <= text.length) {
    lineNo++;
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = text.length;
    const line = text.slice(pos, eol);
    if (line === '---') {
      closeEnd = eol;
      break;
    }
    fmLines.push(line);
    pos = eol + 1;
    if (eol === text.length) break;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    const n = k + 2;
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || j >= line.length || line.charCodeAt(j) !== 58) return { error: `line ${n} is not "key: value"` };
    const key = line.slice(0, j);
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: `line ${n} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e < raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

/* ---------------------------------------------------------------- Markdown */

// The characters a backslash escapes, and the characters that end a plain run of inline text.
const ESCAPABLE = new Uint8Array(128);
const SPECIAL = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;
for (const c of [92, 96, 42, 91, 38, 60, 62, 34, 39]) SPECIAL[c] = 1;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s[a..b)` rendered inline into out[]; `link(target)` is a link's href. */
function inlineInto(s, a, b, link, out) {
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < b && ESCAPABLE[s.charCodeAt(i + 1)] === 1) {
        out.push(s[i + 1]);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        out.push('<code>');
        escInto(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          out.push('<strong>');
          inlineInto(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        out.push('<em>');
        inlineInto(s, i + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      let target = '';
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        m = s.indexOf(')', k + 2);
        if (m === -1 || m >= b) m = -1;
        else target = s.slice(k + 2, m);
      }
      if (m !== -1 && target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        out.push(escStr(link(target)));
        out.push('">');
        inlineInto(s, i + 1, k, link, out);
        out.push('</a>');
        i = m + 1;
      } else {
        out.push('[');
        i++;
      }
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      out.push(ENT[c]);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < b) {
      const d = s.charCodeAt(j);
      if (d < 128 && SPECIAL[d] === 1) break;
      j++;
    }
    out.push(s.slice(i, j));
    i = j;
  }
}

/** A fence-open line's language, or null when the line is not one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether a line closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let i = n;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let e = line.length;
  while (e > i && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === i) return null;
  return { depth: n, text: line.slice(i, e) };
}

/** Whether a line is a thematic break: --- or ***, then spaces or tabs only. */
function isHR(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const cc = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && cc === 45) || (a === 42 && b === 42 && cc === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/** A list's first line: { ordered, start, text }, or null when the line starts no list. */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i >= 1 && i <= 9 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
    return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
  }
  return null;
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && WS[line.charCodeAt(i)] !== 1;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents and its excerpt (the first paragraph's
 * inline HTML, or "").
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      parts.push('<pre><code' + (lang === '' ? '' : ' class="language-' + escStr(lang) + '"') + '>');
      for (const l of body) {
        escInto(l, 0, l.length, parts);
        parts.push('\n');
      }
      parts.push('</code></pre>\n');
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text), ids);
      const out = [];
      inlineInto(h.text, 0, h.text.length, link, out);
      const html = out.join('');
      parts.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>\n');
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }    if (isHR(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = kept.join('\n');
        parts.push('<blockquote>\n<p>');
        inlineInto(joined, 0, joined.length, link, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const ls = listStart(line);
    if (ls !== null) {
      const ordered = ls.ordered;
      const items = [[trimLine(ls.text)]];
      i++;
      while (i < n) {
        const m = listStart(lines[i]);
        if (m !== null && m.ordered === ordered) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      parts.push(ordered && ls.start !== 1 ? '<ol start="' + ls.start + '">\n' : '<' + tag + '>\n');
      for (const item of items) {
        const joined = item.join('\n');
        parts.push('<li>');
        inlineInto(joined, 0, joined.length, link, parts);
        parts.push('</li>\n');
      }
      parts.push('</' + tag + '>\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const joined = body.join('\n');
    if (excerpt === null) {
      const out = [];
      inlineInto(joined, 0, joined.length, link, out);
      excerpt = out.join('');
      parts.push('<p>' + excerpt + '</p>\n');
    } else {
      parts.push('<p>');
      inlineInto(joined, 0, joined.length, link, parts);
      parts.push('</p>\n');
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

/* ---------------------------------------------------------------- Templates */

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether s[a..b) holds only spaces and tabs. */
function allSpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = allSpaceTab(src, lineStart, open) && allSpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include.

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ node: null, body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') {
      body.push({ k: 0, t: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ k: tok.t === 'var' ? 1 : 2, p: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 4, name: m[1], p: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push({ node, body: node.body });
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 3, not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push({ node, body: node.then });
      body = node.then;
    } else if (tag === 'else') {
      if (top.node === null || top.node.k !== 3 || top.node.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.node.els = [];
      top.body = top.node.els;
      body = top.node.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.node === null || top.node.k !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      body = stack[stack.length - 1].body;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ k: 5, name: m[1] });
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    throw new TemplateError(`template "${name}": a ${top.node.k === 4 ? 'for' : 'if'} is not closed`);
  }
  return root;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k !== 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The path ["p"], for the card cache's lookup of the card being rendered. */
const CARD_P = ['p'];

/**
 * Whether rendering `name`'s template depends only on `p` (the card being
 * rendered) and on loop variables bound inside the template itself: every
 * path's first name must be `p`, a name bound by an enclosing for in the
 * template, or `loop` inside a for body. A template that passes can have
 * its render for one card reused wherever that card is shown.
 */
function cardCacheable(templates, name, seen, depth) {
  const nodes = templates.get(name);
  if (nodes === undefined) return true;
  if (seen.has(name) || depth > 6) return false;
  seen.add(name);
  const ok = nodesCacheable(nodes, new Set(), false, templates, seen, depth);
  seen.delete(name);
  return ok;
}

function nodesCacheable(nodes, bound, inFor, templates, seen, depth) {
  for (const nd of nodes) {
    if (nd.k === 0) continue;
    if (nd.k === 5) {
      if (!cardCacheable(templates, nd.name, seen, depth + 1)) return false;
      continue;
    }
    const first = nd.p[0];
    if (first !== 'p' && !bound.has(first) && !(inFor && first === 'loop')) return false;
    if (nd.k === 3) {
      if (!nodesCacheable(nd.then, bound, inFor, templates, seen, depth)) return false;
      if (nd.els !== null && !nodesCacheable(nd.els, bound, inFor, templates, seen, depth)) return false;
    } else if (nd.k === 4) {
      const b2 = new Set(bound);
      b2.add(nd.name);
      if (!nodesCacheable(nd.body, b2, true, templates, seen, depth)) return false;
    }
  }
  return true;
}

/** `nodes` rendered in `scope` ({ vars, parent }) into out[]; `ctx` holds the parsed templates. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const nd = nodes[n];
    switch (nd.k) {
      case 0:
        out.push(nd.t);
        break;
      case 1:
        out.push(escStr(textOf(lookup(scope, nd.p))));
        break;
      case 2:
        out.push(textOf(lookup(scope, nd.p)));
        break;
      case 3: {
        const v = truthy(lookup(scope, nd.p));
        const br = v !== nd.not ? nd.then : nd.els;
        if (br !== null) renderNodes(br, scope, ctx, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(scope, nd.p);
        if (!Array.isArray(xs)) break;
        // One scope per activation, its vars mutated per iteration (the body
        // only reads them during that iteration). `loop` wins over an element
        // bound to the name "loop", as the reference's fresh object does.
        const vars = { [nd.name]: undefined, loop: { index: 0, first: false, last: false, length: xs.length } };
        const child = { vars, parent: scope };
        const loop = vars.loop;
        for (let k = 0; k < xs.length; k++) {
          if (nd.name !== 'loop') vars[nd.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(nd.body, child, ctx, depth, out);
        }
        break;
      }
      case 5: {
        if (nd.name === 'card' && depth === 0 && ctx.cardCache !== null) {
          const pv = lookup(scope, CARD_P);
          if (pv !== undefined) {
            const hit = ctx.cardCache.get(pv);
            if (hit !== undefined) {
              out.push(hit);
              break;
            }
          }
        }
        const t = ctx.templates.get(nd.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/* --------------------------------------------------------------------- build */

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  if (s.card === undefined) s.card = cardOf(s);
  const c = s.card;
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A tag as templates read it (its posts as cards). */
function tagOf(t) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  dateCache = new Map();

  // Templates, parsed in code-unit order of their name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => (y.data.date < x.data.date ? -1 : y.data.date > x.data.date ? 1 : x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  for (const p of posts) p.card = cardOf(p);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates, cardCache: null };
  // A card's HTML depends only on its post (verified against the parsed
  // templates above), so render each post's card once and reuse it on every
  // index and tag page that shows it.
  const cardNodes = templates.get('card');
  if (cardNodes !== undefined && cardCacheable(templates, 'card', new Set(), 0)) {
    const cache = new Map();
    for (const p of posts) {
      const out = [];
      renderNodes(cardNodes, { vars: { p: p.card }, parent: rootScope }, ctx, 1, out);
      cache.set(p.card, out.join(''));
    }
    ctx.cardCache = cache;
  }
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: rootScope }, ctx, 0, out);
    return out.join('');
  };
  const output = Object.create(null);
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort();
  const npages = kept.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
