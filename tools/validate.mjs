#!/usr/bin/env node
/**
 * validate.mjs — offline, zero-dependency validator for the `annotation`
 * Harness bundle (host plugin + Web client plugin + locales + icon).
 *
 * It never touches the network, never installs packages, never activates the
 * plugin and never calls plugin_manager. It only reads files under the bundle
 * directory (plus Node itself via `node --check` on stdin) and reports.
 *
 * Usage:
 *   node annotation/tools/validate.mjs                 # validate ../ of this script
 *   node annotation/tools/validate.mjs --dir annotation
 *   node annotation/tools/validate.mjs --json          # machine-readable
 *
 * Exit codes: 0 = all checks passed (warnings allowed), 1 = at least one
 * error, 2 = usage / bundle-directory problem.
 *
 * Missing or half-written bundle files are reported as precise errors; the
 * validator keeps going so a partially scaffolded bundle still yields a
 * complete checklist.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const LIMITS = {
  iconBytes: 256 * 1024,
  maxReportedMatches: 5,
};

const KNOWN_TOP_LEVEL_PATCH_KEYS = new Set([
  'insert', 'override', 'group', 'disabled', 'isolate',
]);

const BROWSER_GLOBALS = [
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
  'HTMLElement', 'HTMLCanvasElement', 'CustomEvent', 'DOMParser',
  'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver',
  'MutationObserver', 'ResizeObserver',
];

// Modules the browser module table provides without declaring them in
// dsh.client.external (see references/ui-plugin.md).
const BASELINE_CLIENT_MODULES = new Set(['react', 'react-dom', 'react/jsx-runtime']);

const NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, json: false, quiet: false, section: null };
  let positional = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--dir' || arg === '-d') {
      const value = argv[i + 1];
      if (!value) usageError('--dir needs a value');
      i += 1;
      opts.root = path.resolve(value);
    } else if (arg.startsWith('--dir=')) {
      opts.root = path.resolve(arg.slice('--dir='.length));
    } else if (arg.startsWith('-')) {
      usageError(`unknown option: ${arg}`);
    } else if (!positional) {
      opts.root = path.resolve(arg);
      positional = true;
    } else {
      usageError(`unexpected argument: ${arg}`);
    }
  }
  return opts;
}

function usageError(message) {
  console.error(`validate.mjs: ${message}`);
  console.error('Run with --help for usage.');
  process.exit(2);
}

function printHelp() {
  console.log(`Usage: node tools/validate.mjs [--dir <bundle-dir>] [--json] [--quiet]

Offline validation of the annotation Harness bundle. No network, no installs.

  --dir <dir>   bundle directory to validate (default: parent of tools/)
  --json        emit machine-readable JSON instead of the human report
  --quiet       only print errors and the final result
  --help        show this help

Exit codes: 0 PASS, 1 validation errors, 2 usage/bundle-directory error.`);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);

const report = {
  pass: 0,
  fail: 0,
  warn: 0,
  skip: 0,
  results: [],
  failures: [],
  warnings: [],
};

const opts = parseArgs(process.argv.slice(2));

function emit(kind, name, detail) {
  report.results.push({ kind, name, detail: detail || '' });
  if (kind === 'pass') report.pass += 1;
  else if (kind === 'fail') { report.fail += 1; report.failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
  else if (kind === 'warn') { report.warn += 1; report.warnings.push(`${name}${detail ? ` — ${detail}` : ''}`); }
  else report.skip += 1;

  if (opts.json) return;
  if (opts.quiet && kind !== 'fail') return;

  const marker = {
    pass: paint('32', 'ok  '),
    fail: paint('31', 'FAIL'),
    warn: paint('33', 'warn'),
    skip: paint('90', 'skip'),
  }[kind];
  console.log(`  [${marker}] ${name}${detail ? paint('90', ` — ${detail}`) : ''}`);
}

const ok = (name, detail = '') => emit('pass', name, detail);
const fail = (name, detail = '') => emit('fail', name, detail);
const warn = (name, detail = '') => emit('warn', name, detail);
const skip = (name, detail = '') => emit('skip', name, detail);

function head(title) {
  report.results.push({ kind: 'section', name: title, detail: '' });
  if (opts.json || opts.quiet) return;
  console.log(`\n${paint('1', title)}`);
}

// ---------------------------------------------------------------------------
// Small filesystem / path helpers (all failures are reported, never thrown)
// ---------------------------------------------------------------------------

const toFsPath = (rel) => path.join(opts.root, ...String(rel).split('/'));

/** Normalize a manifest path (always POSIX) to a clean relative POSIX path. */
function manifestPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.posix.normalize(value.replace(/^\.\//, ''));
}

/** Reject absolute paths, URLs and paths that escape the package root. */
function checkSubpath(rel, label) {
  if (typeof rel !== 'string' || !rel.trim()) {
    return { ok: false, reason: `${label} is not a non-empty string` };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rel) || rel.startsWith('//')) {
    return { ok: false, reason: `${label} is a URL (${rel}); icons/exports must be package paths` };
  }
  if (path.isAbsolute(rel) || rel.startsWith('/')) {
    return { ok: false, reason: `${label} is absolute (${rel}); only package-relative paths are allowed` };
  }
  const norm = path.posix.normalize(rel.replace(/^\.\//, ''));
  if (norm === '..' || norm.startsWith('../')) {
    return { ok: false, reason: `${label} escapes the package root (${rel})` };
  }
  return { ok: true, norm };
}

function inspect(rel) {
  try {
    const st = fs.lstatSync(toFsPath(rel));
    return { exists: true, symlink: st.isSymbolicLink(), file: st.isFile(), size: st.size, mode: st.mode };
  } catch (error) {
    return { exists: false, error: error.code === 'ENOENT' ? 'missing' : error.message };
  }
}

function readText(rel) {
  try {
    return { ok: true, text: fs.readFileSync(toFsPath(rel), 'utf8') };
  } catch (error) {
    return { ok: false, error: error.code === 'ENOENT' ? 'missing file' : error.message };
  }
}

function readJson(rel) {
  const read = readText(rel);
  if (!read.ok) return { ok: false, error: read.error };
  try {
    return { ok: true, value: JSON.parse(read.text) };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error.message}` };
  }
}

function listLocaleFiles() {
  const dir = toFsPath('locale');
  try {
    const entries = fs.readdirSync(dir);
    return entries.filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort();
  } catch {
    return [];
  }
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

// ---------------------------------------------------------------------------
// Java/TypeScript-ish source sanitizer: blanks comments, strings, templates
// and regex literals while preserving offsets and newlines. Used for
// delimiter balancing, ESM-statement detection and browser-global scans.
// ---------------------------------------------------------------------------

function sanitizeSource(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          out += source[i + 1] === '\n' ? '\n' : '  ';
          i += 2;
          continue;
        }
        if (c === quote) { out += ' '; i += 1; break; }
        if (c === '\n' && quote !== '`') break; // unterminated string: leave as-is
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/') {
      let last = '';
      for (let k = out.length - 1; k >= 0; k -= 1) {
        if (!/\s/.test(out[k])) { last = out[k]; break; }
      }
      const startsExpression = last === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last);
      if (startsExpression) {
        out += ' ';
        i += 1;
        let inClass = false;
        while (i < n) {
          const c = source[i];
          if (c === '\\') { out += '  '; i += 2; continue; }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) { out += ' '; i += 1; break; }
          else if (c === '\n') break;
          out += c === '\n' ? '\n' : ' ';
          i += 1;
        }
        while (i < n && /[A-Za-z]/.test(source[i])) { out += ' '; i += 1; }
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Balance (), [], {} over sanitized source. Returns null when balanced. */
function findDelimiterError(sanitized) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < sanitized.length; i += 1) {
    const ch = sanitized[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ ch, index: i });
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack.pop();
      if (!top || top.ch !== pairs[ch]) {
        return { index: i, message: `unexpected '${ch}'` };
      }
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    return { index: top.index, message: `unclosed '${top.ch}'` };
  }
  return null;
}

