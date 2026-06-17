// Guard: no two different-color route paths may share a run of identical
// STRAIGHT-segment coordinates in the rendered SVG (one would hide the other
// — zero lane offset). Parses path commands properly: only M/L runs emit
// segments; Q/C curve spans (join fillets, connector S-curves) advance the
// pen without emitting — transitional curve ink may legitimately overlap.
import { readFileSync } from 'fs';

const file = process.argv[2] ?? 'dev/_dump.svg';
const svg = readFileSync(file, 'utf-8');

const re = /<path[^>]*stroke="(#[0-9a-fA-F]{6})"[^>]*\sd="([^"]+)"|<path[^>]*\sd="([^"]+)"[^>]*stroke="(#[0-9a-fA-F]{6})"/g;
const segOwners = new Map<string, Set<string>>();
let m: RegExpExecArray | null;
while ((m = re.exec(svg))) {
  const color = (m[1] ?? m[4])!.toLowerCase();
  if (color === '#ffffff' || color === '#000000') continue; // casing/marker strokes share geometry by design
  const dStr = (m[2] ?? m[3])!;
  const tokens = dStr.match(/[MLQCZz]|-?\d+(?:\.\d+)?/g) ?? [];
  let cur: [number, number] | null = null;
  let i = 0;
  const read = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const tok = tokens[i++];
    if (tok === 'M') {
      cur = [read(), read()];
    } else if (tok === 'L') {
      const next: [number, number] = [read(), read()];
      if (cur) {
        const a = `${Math.round(cur[0] * 2)},${Math.round(cur[1] * 2)}`;
        const b = `${Math.round(next[0] * 2)},${Math.round(next[1] * 2)}`;
        if (a !== b) {
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          let s = segOwners.get(key);
          if (!s) segOwners.set(key, (s = new Set()));
          s.add(color);
        }
      }
      cur = next;
    } else if (tok === 'Q') {
      read(); read(); // control
      cur = [read(), read()];
    } else if (tok === 'C') {
      read(); read(); read(); read(); // controls
      cur = [read(), read()];
    } else if (tok === 'Z' || tok === 'z') {
      // closepath: ignore (route paths never close)
    } else if (cur) {
      // implicit L repetition: bare coordinate pair continues the line
      const next: [number, number] = [Number(tok), read()];
      const a = `${Math.round(cur[0] * 2)},${Math.round(cur[1] * 2)}`;
      const b = `${Math.round(next[0] * 2)},${Math.round(next[1] * 2)}`;
      if (a !== b) {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        let s = segOwners.get(key);
        if (!s) segOwners.set(key, (s = new Set()));
        s.add(color);
      }
      cur = next;
    }
  }
}
let bad = 0;
for (const [key, owners] of segOwners) {
  if (owners.size >= 2) {
    const [a, b] = key.split('|');
    const fmt = (p: string) => p.split(',').map((v) => Number(v) / 2).join(',');
    if (bad < 10) console.log(`OVERDRAW ${fmt(a)}|${fmt(b)} colors=[${[...owners].join(',')}]`);
    bad++;
  }
}
console.log(bad === 0 ? 'OK: no same-coordinate different-color segments' : `FAIL: ${bad} shared segments`);
