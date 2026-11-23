// Frost Site Sprint v2: a fast drop-in for makefun-site 1.0.0.
//
// Written from the kit's README.md spec and the reference program's observable
// behaviour. Single pass wherever the reference takes two: the Markdown scan
// never splits the body into lines, the template renderer walks a flat
// instruction list with pre-resolved scopes, and every card, tag record and
// link resolution is built once and shared. No third-party code, no imports.

// ------------------------------------------------------------------ text

const ESC_TABLE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

function escRepl(c) {
  return ESC_TABLE[c];
}

/** `s` with the five HTML characters escaped. Most strings need no work. */
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, escRepl);
}

const NOT_ASCII = /[^\x00-\x7f]/;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;
const EDGE_DASH = /^-+|-+$/g;
const TRAIL_DASH = /-+$/;
const MARKS = /\p{M}/gu;

/** The slug of `s`, exactly as the reference defines it. */
function slugifyRaw(s) {
  if (!NOT_ASCII.test(s)) {
    // Pure ASCII: NFKD is the identity and there are no combining marks, so
    // the slug is lowercase, non-alphanumeric runs folded to one dash, no
    // dash at either end, cut to 64 with a dash left at the cut dropped.
    let out = s.toLowerCase().replace(NON_ALNUM_RUN, '-').replace(EDGE_DASH, '');
    out = out.slice(0, 64).replace(TRAIL_DASH, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = s.normalize('NFKD').replace(MARKS, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = '';
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === '') {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(TRAIL_DASH, '');
  return out === '' ? 'untitled' : out;
}

// Slugs and long dates are pure functions of their input, so they are safe
// to keep across the cases of one process.
const slugCache = new Map();
function slugify(s) {
  let v = slugCache.get(s);
  if (v === undefined) {
    v = slugifyRaw(s);
    slugCache.set(s, v);
  }
  return v;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = `${slug}-${n}`;
  while (taken.has(out)) {
    n++;
    out = `${slug}-${n}`;
  }
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(d) {
  let v = dateCache.get(d);
  if (v === undefined) {
    const y = d.slice(0, 4);
    const m = Number(d.slice(5, 7));
    const day = Number(d.slice(8, 10));
    v = `${day} ${MONTHS[m - 1]} ${y}`;
    dateCache.set(d, v);
  }
  return v;
}

// The whitespace of JavaScript's \s (White_Space + LineTerminator), as a
// 64K table, so word counting is a plain loop with no allocation.
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 133, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;

/** The words of `text`: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 0) {
      if (!inWord) {
        n++;
        inWord = true;
      }
    } else inWord = false;
  }
  return n;
}

// ------------------------------------------------------------ front matter

const KNOWN_KEYS = { title: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1, summary: 1 };

function isLowerKeyChar(c) {
  return (c >= 'a' && c <= 'z') || c === '_';
}

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= '0' && c <= '9';
}

/** A quoted or bare string value, or its refusal reason. */
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. The error carries the key's name. */
function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw[i])) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t[j];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw[i];
        if (c === '-') {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body, or its refusal reason. Lines are scanned
 * by index, never split: the body is the slice after the closing fence.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? text.length : firstNl;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  const data = {};
  let pos = firstEnd + 1;
  let lineNo = 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: nl === -1 ? '' : text.slice(end + 1) };
    }
    if (line.length > 0 && line.charCodeAt(0) !== 35) {
      let blank = true;
      for (let i = 0; i < line.length; i++) {
        const c = line.charCodeAt(i);
        if (c !== 32 && c !== 9) { blank = false; break; }
      }
      if (!blank) {
        // `key: value`: a key of a-z and _, a colon, one space and the value.
        let k = 0;
        while (k < line.length && isLowerKeyChar(line[k])) k++;
        if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
          return { error: `line ${lineNo + 1} is not "key: value"` };
        }
        const key = line.slice(0, k);
        let raw;
        if (k + 1 === line.length) raw = '';
        else if (line.charCodeAt(k + 1) === 32) {
          raw = line.slice(k + 2);
          let e = raw.length;
          while (e > 0) {
            const c = raw.charCodeAt(e - 1);
            if (c !== 32 && c !== 9) break;
            e--;
          }
          raw = raw.slice(0, e);
        } else {
          return { error: `line ${lineNo + 1} is not "key: value"` };
        }
        if (KNOWN_KEYS[key] === undefined) return { error: `unknown key "${key}"` };
        if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
        if (raw === '') return { error: `key "${key}" has no value` };
        const v = keyValue(key, raw);
        if ('error' in v) return v;
        data[key] = v.value;
      }
    }
    if (nl === -1) break;
    pos = end + 1;
    lineNo++;
  }
  return { error: 'the front matter is not closed' };
}

