import { readFileSync, writeFileSync } from "fs";
import { Resvg } from "@resvg/resvg-js";
let svg = readFileSync("dev/out-sea-smooth.svg", "utf-8");
const crops: Array<[string, string]> = [
  ["dev/_hp-spur.png", "870 700 180 180"],
  ["dev/_hp-spur2.png", "880 730 140 140"],
];
for (const [out, vb] of crops) {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`);
  writeFileSync(out, new Resvg(s, { fitTo: { mode: "width", value: 900 } }).render().asPng());
  console.log(out);
}
