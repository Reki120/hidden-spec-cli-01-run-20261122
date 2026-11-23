// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, as [old path, new path], in the order they ran. */
  readonly moves: Array<readonly [string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and matching at three tiers (section 5).
// Everything from here to the format readers is the part the starter left open.

interface FileState {
  lines: string[];
  br: string;
  /** True when the file's text ends with its line break. */
  eol: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let eol = false;
  if (text.endsWith(br)) {
    eol = true;
    parts.pop();
  }
  return { lines: parts, br, eol };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.eol ? st.br : '');
}

const rstripWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierKey(tier: number): (s: string) => string {
  if (tier === 0) return (s) => s;
  if (tier === 1) return rstripWs;
  return stripWs;
}

interface Found {
  tier: number;
  positions: number[];
}

/**
 * The occurrences of O in `lines` at the first tier that has one, at or after
 * `from`; with `mustEnd`, only occurrences that end at the file's last line.
 */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, mustEnd = false): Found | null {
  if (o.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const key = tierKey(tier);
    const want = o.map(key);
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (mustEnd && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (key(lines[i + j]!) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier that has one, else -1. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const key = tierKey(tier);
    const want = key(anchor);
    for (let i = from; i < lines.length; i += 1) {
      if (key(lines[i]!) === want) return i;
    }
  }
  return -1;
}

/** One line of a hunk or chunk body: context, old (`-`) or new (`+`); `raw` marks a line that was empty in the patch. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  raw?: boolean;
}

/**
 * The lines a body writes over the match at `pos`: context lines come from the
 * file itself, `-` lines write nothing, `+` lines are the patch's, re-indented
 * at tier 2 from the old block's first line to the file's first matched line.
 */
function buildNew(body: BodyLine[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  const out: string[] = [];
  let j = 0;
  let shiftFrom = '';
  let shiftTo = '';
  if (tier === 2 && o.length > 0) {
    shiftFrom = leadWs(o[0]!);
    shiftTo = leadWs(fileLines[pos]!);
  }
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + j]!);
      j += 1;
    } else if (b.kind === 'del') {
      j += 1;
    } else {
      let s = b.text;
      if (tier === 2 && s.trim() !== '' && s.startsWith(shiftFrom)) s = shiftTo + s.slice(shiftFrom.length);
      out.push(s);
    }
  }
  return out;
}

/** The old lines a body names, in body order. */
function bodyOld(body: BodyLine[]): string[] {
  const o: string[] = [];
  for (const b of body) if (b.kind !== 'add') o.push(b.text);
  return o;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6).

interface Hunk {
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  bsTail: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  bsAdd: boolean;
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  oldPath?: string | null;
  newPath?: string | null;
  hasPair: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path a `---` or `+++` header line names: after the four characters, to the first tab, spaces off, prefix off. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number.parseInt(m[1]!, 10);
  const body: BodyLine[] = [];
  /** Indexes of body lines a `\` line followed; a `\` line refers to the body line before it. */
  const bsAfter = new Set<number>();
  i += 1;
  while (i < lines.length) {
    const bl = lines[i]!;
    if (bl.startsWith('diff --git ')) break;
    if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    const c = bl[0];
    if (bl === '') body.push({ kind: 'ctx', text: '', raw: true });
    else if (c === ' ') body.push({ kind: 'ctx', text: bl.slice(1) });
    else if (c === '-') body.push({ kind: 'del', text: bl.slice(1) });
    else if (c === '+') body.push({ kind: 'add', text: bl.slice(1) });
    else if (c === '\\') {
      if (body.length > 0) bsAfter.add(body.length - 1);
    } else break;
    i += 1;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === true) body.pop();
  // The final line break is cancelled only when a `\` line follows the hunk's
  // last context or `+` line (for a creation, its last `+` line).
  let bsTail = false;
  let bsAdd = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === 'add') {
      bsAdd = bsAfter.has(k);
      bsTail = bsAdd;
      break;
    }
    if (body[k]!.kind === 'ctx') {
      bsTail = bsAfter.has(k);
      break;
    }
  }
  return { hunk: { a, body, bsTail, bsAdd }, next: i };
}

