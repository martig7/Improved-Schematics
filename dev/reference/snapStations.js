function snapStations(_0x4fed9e) {
  const _0x255520 = _0x109c, _0x1bb9fd = /* @__PURE__ */ new Map();
  if (_0x4fed9e["nodes"]["size"] === 0) return _0x1bb9fd;
  let _0x1b7d72 = Infinity, _0xdcd199 = Infinity, _0x1535a9 = -Infinity, _0x5b7022 = -Infinity;
  for (const _0x26dd51 of _0x4fed9e["nodes"]["values"]()) {
    if (_0x26dd51["pos"][0] < _0x1b7d72) _0x1b7d72 = _0x26dd51["pos"][0];
    if (_0x26dd51["pos"][0] > _0x1535a9) _0x1535a9 = _0x26dd51["pos"][0];
    if (_0x26dd51["pos"][1] < _0xdcd199) _0xdcd199 = _0x26dd51["pos"][1];
    if (_0x26dd51["pos"][1] > _0x5b7022) _0x5b7022 = _0x26dd51["pos"][1];
  }
  const _0x5d9df7 = [];
  for (const _0x5ea339 of _0x4fed9e["edges"]) {
    const _0x41c798 = _0x4fed9e["nodes"]["get"](_0x5ea339["from"])["pos"], _0x238911 = _0x4fed9e["nodes"]["get"](_0x5ea339["to"])["pos"];
    _0x5d9df7["push"](Math["hypot"](_0x41c798[0] - _0x238911[0], _0x41c798[1] - _0x238911[1]));
  }
  _0x5d9df7["sort"]((_0x2289c3, _0x591b76) => _0x2289c3 - _0x591b76);
  const _0x3bdb94 = _0x5d9df7["length"] > 0 ? _0x5d9df7[Math["floor"](_0x5d9df7["length"] / 2)] : 1, _0x1f3d98 = Math["max"](1, _0x3bdb94 / STEP_SIZE), _0x46feb6 = /* @__PURE__ */ new Map();
  for (const [_0x173247, _0x503e41] of _0x4fed9e["nodes"]) {
    const _0x4dfbaa = Math["round"]((_0x503e41["pos"][0] - _0x1b7d72) / _0x1f3d98), _0x5e53e4 = Math["round"]((_0x503e41["pos"][1] - _0xdcd199) / _0x1f3d98);
    _0x46feb6["set"](_0x173247, [_0x4dfbaa, _0x5e53e4]);
  }
  const _0x38d011 = [..._0x4fed9e["nodes"]["keys"]()]["sort"]((_0x2e915a, _0x1fb547) => {
    const _0x432185 = _0x255520, _0x4e6c1f = _0x4fed9e["adj"]["get"](_0x2e915a)?.["length"] ?? 0, _0x152c5d = _0x4fed9e["adj"]["get"](_0x1fb547)?.["length"] ?? 0;
    if (_0x152c5d !== _0x4e6c1f) return _0x152c5d - _0x4e6c1f;
    return _0x2e915a["localeCompare"](_0x1fb547);
  }), _0x2dc3f2 = /* @__PURE__ */ new Map();
  for (const _0x2b2aa5 of _0x38d011) {
    const _0x4ef859 = _0x46feb6["get"](_0x2b2aa5);
    _0x1bb9fd["set"](_0x2b2aa5, findFreeCell(_0x4ef859, _0x2b2aa5, _0x2dc3f2));
  }
  return _0x1bb9fd;
}