// ---------------------------------------------------------------- markdown

const SPECIAL_RE = /[\\`*&<>"'\[]/g;
const HAS_WS = /\s/;
const ESCAPABLE_CHARS = '\\`*_[]()#+-.!>';

function isEscapableChar(c) {
  return ESCAPABLE_CHARS.indexOf(c) !== -1;
}

/** The first unescaped `**` at or after `from` (both stars inside the range), or -1. */
function findDoubleStar(s, from, end) {
  const j = s.indexOf('**', from);
  if (j === -1 || j + 1 >= end) return -1;
  if (j > from && s.charCodeAt(j - 1) === 92) {
    for (let k = from; k + 1 < end; k++) {
      if (s.charCodeAt(k) === 92 && k + 1 < end && isEscapableChar(s[k + 1])) { k++; continue; }
      if (s.charCodeAt(k) === 42 && s.charCodeAt(k + 1) === 42) return k;
    }
    return -1;
  }
  return j;
}

/** The first single `*` at or after `from` (one whose run is not `**`), or -1. */
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    if (j > from && s.charCodeAt(j - 1) === 92) {
      for (let k = from; k < end; k++) {
        const c = s.charCodeAt(k);
        if (c === 92 && k + 1 < end && isEscapableChar(s[k + 1])) { k++; continue; }
        if (c !== 42) continue;
        if (k + 1 < end && s.charCodeAt(k + 1) === 42) { k++; continue; }
        return k;
      }
      return -1;
    }
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The first unescaped `]` at or after `from`, or -1. */
function findCloseBracket(s, from, end) {
  const j = s.indexOf(']', from);
  if (j === -1 || j >= end) return -1;
  if (j > from && s.charCodeAt(j - 1) === 92) {
    for (let k = from; k < end; k++) {
      if (s.charCodeAt(k) === 92 && k + 1 < end && isEscapableChar(s[k + 1])) { k++; continue; }
      if (s.charCodeAt(k) === 93) return k;
    }
    return -1;
  }
  return j;
}

/**
 * `s[start..end)` rendered inline into `out`. One scan finds both the
 * inline constructs and the characters HTML escapes, so a plain run between
 * two stops needs no escaping call at all; strong, emphasis and links
 * recurse on ranges, never on sliced copies.
 */
function inlineInto(out, s, start, end, linkFn) {
  let i = start;
  SPECIAL_RE.lastIndex = start;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null && m.index < end) {
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s.charCodeAt(j);
    if (c === 38) {
      out.push('&amp;');
      i = j + 1;
    } else if (c === 60) {
      out.push('&lt;');
      i = j + 1;
    } else if (c === 62) {
      out.push('&gt;');
      i = j + 1;
    } else if (c === 34) {
      out.push('&quot;');
      i = j + 1;
    } else if (c === 39) {
      out.push('&#39;');
      i = j + 1;
    } else if (c === 92) {
      if (j + 1 < end && isEscapableChar(s[j + 1])) {
        // Of the escapable characters only '>' is HTML-escaped.
        out.push(s[j + 1] === '>' ? '&gt;' : s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < end && k > j + 1) {
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === 42) {
      if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
        const k = findDoubleStar(s, j + 2, end);
        if (k !== -1 && k > j + 2) {
          out.push('<strong>');
          inlineInto(out, s, j + 2, k, linkFn);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1, end);
        if (k !== -1 && k > j + 1) {
          out.push('<em>');
          inlineInto(out, s, j + 1, k, linkFn);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else {
      const k = findCloseBracket(s, j + 1, end);
      let closeParen = -1;
      let target = null;
      if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) {
        const p = s.indexOf(')', k + 2);
        if (p !== -1 && p < end) {
          const t = s.slice(k + 2, p);
          if (t !== '' && !HAS_WS.test(t)) {
            target = t;
            closeParen = p;
          }
        }
      }
      if (target !== null) {
        out.push('<a href="', esc(linkFn(target)), '">');
        inlineInto(out, s, j + 1, k, linkFn);
        out.push('</a>');
        i = closeParen + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    }
    SPECIAL_RE.lastIndex = i;
  }
  // The tail holds no inline construct and no HTML character: the scan
  // would have stopped at either.
  if (i < end) out.push(s.slice(i, end));
}

// --- line classification on ranges (no slicing) ---

function lineIsBlank(s, pos, end) {
  for (let i = pos; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** The end of the language if [pos, end) opens a fence, else -1. */
function fenceOpenLang(s, pos, end) {
  if (pos + 2 >= end || s.charCodeAt(pos) !== 96 || s.charCodeAt(pos + 1) !== 96 || s.charCodeAt(pos + 2) !== 96) return -1;
  let j = pos + 3;
  while (j < end && isLangChar(s.charCodeAt(j))) j++;
  const langEnd = j;
  while (j < end && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  return j === end ? langEnd : -1;
}

function isFenceClose(s, pos, end) {
  if (pos + 2 >= end || s.charCodeAt(pos) !== 96 || s.charCodeAt(pos + 1) !== 96 || s.charCodeAt(pos + 2) !== 96) return false;
  for (let j = pos + 3; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** [level, textStart, textEnd] if [pos, end) is a heading, else null. */
function headingParts(s, pos, end) {
  let j = pos;
  while (j < end && s.charCodeAt(j) === 35) j++;
  const level = j - pos;
  if (level === 0 || level > 6) return null;
  if (j >= end || (s.charCodeAt(j) !== 32 && s.charCodeAt(j) !== 9)) return null;
  let t = j;
  while (t < end && (s.charCodeAt(t) === 32 || s.charCodeAt(t) === 9)) t++;
  let e = end;
  while (e > t && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
  if (t >= e) return null;
  return [level, t, e];
}

function isHr(s, pos, end) {
  if (end - pos < 3) return false;
  const c = s.charCodeAt(pos);
  if (c !== 45 && c !== 42) return false;
  if (s.charCodeAt(pos + 1) !== c || s.charCodeAt(pos + 2) !== c) return false;
  for (let j = pos + 3; j < end; j++) {
    const d = s.charCodeAt(j);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** [ordered, startNumber, contentStart] if [pos, end) opens a list item, else null. */
function listMarker(s, pos, end) {
  const c = s.charCodeAt(pos);
  if ((c === 45 || c === 42) && pos + 1 < end && s.charCodeAt(pos + 1) === 32) return [false, 1, pos + 2];
  if (c >= 48 && c <= 57) {
    let j = pos;
    while (j < end && j - pos < 9 && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    if (j > pos && j + 1 < end && s.charCodeAt(j) === 46 && s.charCodeAt(j + 1) === 32) {
      return [true, Number(s.slice(pos, j)), j + 2];
    }
  }
  return null;
}

/** Whether [pos, end) continues a list item: two or more spaces, then a non-space. */
function isContinued(s, pos, end) {
  if (pos + 1 >= end || s.charCodeAt(pos) !== 32 || s.charCodeAt(pos + 1) !== 32) return false;
  let j = pos + 2;
  while (j < end && s.charCodeAt(j) === 32) j++;
  return j < end && !/\s/.test(s[j]);
}

/** [start, end) of [pos, end) trimmed of spaces and tabs at both ends. */
function trimRange(s, pos, end) {
  let a = pos;
  while (a < end && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  let b = end;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return [a, b];
}

/** Whether the line [pos, end) ends a paragraph: blank, a fence, a heading or a break. */
function paraEnds(s, pos, end) {
  if (end === pos) return true;
  const c = s.charCodeAt(pos);
  if (c === 32 || c === 9) return lineIsBlank(s, pos, end);
  if (c === 96) return fenceOpenLang(s, pos, end) !== -1;
  if (c === 35) return headingParts(s, pos, end) !== null;
  if (c === 45 || c === 42) return isHr(s, pos, end);
  return false;
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of
 * contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or ""). The body is scanned by line boundaries;
 * no line array and no block tokens are ever built.
 */
function renderMarkdown(src, linkFn) {
  const ids = new Set();
  const toc = [];
  const out = [];
  let excerpt = '';
  let haveExcerpt = false;
  const len = src.length;
  let pos = 0;
  while (pos < len) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    const next = nl === -1 ? len : nl + 1;
    if (end === pos) {
      pos = next;
      continue;
    }
    const c0 = src.charCodeAt(pos);
    if ((c0 === 32 || c0 === 9) && lineIsBlank(src, pos, end)) {
      pos = next;
      continue;
    }
    if (c0 === 96) {
      const langEnd = fenceOpenLang(src, pos, end);
      if (langEnd !== -1) {
        const lang = src.slice(pos + 3, langEnd);
        let bodyStart = next;
        let bodyEnd = next;
        let count = 0;
        let p = next;
        let closed = false;
        while (p < len) {
          const nl2 = src.indexOf('\n', p);
          const end2 = nl2 === -1 ? len : nl2;
          if (isFenceClose(src, p, end2)) {
            pos = nl2 === -1 ? len : nl2 + 1;
            closed = true;
            break;
          }
          bodyEnd = end2;
          count++;
          p = nl2 === -1 ? len : nl2 + 1;
        }
        if (!closed) pos = len;
        out.push('<pre><code');
        // A language holds only [A-Za-z0-9_+-], none of which is escaped.
        if (lang !== '') out.push(' class="language-', lang, '">');
        else out.push('>');
        if (count > 0) out.push(esc(src.slice(bodyStart, bodyEnd)), '\n');
        out.push('</code></pre>\n');
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingParts(src, pos, end);
      if (h !== null) {
        const level = h[0];
        const text = src.slice(h[1], h[2]);
        const id = uniqueSlug(slugify(text), ids);
        out.push(`<h${level} id="${id}">`);
        const mark = out.length;
        inlineInto(out, text, 0, text.length, linkFn);
        if (level === 2 || level === 3) toc.push({ level, id, html: out.slice(mark).join('') });
        out.push(`</h${level}>\n`);
        pos = next;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && isHr(src, pos, end)) {
      out.push('<hr>\n');
      pos = next;
      continue;
    }
    if (c0 === 62) {
      const parts = [];
      let p = pos;
      while (p < len) {
        const nl2 = src.indexOf('\n', p);
        const end2 = nl2 === -1 ? len : nl2;
        if (src.charCodeAt(p) !== 62) break;
        let a = p + 1;
        if (a < end2 && src.charCodeAt(a) === 32) a++;
        const t = trimRange(src, a, end2);
        if (t[0] < t[1]) parts.push(src.slice(t[0], t[1]));
        p = nl2 === -1 ? len : nl2 + 1;
        if (nl2 === -1) break;
      }
      pos = p;
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = parts.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(out, joined, 0, joined.length, linkFn);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const marker = (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) ? listMarker(src, pos, end) : null;
    if (marker !== null) {
      const ordered = marker[0];
      const startNum = marker[1];
      const items = [];
      let p = pos;
      let cur = null;
      while (p < len) {
        const nl2 = src.indexOf('\n', p);
        const end2 = nl2 === -1 ? len : nl2;
        const c2 = src.charCodeAt(p);
        const m2 = (c2 === 45 || c2 === 42 || (c2 >= 48 && c2 <= 57)) ? listMarker(src, p, end2) : null;
        if (m2 !== null && m2[0] === ordered) {
          const t = trimRange(src, m2[2], end2);
          cur = [src.slice(t[0], t[1])];
          items.push(cur);
          p = nl2 === -1 ? len : nl2 + 1;
          if (nl2 === -1) break;
        } else if (c2 === 32 && isContinued(src, p, end2)) {
          const t = trimRange(src, p, end2);
          cur.push(src.slice(t[0], t[1]));
          p = nl2 === -1 ? len : nl2 + 1;
          if (nl2 === -1) break;
        } else break;
      }
      pos = p;
      if (ordered && startNum !== 1) out.push(`<ol start="${startNum}">\n`);
      else if (ordered) out.push('<ol>\n');
      else out.push('<ul>\n');
      for (let k = 0; k < items.length; k++) {
        const text = items[k].join('\n');
        out.push('<li>');
        inlineInto(out, text, 0, text.length, linkFn);
        out.push('</li>\n');
      }
      out.push(ordered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const firstStart = pos;
    const firstEnd = end;
    let p = next;
    let lines = null;
    while (p < len) {
      const nl2 = src.indexOf('\n', p);
      const end2 = nl2 === -1 ? len : nl2;
      if (end2 === p) break;
      const c2 = src.charCodeAt(p);
      if ((c2 === 32 || c2 === 9 || c2 === 96 || c2 === 35 || c2 === 45 || c2 === 42) && paraEnds(src, p, end2)) break;
      if (lines === null) lines = [[firstStart, firstEnd]];
      lines.push([p, end2]);
      p = nl2 === -1 ? len : nl2 + 1;
      if (nl2 === -1) break;
    }
    pos = p;
    // The paragraph's text: a range of the source when no line needs
    // trimming (no slice, no join), else the trimmed lines joined.
    let textSrc = src;
    let textStart;
    let textEnd;
    if (lines === null) {
      let a = firstStart;
      let b = firstEnd;
      while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
      while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
      if (a === firstStart && b === firstEnd) {
        textStart = firstStart;
        textEnd = firstEnd;
      } else {
        textSrc = src.slice(a, b);
        textStart = 0;
        textEnd = textSrc.length;
      }
    } else {
      let needsTrim = false;
      for (let k = 0; k < lines.length; k++) {
        const a = lines[k][0];
        const b = lines[k][1];
        if (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9 || src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) {
          needsTrim = true;
          break;
        }
      }
      if (!needsTrim) {
        textStart = lines[0][0];
        textEnd = lines[lines.length - 1][1];
      } else {
        const parts = [];
        for (let k = 0; k < lines.length; k++) {
          const t = trimRange(src, lines[k][0], lines[k][1]);
          parts.push(src.slice(t[0], t[1]));
        }
        textSrc = parts.join('\n');
        textStart = 0;
        textEnd = textSrc.length;
      }
    }
    out.push('<p>');
    const mark = out.length;
    inlineInto(out, textSrc, textStart, textEnd, linkFn);
    if (!haveExcerpt) {
      excerpt = out.slice(mark).join('');
      haveExcerpt = true;
    }
    out.push('</p>\n');
  }
  return { html: out.join(''), toc, excerpt: haveExcerpt ? excerpt : '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathParts(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function onlySpacesTabs(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Instruction ops: 0 text, 1 var (escaped), 2 raw, 3 jump-if-false, 4 jump,
// 5 for-setup, 6 for-next, 7 include. A var/raw/if/for carries a slot: the
// offset from the top of the frame stack of the loop frame that binds its
// first name, or -1 when no enclosing loop binds it (walk the chain).

/**
 * `src` compiled to flat instructions. Two passes, as the reference does:
 * tokenising first (an unclosed delimiter or a bad `{{ }}` path throws
 * before any tag error), then compiling the tokens.
 */
function compileTemplate(name, src) {
  const toks = [];
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
      if (text !== '') {
        toks.push([0, text]);
        text = '';
      }
      toks.push([raw ? 2 : 1, pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpacesTabs(src, lineStart, open) && onlySpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      toks.push([0, text]);
      text = '';
    }
    toks.push([3, src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') toks.push([0, text]);

  const code = [];
  const stack = [];
  const bindings = [];
  const slotOf = (firstName) => {
    if (firstName === 'loop' && bindings.length > 0) return 0;
    for (let d = bindings.length - 1; d >= 0; d--) {
      if (bindings[d] === firstName) return bindings.length - 1 - d;
    }
    return -1;
  };
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t];
    if (tok[0] === 0) {
      code.push([0, tok[1]]);
      continue;
    }
    if (tok[0] === 1 || tok[0] === 2) {
      code.push([tok[0], slotOf(tok[1][0]), tok[1]]);
      continue;
    }
    const tag = tok[1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const path = pathParts(name, m[2]);
      const at = code.length;
      code.push([5, slotOf(path[0]), path, m[1], 0, 0]);
      stack.push({ kind: 'for', at });
      bindings.push(m[1]);
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const path = pathParts(name, m[2]);
      const at = code.length;
      code.push([3, slotOf(path[0]), path, m[1] !== undefined, 0]);
      stack.push({ kind: 'if', at, elseAt: -1 });
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top === undefined || top.kind !== 'if' || top.elseAt !== -1) {
        throw new TemplateError(`template "${name}": an else outside an if`);
      }
      const jumpAt = code.length;
      code.push([4, 0]);
      code[top.at][4] = jumpAt + 1;
      top.elseAt = jumpAt;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      const top = stack[stack.length - 1];
      if (top === undefined || top.kind !== want) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      if (want === 'for') {
        bindings.pop();
        const forIns = code[top.at];
        forIns[4] = top.at + 1;
        code.push([6]);
        forIns[5] = code.length;
      } else if (top.elseAt !== -1) {
        code[top.elseAt][1] = code.length;
      } else {
        code[top.at][4] = code.length;
      }
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      code.push([7, m[1]]);
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 0) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return code;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `code` rendered into `out`. `frames` is the scope stack (the root vars at
 * index 0, one frame per active loop above it); `loops` the active loop
 * states. Includes share both stacks and render at depth + 1, at most 8 deep;
 * a missing include renders nothing.
 *
 * Ops 1, 2, 3 and 5 all resolve a path the same way (first name from the
 * frame `slot` names, then own properties), so one shared block in the loop
 * serves them all instead of a lookup call per variable.
 */
function renderInto(code, frames, loops, templates, out, depth) {
  let pc = 0;
  const n = code.length;
  while (pc < n) {
    const ins = code[pc];
    const op = ins[0];
    if (op === 0) {
      out.push(ins[1]);
      pc++;
      continue;
    }
    if (op === 4) {
      pc = ins[1];
      continue;
    }
    if (op === 6) {
      const st = loops[loops.length - 1];
      const nidx = st.idx + 1;
      if (nidx < st.arr.length) {
        st.idx = nidx;
        st.frame[st.name] = st.arr[nidx];
        st.loopObj.index = nidx + 1;
        st.loopObj.first = false;
        st.loopObj.last = nidx === st.arr.length - 1;
        pc = st.bodyPC;
      } else {
        loops.pop();
        frames.pop();
        pc++;
      }
      continue;
    }
    if (op === 7) {
      const t = templates.get(ins[1]);
      if (t !== undefined && depth < 8) renderInto(t, frames, loops, templates, out, depth + 1);
      pc++;
      continue;
    }
    const slot = ins[1];
    const path = ins[2];
    let v;
    if (slot >= 0) {
      v = frames[frames.length - 1 - slot][path[0]];
    } else {
      for (let f = frames.length - 1; f >= 0; f--) {
        if (Object.hasOwn(frames[f], path[0])) {
          v = frames[f][path[0]];
          break;
        }
      }
    }
    if (v !== undefined) {
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) {
          v = undefined;
          break;
        }
        v = v[path[k]];
      }
    }
    if (op === 1 || op === 2) {
      if (typeof v === 'string') {
        out.push(op === 1 ? esc(v) : v);
      } else {
        const t = textOf(v);
        out.push(op === 1 ? esc(t) : t);
      }
      pc++;
    } else if (op === 3) {
      if (truthy(v) === ins[3]) pc = ins[4];
      else pc++;
    } else {
      if (!Array.isArray(v) || v.length === 0) {
        pc = ins[5];
      } else {
        const frame = {};
        const loopObj = { index: 1, first: true, last: v.length === 1, length: v.length };
        frame[ins[3]] = v[0];
        frame.loop = loopObj;
        frames.push(frame);
        loops.push({ arr: v, idx: 0, bodyPC: ins[4], frame, loopObj, name: ins[3] });
        pc = ins[4];
      }
    }
  }
}

// -------------------------------------------------------------------- build

const RESERVED_DIRS = ['posts', 'tags', 'page'];

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** `rel` resolved from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  if (rel.indexOf('/') === -1) {
    if (rel === '.' || rel === '..' || rel === '') {
      if (rel === '..') {
        if (dir === '') return null;
        const cut = dir.lastIndexOf('/');
        return cut === -1 ? '' : dir.slice(0, cut);
      }
      return dir;
    }
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

/** A post's card, as lists show it. The tag views are shared per tag. */
function cardOf(s) {
  const date = s.data.date;
  const refs = s.tagRefs;
  const tags = new Array(refs.length);
  for (let i = 0; i < refs.length; i++) tags[i] = refs[i].view;
  return {
    title: s.data.title,
    url: s.url,
    date: date ?? '',
    date_long: date === undefined ? '' : longDate(date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags,
  };
}

/** A page as its layout reads it. A post reuses its card from the map. */
function pageOf(s, cards) {
  const card = s.post ? cards.get(s) : cardOf(s);
  const newer = s.post ? s.newer : null;
  const older = s.post ? s.older : null;
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: newer === null ? null : newer.link,
    older: older === null ? null : older.link,
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
function build(input) {
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n') });
    } else statics.push(f);
  }

  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
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

  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.srcDir = dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED_DIRS : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  const linkCache = new Map();
  const linkState = { source: null, dir: '' };
  const linkFn = (target) => {
    if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35 || hasScheme(target)) return target;
    let byTarget = linkCache.get(linkState.dir);
    if (byTarget === undefined) {
      byTarget = new Map();
      linkCache.set(linkState.dir, byTarget);
    }
    const hit = byTarget.get(target);
    if (hit !== undefined) {
      if (hit === null) broken.add(`broken-link ${linkState.source.path} -> ${target}`);
      return hit === null ? target : hit;
    }
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(linkState.dir, rel);
    let href = null;
    if (path !== null) {
      const page = bySource.get(path);
      if (page !== undefined) href = page.url + frag;
      else if (staticPaths.has(path)) href = `${base}/${path}${frag}`;
    }
    if (href === null) broken.add(`broken-link ${linkState.source.path} -> ${target}`);
    byTarget.set(target, href);
    return href === null ? target : href;
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    linkState.source = s;
    linkState.dir = s.srcDir;
    const md = renderMarkdown(s.body, linkFn);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
    p.link = { title: p.data.title, url: p.url, date: p.data.date ?? '', date_long: p.data.date === undefined ? '' : longDate(p.data.date) };
  }

  const bySlug = new Map();
  const ownTagNames = (s) => {
    const ns = s.data.tags ?? [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < ns.length; i++) {
      const slug = slugify(ns[i]);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(ns[i]);
      }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const ns = ownTagNames(p);
    for (let j = 0; j < ns.length; j++) {
      const slug = slugify(ns[j]);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name: ns[j], slug, url: `${base}/tags/${slug}/`, posts: [] };
        tag.view = { name: ns[j], slug, url: tag.url };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const ns = ownTagNames(s);
    s.tagRefs = [];
    for (let j = 0; j < ns.length; j++) {
      const slug = slugify(ns[j]);
      const tag = bySlug.get(slug);
      if (tag !== undefined) s.tagRefs.push(tag);
      else {
        const view = { name: ns[j], slug, url: '' };
        s.tagRefs.push({ name: ns[j], slug, url: '', posts: [], view });
      }
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const site = { title: input.site.title, base_url: base };
  const allTags = [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    allTags.push({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length });
  }
  const recentSlice = posts.slice(0, input.site.recent);
  const recent = [];
  for (let i = 0; i < recentSlice.length; i++) recent.push(cards.get(recentSlice[i]));
  const rootVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const frames = [rootVars];
  const loops = [];
  const output = {};
  const render = (name) => {
    const code = templates.get(name);
    if (code === undefined) return null;
    const out = [];
    renderInto(code, frames, loops, templates, out, 0);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    rootVars.page = pageOf(s, cards);
    output[`${s.outDir}/index.html`] = render(s.layout);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  rootVars.page = undefined;
  for (let k = 1; k <= pages; k++) {
    const slice = posts.slice((k - 1) * per, k * per);
    const pageCards = [];
    for (let i = 0; i < slice.length; i++) pageCards.push(cards.get(slice[i]));
    rootVars.posts = pageCards;
    rootVars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = render('index');
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  rootVars.posts = undefined;
  rootVars.pager = undefined;
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const tPosts = [];
    for (let j = 0; j < t.posts.length; j++) tPosts.push(cards.get(t.posts[j]));
    rootVars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tPosts };
    const html = render('tag');
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  rootVars.tag = undefined;
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
