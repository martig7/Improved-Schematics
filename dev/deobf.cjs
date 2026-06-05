/**
 * dev/deobf.cjs — recover readable reference source for the game's schematic engine.
 *
 * The game bundle (GameMain) is obfuscated with javascript-obfuscator's string-array
 * transform: literals are replaced by `decoder(index)` calls, where each decoder reads
 * `array[index - offset]` from a runtime-shuffled array. There are no sourcemaps.
 *
 * This script:
 *   1. Extracts each (arrayFn, decoder, shuffler IIFE) group and evaluates them in a VM
 *      sandbox so the shuffle runs and the decoders return correct strings.
 *   2. Builds an alias->decoder map (each scope does `const _0xAAAA = _0xDECODER`).
 *   3. Globally rewrites every `decoder(idx)` / `alias(idx)` call to its string literal.
 *   4. Dumps the rewritten bodies of the target functions + key constants to dev/reference/.
 *
 * Output is a porting reference only — not shipped. Re-run if the game updates.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAME = process.env.SB_GAME || 'C:/Users/darkd/AppData/Local/Temp/sbgame/GameMain-jqOSDAiD.js';
const OUT_DIR = path.join(__dirname, 'reference');
const src = fs.readFileSync(GAME, 'utf8');

// decoder -> array fn (offsets are encoded inside the decoder; we just run them).
const GROUPS = [
  { dec: '_0xee17', arr: '_0x5544' },
  { dec: '_0x109c', arr: '_0x315c' },
  { dec: '_0x42e2', arr: '_0x33e4' },
  { dec: '_0x5e27', arr: '_0x425a' },
  { dec: '_0x37b9', arr: '_0x5d26' },
  { dec: '_0x3e12', arr: '_0x4cea' },
];

// --- brace/paren matcher that respects strings and template literals ---
function matchDelims(str, openIdx, open, close) {
  let depth = 0, i = openIdx;
  let inStr = null; // "'", '"', '`'
  let tmplBraceDepth = []; // stack of ${ } depths for template literals
  for (; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (inStr === '`' && c === '$' && str[i + 1] === '{') { tmplBraceDepth.push(0); inStr = null; i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') { if (tmplBraceDepth.length) tmplBraceDepth[tmplBraceDepth.length - 1]++; if (c === open) depth++; continue; }
    if (c === '}') {
      if (tmplBraceDepth.length && tmplBraceDepth[tmplBraceDepth.length - 1] > 0) { tmplBraceDepth[tmplBraceDepth.length - 1]--; if (close === '}') { /* not a real close */ } continue; }
      if (tmplBraceDepth.length && tmplBraceDepth[tmplBraceDepth.length - 1] === 0) { tmplBraceDepth.pop(); inStr = '`'; continue; }
      if (close === '}') { depth--; if (depth === 0) return i; }
      continue;
    }
    if (c === open && (open === '(' )) { depth++; continue; }
    if (c === close && close === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function extractFn(name) {
  const sig = 'function ' + name + '(';
  const at = src.indexOf(sig);
  if (at < 0) return null;
  const parenOpen = at + sig.length - 1;
  const parenClose = matchDelims(src, parenOpen, '(', ')');
  const braceOpen = src.indexOf('{', parenClose);
  const braceClose = matchDelims(src, braceOpen, '{', '}');
  return src.slice(at, braceClose + 1);
}

// Find the shuffler IIFE for an array fn: `(function(...){...}(_0xARR, NUM));`
function extractShuffler(arrName) {
  const callSite = src.indexOf('(' + arrName + ',');
  if (callSite < 0) return null;
  // walk back to the `(function` that begins this IIFE
  const start = src.lastIndexOf('(function', callSite);
  // the IIFE ends at the `));` shortly after callSite
  const end = src.indexOf(';', callSite);
  return src.slice(start, end + 1);
}

// --- build sandbox with all decoders evaluated ---
let bootstrap = '';
for (const g of GROUPS) {
  const arrFn = extractFn(g.arr);
  const decFn = extractFn(g.dec);
  const shuffler = extractShuffler(g.arr);
  if (!arrFn || !decFn) throw new Error('missing ' + g.arr + '/' + g.dec);
  bootstrap += arrFn + '\n' + decFn + '\n' + (shuffler || '') + '\n';
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(bootstrap + '\nthis.__dec = {' + GROUPS.map(g => g.dec + ':' + g.dec).join(',') + '};', sandbox);
const decoders = sandbox.__dec;

// --- alias -> decoder map: `const _0xAAAA = _0xDECODER` (also bare decoder calls) ---
const aliasMap = {};
for (const g of GROUPS) aliasMap[g.dec] = g.dec;
const aliasRe = new RegExp('(_0x[0-9a-f]{4,8})\\s*=\\s*(' + GROUPS.map(g => g.dec).join('|') + ')\\b', 'g');
let m;
while ((m = aliasRe.exec(src))) aliasMap[m[1]] = m[2];

function resolveCalls(code) {
  // replace alias(idx) and alias(idx, key) with the decoded string literal
  const callRe = /(_0x[0-9a-f]{4,8})\((\d+)(?:\s*,\s*[^)]*)?\)/g;
  return code.replace(callRe, (full, fn, idx) => {
    const dec = aliasMap[fn];
    if (!dec || !decoders[dec]) return full;
    const val = decoders[dec](Number(idx));
    if (typeof val !== 'string') return full;
    return JSON.stringify(val);
  });
}

// --- dump target functions + constants ---
fs.mkdirSync(OUT_DIR, { recursive: true });

const FUNCS = [
  'buildTransitGraph', 'walkRouteVisits', 'normalizeColor', 'edgeKey$1', 'projectFactory',
  'octilinearDistance', 'findFreeCell', 'snapStations', 'rebuildLayoutFromCells', 'octilinearLayout',
  'orderEdgesByImportance', 'routeEdge',
  'nearestOctilinearUnit', 'simplifyLayout',
  'orderLines',
  'renderSvg', 'computeCanonicalOffsets', 'offsetPolyline', 'renderStops', 'placeLabels', 'renderLabel',
  'gridToPx',
];

// Arrow / expression consts: `const NAME = <expr up to the ; at depth 0>`
function extractConst(name) {
  const re = new RegExp('(?:const|let|var)\\s+' + name.replace('$', '\\$') + '\\s*=');
  const at = src.search(re);
  if (at < 0) return null;
  const eq = src.indexOf('=', at);
  // find terminating ; that is not inside (), {}, [], or strings
  let i = eq + 1, depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) break;
  }
  return src.slice(at, i + 1);
}