/** Run `node --check` on stdin (no temp files). mode: 'cjs' | 'esm'. */
function nodeCheck(source, mode) {
  const args = mode === 'esm' ? ['--input-type=module', '--check'] : ['--check'];
  const result = spawnSync(process.execPath, args, {
    input: source,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) return { ok: false, detail: `could not run node --check: ${result.error.message}` };
  if (result.status === 0) return { ok: true };
  const stderr = (result.stderr || '').split('\n')
    .filter((line) => line.trim())
    .filter((line) => !/^\(node:\d+\)/.test(line))
    .filter((line) => !/^\(Use `node --trace-warnings/.test(line))
    .filter((line) => !/^Node\.js v/.test(line))
    .filter((line) => !/^\s+at\s/.test(line))
    .slice(0, 6)
    .map((line) => line.trim())
    .join('\n');
  return { ok: false, detail: stderr || `node --check exited ${result.status}` };
}

// ---------------------------------------------------------------------------
// Minimal YAML-subset parser for cordis.patch.yml (no dependency allowed).
// Supports: block sequences, block mappings, scalar values (plain/single/double
// quoted/flow arrays/maps), comments, `!!js` tags and block scalars (`|`/`>`).
// ---------------------------------------------------------------------------

class YamlError extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /[\s]/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function tokenizeYaml(text) {
  const lines = [];
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  for (let n = 0; n < raw.length; n += 1) {
    const original = raw[n];
    if (/^\s*$/.test(original)) continue;
    if (/^\s*#/.test(original)) continue;
    if (/^\s*(---|\.\.\.)\s*$/.test(original)) continue;
    if (/^\t/.test(original)) throw new YamlError(n + 1, 'tab indentation is not allowed in YAML; use spaces');
    const indent = original.match(/^ */)[0].length;
    const body = stripYamlComment(original.slice(indent)).trimEnd();
    if (!body.trim()) continue;
    lines.push({ line: n + 1, indent, text: body });
  }
  return lines;
}

function parseYamlScalar(raw) {
  const text = raw.trim();
  if (text === '') return null;
  if (text.startsWith('!!js')) return { __tag: 'js', expression: text.slice(4).trim() };
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).replace(/\\(["\\/bfnrt])/g, (_, c) => ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[c]));
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitFlow(text.slice(1, -1)).map((part) => parseYamlScalar(part));
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const obj = {};
    for (const part of splitFlow(text.slice(1, -1))) {
      if (!part.trim()) continue;
      const colon = part.indexOf(':');
      if (colon === -1) throw new YamlError(0, `invalid flow mapping entry: ${part}`);
      obj[parseYamlScalar(part.slice(0, colon))] = parseYamlScalar(part.slice(colon + 1));
    }
    return obj;
  }
  return text;
}

function splitFlow(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

function matchYamlKey(text) {
  const match = /^((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*')|(?:[^:#]+?))\s*:(?:\s+(.*))?$/.exec(text);
  if (!match) return null;
  const key = parseYamlScalar(match[1]);
  if (typeof key !== 'string' || !key.trim()) return null;
  const hasValue = match[2] !== undefined;
  return { key, rest: hasValue ? match[2] : '', hasValue };
}

function isSeqLine(text) {
  return text === '-' || text.startsWith('- ');
}

function parseYaml(text) {
  const lines = tokenizeYaml(text);
  if (!lines.length) throw new YamlError(1, 'empty patch file');
  const parsed = parseYamlBlock(lines, 0, lines[0].indent);
  if (parsed.next < lines.length) {
    throw new YamlError(lines[parsed.next].line, 'unexpected content (check indentation)');
  }
  return parsed.value;
}

function parseYamlBlock(lines, index, indent) {
  return isSeqLine(lines[index].text)
    ? parseYamlSequence(lines, index, indent)
    : parseYamlMapping(lines, index, indent);
}

function consumeBlockScalar(lines, index, indent) {
  let out = '';
  let i = index;
  while (i < lines.length && lines[i].indent > indent) {
    out += (out ? '\n' : '') + lines[i].text;
    i += 1;
  }
  return { value: out, next: i };
}

function parseYamlSequence(lines, index, indent) {
  const items = [];
  let i = index;
  while (i < lines.length && lines[i].indent === indent && isSeqLine(lines[i].text)) {
    const text = lines[i].text;
    const inline = text === '-' ? '' : text.slice(2).trim();
    i += 1;
    if (!inline) {
      if (i < lines.length && lines[i].indent > indent) {
        const parsed = parseYamlBlock(lines, i, lines[i].indent);
        items.push(parsed.value);
        i = parsed.next;
      } else {
        items.push(null);
      }
      continue;
    }
    const kv = matchYamlKey(inline);
    if (kv) {
      // Column where the inline key starts: dash + following spaces.
      const afterDash = text.slice(1);
      const keyColumn = indent + 1 + (afterDash.match(/^ */)[0].length);
      const entry = { ...kv, line: lines[i - 1].line };
      const parsed = parseYamlMapping(lines, i, keyColumn, entry);
      items.push(parsed.value);
      i = parsed.next;
    } else if (/^[|>][+-]?$/.test(inline)) {
      const parsed = consumeBlockScalar(lines, i, indent);
      items.push(parsed.value);
      i = parsed.next;
    } else {
      items.push(parseYamlScalar(inline));
    }
  }
  return { value: items, next: i };
}

function parseYamlMapping(lines, index, indent, firstEntry = null) {
  const obj = {};
  let i = index;
  let pending = firstEntry;
  while (pending || (i < lines.length && lines[i].indent === indent && !isSeqLine(lines[i].text))) {
    if (!pending) {
      const line = lines[i];
      const kv = matchYamlKey(line.text);
      if (!kv) throw new YamlError(line.line, `expected "key: value", got: ${line.text}`);
      pending = { ...kv, line: line.line };
      i += 1;
    }
    const { key, rest, hasValue, line: lineNo } = pending;
    pending = null;
    if (hasValue) {
      if (/^[|>][+-]?$/.test(rest)) {
        const parsed = consumeBlockScalar(lines, i, indent);
        obj[key] = parsed.value;
        i = parsed.next;
      } else {
        obj[key] = parseYamlScalar(rest);
      }
    } else if (i < lines.length && lines[i].indent > indent) {
      const parsed = parseYamlBlock(lines, i, lines[i].indent);
      obj[key] = parsed.value;
      i = parsed.next;
    } else {
      obj[key] = null;
    }
    if (i < lines.length && lines[i].indent > indent) {
      throw new YamlError(lines[i].line, `unexpected indentation under "${key}"`);
    }
    if (i < lines.length && lines[i].indent === indent && isSeqLine(lines[i].text)) {
      throw new YamlError(lines[i].line, 'unexpected sequence item inside a mapping');
    }
    void lineNo;
  }
  return { value: obj, next: i };
}

// ---------------------------------------------------------------------------
// Glob matching for npm `files` entries
// ---------------------------------------------------------------------------

function globToRegExp(pattern) {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 2;
        if (pattern[i] === '/') i += 1;
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

function filesEntryMatches(entry, file) {
  const clean = entry.replace(/\/+$/, '');
  if (!/[*?]/.test(clean)) {
    // npm treats a bare directory name as "everything below it" too.
    return file === clean || file.startsWith(`${clean}/`);
  }
  return globToRegExp(clean).test(file);
}

// ---------------------------------------------------------------------------
// Section: package.json
// ---------------------------------------------------------------------------

function exportTarget(exportsField, subpath) {
  if (exportsField === undefined || exportsField === null) return null;
  if (typeof exportsField === 'string') {
    return subpath === '.' ? exportsField : null;
  }
  if (typeof exportsField !== 'object' || Array.isArray(exportsField)) return null;
  let target = exportsField[subpath];
  if (target === undefined) return null;
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object') {
    for (const key of ['import', 'default', 'module', 'require']) {
      if (typeof target[key] === 'string') return target[key];
    }
  }
  return null;
}

function collectRuntimeFiles(pkg) {
  const files = new Set();
  const add = (value) => {
    const norm = manifestPath(value);
    if (norm && norm !== '.' && !norm.includes('*')) files.add(norm);
  };
  if (pkg && typeof pkg === 'object') {
    add(exportTarget(pkg.exports, '.'));
    add(exportTarget(pkg.exports, './client'));
    add(exportTarget(pkg.exports, './icon'));
    if (typeof pkg.icon === 'string') add(pkg.icon);
    if (pkg.dsh && pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string') add(pkg.dsh.bundle.patch);
    if (pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) {
      for (const [key, value] of Object.entries(pkg.exports)) {
        if (key.includes('*')) continue;
        if (typeof value === 'string') add(value);
      }
    }
  }
  if (!files.size) {
    files.add('index.js');
    files.add('client.js');
    files.add('cordis.patch.yml');
    files.add('icon.svg');
  }
  for (const locale of listLocaleFiles()) files.add(`locale/${locale}`);
  return files;
}

function checkPackageJson() {
  head('package.json');
  const info = inspect('package.json');
  if (!info.exists) {
    fail('package.json exists', `missing file: ${path.join(opts.root, 'package.json')}`);
    return null;
  }
  if (!info.file) {
    fail('package.json is a regular file', 'expected a file, found a directory or special file');
    return null;
  }
  const parsed = readJson('package.json');
  if (!parsed.ok) {
    fail('package.json parses as JSON', parsed.error);
    return null;
  }
  const pkg = parsed.value;
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    fail('package.json root is an object', 'manifest must be a JSON object');
    return null;
  }
  ok('package.json parses as JSON');

  // name / version / type
  if (typeof pkg.name !== 'string' || !NAME_RE.test(pkg.name)) {
    fail('name is a valid package name', `got ${JSON.stringify(pkg.name)}; expected lowercase, e.g. "dsh-annotation"`);
  } else {
    ok('name', pkg.name);
  }
  if (typeof pkg.version !== 'string' || !SEMVER_RE.test(pkg.version)) {
    fail('version is semver', `got ${JSON.stringify(pkg.version)}; expected e.g. "1.0.0"`);
  } else {
    ok('version', pkg.version);
  }
  if (pkg.type !== 'module') {
    fail('type is "module"', `got ${JSON.stringify(pkg.type)}; the host entry uses ESM syntax`);
  } else {
    ok('type is "module"');
  }
  if (pkg.private !== true) warn('private: true', 'recommended for a locally installed bundle');

  // exports
  const exportsField = pkg.exports;
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    fail('exports is a subpath map', 'expected {".": "./index.js", "./client": "./client.js", ...}');
  } else {
    const required = [
      ['.', true],
      ['./client', true],
      ['./locale/*.json', true],
      ['./icon', typeof pkg.icon !== 'string'],
    ];
    for (const [subpath, isRequired] of required) {
      const target = exportTarget(exportsField, subpath);
      if (target === null) {
        if (isRequired) fail(`exports["${subpath}"]`, 'missing export (required by the manifest rules)');
        continue;
      }
      const safe = checkSubpath(target, `exports["${subpath}"]`);
      if (!safe.ok) { fail(`exports["${subpath}"] is a package-relative path`, safe.reason); continue; }
      if (subpath.includes('*')) {
        const sample = target.replace('*', 'en');
        if (!inspect(sample).exists) fail(`exports["${subpath}"] resolves`, `no locale file matches ${target}`);
        else ok(`exports["${subpath}"]`, target);
        continue;
      }
      if (!inspect(safe.norm).exists) fail(`exports["${subpath}"] target exists`, `missing file: ${safe.norm}`);
      else ok(`exports["${subpath}"]`, `${target} -> ${safe.norm}`);
    }
    // icon export target should be the icon file
    const iconViaExport = exportTarget(exportsField, './icon');
    if (iconViaExport && typeof pkg.icon === 'string') {
      warn('icon priority', 'package.json "icon" takes priority over exports["./icon"]');
    }
  }

  // files
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    fail('files is a non-empty array', 'list every runtime file (index.js, client.js, cordis.patch.yml, locale/*.json, icon.svg)');
  } else {
    const entries = pkg.files.filter((entry) => typeof entry === 'string' && entry.trim());
    if (entries.length !== pkg.files.length) {
      fail('files entries are strings', 'found non-string or empty entries');
    }
    let badEntry = false;
    for (const entry of entries) {
      const safe = checkSubpath(entry.replace(/\/+$/, ''), 'files entry');
      if (!safe.ok) { fail('files entries are package-relative', safe.reason); badEntry = true; }
    }
    if (!badEntry) ok('files entries are package-relative paths', `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
    reportFilesCoverage(pkg, entries);
  }

  // dsh.bundle
  const bundle = pkg.dsh && pkg.dsh.bundle;
  if (!bundle || typeof bundle !== 'object') {
    fail('dsh.bundle.patch', 'missing; expected {"bundle": {"patch": "./cordis.patch.yml"}}');
  } else {
    const safe = checkSubpath(bundle.patch, 'dsh.bundle.patch');
    if (!safe.ok) fail('dsh.bundle.patch path', safe.reason);
    else if (!inspect(safe.norm).exists) fail('dsh.bundle.patch target exists', `missing file: ${safe.norm}`);
    else ok('dsh.bundle.patch', `${bundle.patch} -> ${safe.norm}`);
  }

  // dsh.client
  const client = pkg.dsh && pkg.dsh.client;
  if (!client || typeof client !== 'object') {
    fail('dsh.client', 'missing; expected {"platform": "web", "immediately": true, "inject": [...]}');
  } else {
    if (client.platform !== 'web') {
      fail('dsh.client.platform is "web"', `got ${JSON.stringify(client.platform)}`);
    } else {
      ok('dsh.client.platform is "web"');
    }
    if (!Array.isArray(client.inject) || client.inject.length === 0) {
      fail('dsh.client.inject is a non-empty array', 'e.g. ["@deepseek-ai/dsh-client-ui-conversation"]');
    } else {
      const invalid = client.inject.filter((entry) => typeof entry !== 'string' || !entry.trim());
      if (invalid.length) {
        fail('dsh.client.inject entries are non-empty strings', `bad entries: ${JSON.stringify(invalid)}`);
      } else {
        ok('dsh.client.inject', client.inject.join(', '));
        const duplicates = client.inject.filter((entry, index) => client.inject.indexOf(entry) !== index);
        if (duplicates.length) warn('dsh.client.inject has no duplicates', duplicates.join(', '));
      }
    }
    if (client.immediately !== undefined && typeof client.immediately !== 'boolean') {
      fail('dsh.client.immediately is boolean', `got ${JSON.stringify(client.immediately)}`);
    }
    if (client.external !== undefined) {
      if (!Array.isArray(client.external) || client.external.some((entry) => typeof entry !== 'string')) {
        fail('dsh.client.external is an array of strings', 'non-baseline runtime imports belong here');
      }
    }
  }

  return pkg;
}

function walkBundleFiles() {
  const out = [];
  const skip = new Set(['node_modules', '.git', '.svn']);
  const walk = (abs, prefix) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(path.join(abs, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(opts.root, '');
  return out;
}

function reportFilesCoverage(pkg, entries) {
  const runtime = [...collectRuntimeFiles(pkg)].filter((rel) => inspect(rel).exists).sort();
  if (!runtime.length) {
    warn('runtime files found', 'no runtime files exist yet; cannot check files coverage');
    return;
  }
  const uncovered = runtime.filter((rel) => !entries.some((entry) => filesEntryMatches(entry, rel)));
  if (uncovered.length) {
    fail('files covers every runtime file', `not listed: ${uncovered.join(', ')}`);
  } else {
    ok('files covers every runtime file', runtime.join(', '));
  }
  const present = walkBundleFiles();
  for (const entry of entries) {
    const clean = entry.replace(/\/+$/, '');
    if (/[*?]/.test(clean) && !present.some((rel) => filesEntryMatches(clean, rel))) {
      warn('files entry matches nothing', `${entry} (stale entry?)`);
    }
  }
  if (entries.some((entry) => /^tools(\/|$)/.test(entry) || entry === 'build.mjs')) {
    warn('files lists dev-only files', 'tools/ and build.mjs are not runtime files; keep them out of "files"');
  }
}

// ---------------------------------------------------------------------------
// Section: cordis.patch.yml
// ---------------------------------------------------------------------------

function checkPatch(pkg) {
  head('cordis.patch.yml');
  const declared = pkg && pkg.dsh && pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string'
    ? pkg.dsh.bundle.patch
    : './cordis.patch.yml';
  const safe = checkSubpath(declared, 'dsh.bundle.patch');
  const rel = safe.ok ? safe.norm : 'cordis.patch.yml';
  const read = readText(rel);
  if (!read.ok) {
    fail('cordis.patch.yml exists', `${read.error}: ${path.join(opts.root, rel)}`);
    return;
  }
  ok('cordis.patch.yml exists', rel);

  let doc;
  try {
    doc = parseYaml(read.text);
  } catch (error) {
    fail('cordis.patch.yml parses (YAML subset)', error.message);
    return;
  }
  if (!Array.isArray(doc)) {
    fail('patch top level is an array', `got ${doc === null ? 'empty document' : Array.isArray(doc) ? 'array' : typeof doc}`);
    return;
  }
  ok('patch top level is an array', `${doc.length} row${doc.length === 1 ? '' : 's'}`);
  if (!doc.length) {
    fail('patch has rows', 'the patch is an empty array');
    return;
  }

  const insertRows = [];
  const ids = new Map();
  for (let index = 0; index < doc.length; index += 1) {
    const row = doc[index];
    const where = `row ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail(`${where} is an object`, `got ${JSON.stringify(row)}`);
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!KNOWN_TOP_LEVEL_PATCH_KEYS.has(key)) warn(`${where} key "${key}"`, 'not a documented patch operation (insert/override/group/disabled/isolate)');
    }
    if (!('insert' in row)) continue;
    const insert = row.insert;
    if (!Array.isArray(insert) || insert.length === 0) {
      fail(`${where}.insert is a non-empty array`, 'expected a list of plugin rows');
      continue;
    }
    for (let j = 0; j < insert.length; j += 1) {
      const entry = insert[j];
      const entryWhere = `${where}.insert[${j}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        fail(`${entryWhere} is an object`, `got ${JSON.stringify(entry)}`);
        continue;
      }
      const id = entry.id;
      if (typeof id !== 'string' || !id.trim()) {
        fail(`${entryWhere}.id`, 'missing or empty');
        continue;
      }
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
        warn(`${entryWhere}.id looks like a Loader id`, `${JSON.stringify(id)}; prefer lowercase kebab/dot ids`);
      }
      if (ids.has(id)) fail(`${entryWhere}.id is unique`, `duplicate id "${id}" also used by ${ids.get(id)}`);
      else ids.set(id, entryWhere);
      const name = entry.name;
      if (typeof name !== 'string' || !name.trim()) {
        fail(`${entryWhere}.name`, 'missing or empty');
        continue;
      }
      if (name !== pkg?.name) {
        fail(`${entryWhere}.name matches package name`, `patch says ${JSON.stringify(name)}, package.json says ${JSON.stringify(pkg?.name ?? '(unknown)')}`);
      } else {
        ok(`${entryWhere}.name matches package name`, name);
      }
      if (entry.config !== undefined && entry.config !== null && typeof entry.config !== 'object') {
        fail(`${entryWhere}.config is a mapping`, `got ${JSON.stringify(entry.config)}`);
      }
      insertRows.push({ where: entryWhere, id, name });
    }
  }

  if (!insertRows.length) {
    fail('patch inserts a plugin row', 'no row with an "insert" array carrying id + name was found');
    return;
  }
  if (pkg && typeof pkg.name === 'string') {
    const matches = insertRows.filter((row) => row.name === pkg.name);
    if (!matches.length) {
      fail('patch inserts the bundle package', `no insert row names ${JSON.stringify(pkg.name)}`);
    } else {
      ok('patch inserts the bundle package', matches.map((row) => row.id).join(', '));
    }
  }
  if (insertRows.length > 1) {
    ok('patch has multiple insert rows', `${insertRows.length} rows (id: ${insertRows.map((row) => row.id).join(', ')})`);
  }
}

// ---------------------------------------------------------------------------
// Section: locale files
// ---------------------------------------------------------------------------

function flattenKeys(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenKeys(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (prefix) {
    out.push(prefix);
  }
  return out;
}

function checkLocales() {
  head('locale/*.json');
  const files = listLocaleFiles();
  if (!files.length) {
    fail('locale/*.json exists', `no locale/*.json files under ${path.join(opts.root, 'locale')}`);
    return;
  }
  const parsed = new Map();
  const seenLanguages = new Map();
  for (const file of files) {
    const rel = `locale/${file}`;
    const json = readJson(rel);
    if (!json.ok) { fail(`${rel} parses as JSON`, json.error); continue; }
    if (!json.value || typeof json.value !== 'object' || Array.isArray(json.value)) {
      fail(`${rel} root is an object`, 'expected {"meta": {"title": ..., "description": ...}}');
      continue;
    }
    parsed.set(file, json.value);
    ok(`${rel} parses as JSON`);
    // The host discovers locales by filename and rejects duplicates/labels
    // (dsh-app-boot dictionariesOf: LANGUAGE_ID and lowercase id de-duplication).
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*\.json$/.test(file)) {
      fail(`${rel} locale filename`, 'the host requires a language id filename such as en.json or zh-CN.json');
    }
    const language = file.slice(0, -'.json'.length).toLowerCase();
    if (seenLanguages.has(language)) {
      fail(`${rel} locale id is unique`, `duplicate locale "${language}" (also ${seenLanguages.get(language)}); the host rejects duplicate locale ids`);
    } else {
      seenLanguages.set(language, rel);
    }
    const meta = json.value.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      const flat = Object.keys(json.value).filter((key) => key === 'meta.title' || key === 'meta.description');
      fail(`${rel} has a nested "meta" object`, flat.length
        ? `found flat keys ${flat.join(', ')} instead. The host reads locale JSON as parsed.meta.title / parsed.meta.description (dsh-app-boot readPluginMeta), so flat dotted keys are ignored and the plugin row falls back to package.json name/description. Keep the flat UI keys and add {"meta": {"title": "", "description": ""}}.`
        : 'expected {"meta": {"title": ..., "description": ...}}; nested meta is what the host reads for plugin display metadata');
      continue;
    }
    for (const field of ['title', 'description']) {
      const value = meta[field];
      if (typeof value !== 'string' || !value.trim()) {
        fail(`${rel} meta.${field} is a non-empty string`, `got ${JSON.stringify(value)}`);
      } else if (/\bmy decoration\b/i.test(value)) {
        fail(`${rel} meta.${field} describes this plugin`, 'template copy was not replaced');
      } else {
        ok(`${rel} meta.${field}`, JSON.stringify(value.trim()));
      }
    }
  }
  if (!files.includes('en.json')) {
    fail('locale/en.json exists', 'the default locale must be en.json');
  }
  if (parsed.size < 2) {
    warn('locale coverage', 'only one locale supplied; add the user locale (e.g. zh.json)');
  }

  const entries = [...parsed.entries()];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [nameA, jsonA] = entries[i];
      const [nameB, jsonB] = entries[j];
      const keysA = flattenKeys(jsonA).sort();
      const keysB = flattenKeys(jsonB).sort();
      const onlyA = keysA.filter((key) => !keysB.includes(key));
      const onlyB = keysB.filter((key) => !keysA.includes(key));
      if (onlyA.length || onlyB.length) {
        fail(`locale key sets match (${nameA} vs ${nameB})`, [
          onlyA.length ? `${nameA} only: ${onlyA.join(', ')}` : '',
          onlyB.length ? `${nameB} only: ${onlyB.join(', ')}` : '',
        ].filter(Boolean).join('; '));
      } else {
        ok(`locale key sets match (${nameA} vs ${nameB})`, `${keysA.length} keys`);
      }
      const titleA = typeof jsonA.meta?.title === 'string' ? jsonA.meta.title.trim() : '';
      const titleB = typeof jsonB.meta?.title === 'string' ? jsonB.meta.title.trim() : '';
      const descA = typeof jsonA.meta?.description === 'string' ? jsonA.meta.description.trim() : '';
      const descB = typeof jsonB.meta?.description === 'string' ? jsonB.meta.description.trim() : '';
      if (titleA && titleA === titleB && descA === descB) {
        fail(`locale text differs (${nameA} vs ${nameB})`, 'meta.title and meta.description are identical; translate them per locale');
      } else if (titleA && titleA === titleB) {
        warn(`locale title differs (${nameA} vs ${nameB})`, 'identical meta.title; only fine for a brand name');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Section: icon
// ---------------------------------------------------------------------------

function resolveIcon(pkg) {
  if (pkg && typeof pkg.icon === 'string') return { rel: pkg.icon, source: 'package.json "icon"' };
  const target = exportTarget(pkg?.exports, './icon');
  if (target) return { rel: target, source: 'exports["./icon"]' };
  return { rel: 'icon.svg', source: 'conventional icon.svg' };
}

function checkIcon(pkg) {
  head('icon');
  const { rel, source } = resolveIcon(pkg);
  const safe = checkSubpath(rel, 'icon path');
  if (!safe.ok) { fail('icon path is package-relative', safe.reason); return; }
  const info = inspect(safe.norm);
  if (!info.exists) {
    fail('icon exists', `missing file: ${safe.norm} (${source})`);
    return;
  }
  if (!info.file) { fail('icon is a regular file', `${safe.norm} is not a file`); return; }
  if (info.symlink) {
    try {
      const real = fs.realpathSync(toFsPath(safe.norm));
      const rootReal = fs.realpathSync(opts.root);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        fail('icon symlink stays inside the package', `${safe.norm} -> ${real}`);
      } else {
        warn('icon is a symlink', `${safe.norm} -> ${real}`);
      }
    } catch (error) {
      fail('icon symlink resolves', error.message);
    }
  }
  ok('icon exists', `${safe.norm} (${source})`);
  if (info.size > LIMITS.iconBytes) {
    fail('icon size <= 256 KiB', `${info.size} bytes (limit ${LIMITS.iconBytes})`);
  } else {
    ok('icon size <= 256 KiB', `${info.size} bytes`);
  }

  const ext = path.extname(safe.norm).toLowerCase();
  const allowed = { '.svg': 'svg', '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };
  const format = allowed[ext];
  if (!format) {
    fail('icon format is supported', `got "${ext}"; expected .svg, .png, .jpg/.jpeg or .webp`);
    return;
  }
  if (format === 'svg') checkSvgIcon(safe.norm);
  else checkBinaryIcon(safe.norm, format);
}

function checkSvgIcon(rel) {
  const read = readText(rel);
  if (!read.ok) { fail('icon is readable', read.error); return; }
  const text = read.text.replace(/^\uFEFF/, '');
  const prologue = /^(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i.exec(text)[0];
  if (!/^\s*<svg[\s>]/i.test(text.slice(prologue.length))) {
    fail('icon is an SVG document', 'after the optional XML prologue, the first element must be <svg>');
    return;
  }
  ok('icon is an SVG document');
  const viewBox = /viewBox\s*=\s*["']([^"']+)["']/.exec(text);
  if (!viewBox) {
    fail('icon declares viewBox', 'add viewBox="0 0 <w> <h>" so the icon scales');
  } else {
    const tokens = viewBox[1].trim().split(/[\s,]+/).filter(Boolean);
    const numbers = tokens.map(Number);
    if (tokens.length !== 4 || numbers.some((value) => !Number.isFinite(value)) || numbers[2] <= 0 || numbers[3] <= 0) {
      fail('icon viewBox has 4 positive numbers', `got ${JSON.stringify(viewBox[1])}`);
    } else {
      ok('icon declares viewBox', viewBox[1]);
    }
  }
  if (!/<\/svg>\s*$/i.test(text)) warn('icon closes </svg>', 'document does not end with </svg>');
  if (/<script[\s>]/i.test(text)) fail('icon has no <script>', 'SVG icons must not contain scripts');
  if (/(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/)/i.test(text)) {
    fail('icon has no external references', 'inline the artwork; no http(s) hrefs');
  }
  for (const attr of ['width', 'height']) {
    const found = new RegExp(`${attr}\\s*=\\s*["']\\s*([^"']+)`, 'i').exec(text);
    if (found && /^\d+(\.\d+)?(px)?$/.test(found[1].trim())) {
      const value = Number.parseFloat(found[1]);
      if (value > 1024) warn(`icon ${attr}`, `${found[1]} is large; the panel renders small icons`);
    }
  }
}

function checkBinaryIcon(rel, format) {
  let bytes;
  try { bytes = fs.readFileSync(toFsPath(rel)); } catch (error) {
    fail('icon is readable', error.message);
    return;
  }
  const magic = {
    png: bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
    jpeg: bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    webp: bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
  }[format];
  if (!magic) fail(`icon bytes are valid ${format.toUpperCase()}`, 'file extension and magic bytes disagree');
  else ok(`icon bytes are valid ${format.toUpperCase()}`);
}

// ---------------------------------------------------------------------------
// Section: client.js
// ---------------------------------------------------------------------------

function checkClient(pkg) {
  head('client.js (browser module)');
  const declared = exportTarget(pkg?.exports, './client');
  const safe = checkSubpath(declared || './client.js', 'exports["./client"]');
  const rel = safe.ok ? safe.norm : 'client.js';
  const read = readText(rel);
  if (!read.ok) {
    fail('client.js exists', `${read.error}: ${path.join(opts.root, rel)} (referenced by exports["./client"])`);
    return;
  }
  const text = read.text;
  ok('client.js exists', `${rel} (${text.length} bytes)`);
  const body = text.replace(/^\uFEFF/, '');
  const trimmedStart = body.replace(/^\s+/, '');

  // 1. Loader call framing. The browser module loader queues any executed
  //    window.__ModuleLoader__.load({...}) call, so a leading banner comment
  //    (generated artifacts usually carry one) is fine.
  let afterComments = body;
  for (;;) {
    const before = afterComments;
    afterComments = afterComments.replace(/^\s+/, '');
    if (afterComments.startsWith('//')) {
      afterComments = afterComments.replace(/^\/\/[^\n]*(?:\n|$)/, '');
    } else if (afterComments.startsWith('/*')) {
      const end = afterComments.indexOf('*/');
      if (end === -1) break;
      afterComments = afterComments.slice(end + 2);
    }
    if (afterComments === before) break;
  }
  if (!afterComments.startsWith('window.__ModuleLoader__.load({')) {
    fail('first statement is window.__ModuleLoader__.load({', `found: ${JSON.stringify(afterComments.slice(0, 60))}`);
  } else if (afterComments !== trimmedStart) {
    ok('first statement is window.__ModuleLoader__.load({', 'preceded by a comment banner');
  } else {
    ok('first statement is window.__ModuleLoader__.load({');
  }
  if (!/\}\)\s*;?\s*$/.test(body)) {
    warn('ends with })', `last 40 chars: ${JSON.stringify(trimmedStart.slice(-40))}`);
  }

  // 2. id equals package name
  const idMatch = /window\.__ModuleLoader__\.load\(\s*\{[\s\S]{0,600}?\bid\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/.exec(body);
  if (!idMatch) {
    fail('loader object has a string id', 'expected id: "<package name>" inside the load({ ... }) object');
  } else {
    const id = idMatch[1] ?? idMatch[2] ?? idMatch[3];
    if (pkg && typeof pkg.name === 'string' && id !== pkg.name) {
      fail('loader id equals package name', `client.js has ${JSON.stringify(id)}, package.json has ${JSON.stringify(pkg.name)}`);
    } else {
      ok('loader id equals package name', id);
    }
  }

  // 3. factory(require)
  const factoryForms = [
    /\bfactory\s*\(\s*require\s*\)/,                              // method shorthand
    /\bfactory\s*:\s*(?:async\s+)?function\s*\(\s*require\s*\)/,   // function expression
    /\bfactory\s*:\s*(?:async\s*)?\(\s*require\s*\)\s*=>/,        // arrow
    /\bfactory\s*:\s*require\s*=>/,                               // bare arrow parameter
  ];
  if (!factoryForms.some((re) => re.test(body))) {
    fail('has a factory(require) function', 'the loader expects factory(require) { ... }');
  } else {
    ok('has a factory(require) function');
  }

  // 4. no ESM statements + delimiter balance on sanitized source
  const sanitized = sanitizeSource(body);
  const importRe = /(?:^|[;{}\n])\s*import\s*(?=[\w$*{'"`]|\/)/m;
  const exportRe = /(?:^|[;{}\n])\s*export\s+(?:default|const|let|var|function|class|async|\{|\*)/m;
  const importMatch = importRe.exec(sanitized);
  if (importMatch) {
    fail('contains no ESM import statement', `line ${lineOf(sanitized, importMatch.index + importMatch[0].length - 1)}; the browser module is a classic script`);
  } else {
    ok('contains no ESM import statement');
  }
  const exportMatch = exportRe.exec(sanitized);
  if (exportMatch) {
    fail('contains no ESM export statement', `line ${lineOf(sanitized, exportMatch.index + 1)}; return an object from factory() instead`);
  } else {
    ok('contains no ESM export statement');
  }
  const delimiterError = findDelimiterError(sanitized);
  if (delimiterError) {
    fail('delimiters are balanced', `${delimiterError.message} at line ${lineOf(sanitized, delimiterError.index)}`);
  } else {
    ok('delimiters are balanced', '(), [], {}');
  }

  // 5. node --check (classic-script mode, via stdin so no temp files)
  const check = nodeCheck(text, 'cjs');
  if (!check.ok) {
    fail('node --check passes (classic script)', indentDetail(check.detail));
  } else {
    ok('node --check passes (classic script)');
  }

  // 6. required modules vs dsh.client.external
  const requires = new Set();
  const requireRe = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
  let req;
  while ((req = requireRe.exec(body))) requires.add(req[2]);
  const external = Array.isArray(pkg?.dsh?.client?.external) ? pkg.dsh.client.external : [];
  const undeclared = [...requires].filter((name) => !BASELINE_CLIENT_MODULES.has(name) && !external.includes(name));
  if (undeclared.length) {
    warn('non-baseline requires are declared in dsh.client.external', undeclared.join(', '));
  } else if (requires.size) {
    ok('runtime requires are baseline or declared', [...requires].join(', '));
  }
}

// ---------------------------------------------------------------------------
// Section: host index.js
// ---------------------------------------------------------------------------

function checkHost(pkg) {
  head('index.js (host entry)');
  const declared = exportTarget(pkg?.exports, '.');
  const safe = checkSubpath(declared || './index.js', 'exports["."]');
  const rel = safe.ok ? safe.norm : 'index.js';
  const read = readText(rel);
  if (!read.ok) {
    fail('index.js exists', `${read.error}: ${path.join(opts.root, rel)} (referenced by exports["."])`);
    return;
  }
  const text = read.text;
  ok('index.js exists', `${rel} (${text.length} bytes)`);

  const applyForms = [
    /export\s+(?:async\s+)?function\s+apply\s*\(/,
    /export\s+(?:const|let|var)\s+apply\s*=/,
    /export\s*\{[^}]*\bapply\b[^}]*\}/,
  ];
  if (!applyForms.some((re) => re.test(text))) {
    if (/export\s+default\s+class/.test(text)) {
      fail('exports apply()', 'found "export default class" (a documented alternative form, but this bundle expects "export function apply(ctx, config)")');
    } else {
      fail('exports apply()', 'expected "export function apply(ctx, config) {}"');
    }
  } else {
    ok('exports apply()');
  }

  const sanitized = sanitizeSource(text);
  const hits = [];
  for (const name of BROWSER_GLOBALS) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let match;
    while ((match = re.exec(sanitized))) {
      hits.push(`${name} (line ${lineOf(sanitized, match.index)})`);
      if (hits.length >= LIMITS.maxReportedMatches) break;
    }
    if (hits.length >= LIMITS.maxReportedMatches) break;
  }
  if (hits.length) {
    fail('has no browser-only globals', hits.join(', '));
  } else {
    ok('has no browser-only globals');
  }

  const check = nodeCheck(text, 'esm');
  if (!check.ok) fail('node --check passes (ES module)', indentDetail(check.detail));
  else ok('node --check passes (ES module)');

  const badBareImports = [];
  const importRe = /^\s*import\s+(?:[^'"]*?\sfrom\s+)?(['"])([^'"]+)\1/gm;
  let match;
  while ((match = importRe.exec(text))) {
    const spec = match[2];
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    badBareImports.push(spec);
  }
  if (badBareImports.length) {
    warn('host imports only relative or node: modules', `bare specifiers need real dependencies: ${[...new Set(badBareImports)].join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Section: optional build script
// ---------------------------------------------------------------------------

function checkBuildScript() {
  head('build.mjs (optional generator)');
  const info = inspect('build.mjs');
  if (!info.exists) {
    skip('build.mjs', 'not present (selfcheck.sh will skip the build step)');
    return;
  }
  ok('build.mjs exists');
  const read = readText('build.mjs');
  if (!read.ok) { fail('build.mjs is readable', read.error); return; }
  const check = nodeCheck(read.text, 'esm');
  if (!check.ok) fail('build.mjs passes node --check (ES module)', indentDetail(check.detail));
  else ok('build.mjs passes node --check (ES module)');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function indentDetail(text) {
  return String(text).split('\n').map((line) => line.trim()).filter(Boolean).join(' | ').slice(0, 600);
}

function printSummary() {
  const { pass, fail: failures, warn: warnings, skip: skipped } = report;
  if (opts.json) {
    console.log(JSON.stringify({
      root: opts.root,
      ok: failures === 0,
      counts: { pass, fail: failures, warn: warnings, skip: skipped },
      failures: report.failures,
      warnings: report.warnings,
      results: report.results,
    }, null, 2));
    return;
  }
  console.log('');
  if (failures > 0) {
    console.log(paint('31', `RESULT: FAIL — ${failures} error(s), ${warnings} warning(s), ${pass} passed, ${skipped} skipped`));
    console.log('');
    console.log('Errors to fix:');
    for (const item of report.failures) console.log(`  - ${item}`);
  } else {
    console.log(paint('32', `RESULT: PASS — ${pass} checks passed, ${warnings} warning(s), ${skipped} skipped`));
  }
  if (warnings > 0 && !opts.quiet) {
    console.log('');
    console.log('Warnings (not fatal):');
    for (const item of report.warnings) console.log(`  - ${item}`);
  }
}

function main() {
  const rootInfo = inspect('.');
  if (!rootInfo.exists) {
    console.error(`validate.mjs: bundle directory not found: ${opts.root}`);
    process.exit(2);
  }
  try {
    if (!fs.statSync(opts.root).isDirectory()) {
      console.error(`validate.mjs: not a directory: ${opts.root}`);
      process.exit(2);
    }
  } catch (error) {
    console.error(`validate.mjs: cannot access ${opts.root}: ${error.message}`);
    process.exit(2);
  }

  if (!opts.json && !opts.quiet) {
    console.log(`Validating annotation bundle: ${opts.root}`);
    console.log('Offline only — no network, no installs, no plugin activation.');
  }

  const sections = [];
  const pkg = (() => {
    try { return checkPackageJson(); } catch (error) { fail('package.json section', `validator error: ${error.message}`); return null; }
  })();
  sections.push(['cordis.patch.yml', () => checkPatch(pkg)]);
  sections.push(['locale/*.json', checkLocales]);
  sections.push(['icon', () => checkIcon(pkg)]);
  sections.push(['client.js', () => checkClient(pkg)]);
  sections.push(['index.js', () => checkHost(pkg)]);
  sections.push(['build.mjs', checkBuildScript]);

  for (const [name, fn] of sections) {
    try {
      fn();
    } catch (error) {
      fail(`${name} section`, `validator error: ${error && error.stack ? error.message : String(error)}`);
    }
  }

  printSummary();
  process.exitCode = report.fail > 0 ? 1 : 0;
}

main();
