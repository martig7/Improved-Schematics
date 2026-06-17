import { readFileSync, writeFileSync } from "fs";
import { Resvg } from "@resvg/resvg-js";
let svg = readFileSync("dev/out-sea-smooth.svg", "utf-8");
const crops: Array<[string, string]> = [
  ["dev/_hp-a.png", "850 650 320 320"],   // around L loop apex (946,777)
  ["dev/_hp-b.png", "1050 550 320 320"],  // around B/2 loop (1165,655)
  ["dev/_hp-c.png", "880 1050 320 320"],  // around E/D loop (980,1150)
];
for (const [out, vb] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: "width", value: 900 } }).render().asPng());
  console.log(out);
}