/** Apply one hunk to a file state; returns the change in line count. */
function applyHunk(st: FileState, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const o = bodyOld(hunk.body);
  if (o.length === 0) {
    const adds = hunk.body.filter((b) => b.kind === 'add').map((b) => b.text);
    let at = hunk.a + d;
    if (at < 0) at = 0;
    if (at > st.lines.length) at = st.lines.length;
    const atEnd = at === st.lines.length;
    st.lines.splice(at, 0, ...adds);
    if (atEnd) st.eol = !hunk.bsTail;
    return adds.length;
  }
  const found = findTier(st.lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const runsToEnd = pos + o.length === st.lines.length;
  const written = buildNew(hunk.body, st.lines, pos, found.tier, o);
  st.lines.splice(pos, o.length, ...written);
  if (runsToEnd) st.eol = !hunk.bsTail;
  return written.length - o.length;
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newP = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  return (tree) => {
    const creation = oldP === null || sec.newFile;
    const deletion = newP === null || sec.deletedFile;
    if (creation && !deletion) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      let eol = true;
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === 'add') outLines.push(b.text);
        if (h.body.some((b) => b.kind === 'add')) eol = !h.bsAdd;
      }
      tree.now.set(p, joinFile({ lines: outLines, br: '\n', eol }));
      return;
    }
    if (deletion && !creation) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldP!;
    const to = newP!;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== from && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const st = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(st, h, d, strict, from);
    tree.now.set(to, joinFile(st));
    if (to !== from) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const cut = rest.indexOf(' b/');
      if (!rest.startsWith('a/') || cut < 2) throw new Exit2(`error: parse ${i + 1}`);
      sec = { gitOld: rest.slice(2, cut), gitNew: rest.slice(cut + 3), hasPair: false, newFile: false, deletedFile: false, hunks: [] };
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && sec.hunks.length === 0 && !sec.hasPair) {
        sec.oldPath = headerPath(line);
        sec.newPath = headerPath(lines[i + 1]!);
        sec.hasPair = true;
      } else {
        sec = { oldPath: headerPath(line), newPath: headerPath(lines[i + 1]!), hasPair: true, newFile: false, deletedFile: false, hunks: [] };
        sections.push(sec);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && sec !== null && sec.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunk(lines, i);
      sec.hunks.push(parsed.hunk);
      i = parsed.next;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('+++ ')) {
        sec.newPath = headerPath(line);
        sec.hasPair = true;
      } else if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7).

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (oldLines.length === 0) {
      if (before !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: [...newLines], br: '\n', eol: true }));
      return;
    }
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const body = newLines.map((t): BodyLine => ({ kind: 'add', text: t }));
    const written = buildNew(body, st.lines, pos, found.tier, oldLines);
    st.lines.splice(pos, oldLines.length, ...written);
    tree.now.set(path, joinFile(st));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let eq = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    let path: string | null = null;
    for (let j = at - 1; j >= searchFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${at + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(at + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8).

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  fileLines: string[];
  moveTo?: string;
  chunks: VChunk[];
}

function vAddEdit(sec: VSection): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
    tree.now.set(sec.path, joinFile({ lines: [...sec.fileLines], br: '\n', eol: true }));
  };
}

function vDelEdit(sec: VSection): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
    tree.now.set(sec.path, null);
  };
}

function vUpdEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const st = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(st.lines, chunk.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const o = bodyOld(chunk.body);
      if (o.length === 0) {
        const adds = chunk.body.filter((b) => b.kind === 'add').map((b) => b.text);
        const at = chunk.eof ? st.lines.length : Math.min(cursor, st.lines.length);
        st.lines.splice(at, 0, ...adds);
        cursor = at + adds.length;
        continue;
      }
      const found = findTier(st.lines, o, strict, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.positions[0]!;
      const written = buildNew(chunk.body, st.lines, pos, found.tier, o);
      st.lines.splice(pos, o.length, ...written);
      cursor = pos + written.length;
    }
    const out = joinFile(st);
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

const V_HEADS: Array<{ prefix: string; kind: VSection['kind'] }> = [
  { prefix: '*** Add File:', kind: 'add' },
  { prefix: '*** Delete File:', kind: 'del' },
  { prefix: '*** Update File:', kind: 'upd' },
];

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const head = V_HEADS.find((h) => line.startsWith(h.prefix));
    if (head === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { kind: head.kind, path: line.slice(head.prefix.length).trim(), lineNo: i + 1, fileLines: [], chunks: [] };
    sections.push(sec);
    i += 1;
    if (head.kind === 'add') {
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** ')) break;
        if (l.startsWith('+')) sec.fileLines.push(l.slice(1));
        else if (l.trim() === '') sec.fileLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (sec.fileLines.length > 0 && sec.fileLines[sec.fileLines.length - 1] === '') sec.fileLines.pop();
    } else if (head.kind === 'del') {
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** ')) break;
        if (!blank(l)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
    } else {
      let cur: VChunk | null = null;
      let firstLine = true;
      while (i < last) {
        const l = lines[i]!;
        if (V_HEADS.some((h) => l.startsWith(h.prefix))) break;
        if (firstLine && l.startsWith('*** Move to:')) {
          sec.moveTo = l.slice('*** Move to:'.length).trim();
          i += 1;
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          sec.chunks.push(cur);
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            sec.chunks.push(cur);
          } else cur.eof = true;
          cur = null;
          i += 1;
          continue;
        }
        if (l.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            sec.chunks.push(cur);
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '', raw: true });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), raw: l.trim() === '' });
          else if (l[0] === '-') cur.body.push({ kind: 'del', text: l.slice(1) });
          else cur.body.push({ kind: 'add', text: l.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const tail = sec.chunks[sec.chunks.length - 1];
      if (tail !== undefined) while (tail.body.length > 0 && tail.body[tail.body.length - 1]!.raw === true) tail.body.pop();
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => (s.kind === 'add' ? vAddEdit(s) : s.kind === 'del' ? vDelEdit(s) : vUpdEdit(s, strict)));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && tree.now.get(n) !== undefined) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort(byBytes)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!movedOld.has(p) && !movedNew.has(p)) rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((x, y) => byBytes(x.key, y.key));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