const ARROW_CONSTS = ['cellKey', 'cellKeyOf', 'edgeKey', 'escapeXml'];

const missing = [];
for (const fn of FUNCS) {
  const body = extractFn(fn);
  if (!body) { missing.push(fn); continue; }
  fs.writeFileSync(path.join(OUT_DIR, fn.replace(/\$/g, '_') + '.js'), resolveCalls(body), 'utf8');
}
for (const c of ARROW_CONSTS) {
  const body = extractConst(c);
  if (!body) { missing.push(c); continue; }
  fs.writeFileSync(path.join(OUT_DIR, c + '.js'), resolveCalls(body), 'utf8');
}

// constants: grab their declarations from the raw source and resolve
const CONST_NAMES = ['STEP_SIZE', 'TARGET_EDGE_CELLS', 'EDGE_STIFFNESS', 'ITERATIONS', 'OCT_UNIT', 'OCT_DIRS', 'CELL_PX', 'PAD', 'LINE_WIDTH'];
let constOut = '';
for (const c of CONST_NAMES) {
  const re = new RegExp('(?:const|let|var)\\s+' + c.replace('$', '\\$') + '\\s*=\\s*([^;]+);');
  const mm = src.match(re);
  constOut += c + ' = ' + (mm ? resolveCalls(mm[1]).trim() : '??? NOT FOUND') + '\n';
}
fs.writeFileSync(path.join(OUT_DIR, '_constants.txt'), constOut, 'utf8');

console.log('Resolved decoders:', Object.keys(decoders).join(', '));
console.log('Alias map entries:', Object.keys(aliasMap).length);
console.log('Dumped functions:', FUNCS.length - missing.length, '/', FUNCS.length);
if (missing.length) console.log('MISSING:', missing.join(', '));
console.log('\n--- constants ---\n' + constOut);
