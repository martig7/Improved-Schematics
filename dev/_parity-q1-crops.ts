// Throwaway Q1: crops of our render vs LOOM render at window-1 (the conjoined
// blue+pink diagonal) for visual confirmation.
import { readFileSync, writeFileSync } from 'fs';
import { Resvg } from '@resvg/resvg-js';

// ours: window-1 diag (947,1171)-(1147,1462) + margin
{
  let svg = readFileSync('dev/_dump.svg', 'utf-8');
  svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="880 1100 340 420"');
  writeFileSync('dev/_parity-q1-ours-win1.png',
    new Resvg(svg, { fitTo: { mode: 'width', value: 680 }, background: 'white' }).render().asPng());
}
// ours window-2: (1600-1700, 1527)
{
  let svg = readFileSync('dev/_dump.svg', 'utf-8');
  svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="1540 1430 280 200"');
  writeFileSync('dev/_parity-q1-ours-win2.png',
    new Resvg(svg, { fitTo: { mode: 'width', value: 700 }, background: 'white' }).render().asPng());
}
// LOOM: window-1 in LOOM svg px x[2193,3272] y[6629,8320]
{
  let svg = readFileSync('dev/out-loom-sea.svg', 'utf-8');
  svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="2100 6500 1300 2000"');
  writeFileSync('dev/_parity-q1-loom-win1.png',
    new Resvg(svg, { fitTo: { mode: 'width', value: 650 }, background: 'white' }).render().asPng());
}
console.log('wrote dev/_parity-q1-ours-win1.png, dev/_parity-q1-ours-win2.png, dev/_parity-q1-loom-win1.png');
