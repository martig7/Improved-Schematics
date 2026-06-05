function renderSvg(_0x3c3e3d, _0x209c7e = {}) {
  const _0x4df7de = _0xee17, _0x174270 = _0x209c7e["showLabels"] !== ![], _0xe9edbd = _0x209c7e["darkMode"] === !![];
  let _0x26d891 = Infinity, _0x5e97f9 = -Infinity, _0x33e7a6 = Infinity, _0x351e04 = -Infinity;
  const _0x6a49ef = (_0x49bb27) => {
    if (_0x49bb27[0] < _0x26d891) _0x26d891 = _0x49bb27[0];
    if (_0x49bb27[0] > _0x5e97f9) _0x5e97f9 = _0x49bb27[0];
    if (_0x49bb27[1] < _0x33e7a6) _0x33e7a6 = _0x49bb27[1];
    if (_0x49bb27[1] > _0x351e04) _0x351e04 = _0x49bb27[1];
  };
  for (const _0x5243ce of _0x3c3e3d["nodes"]["values"]()) _0x6a49ef(_0x5243ce["cell"]);
  for (const _0x5837dd of _0x3c3e3d["edges"]) for (const _0x407a6a of _0x5837dd["path"]) _0x6a49ef(_0x407a6a);
  if (!isFinite(_0x26d891)) return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"></svg>";
  const _0x37d959 = -_0x26d891, _0x404ac7 = -_0x33e7a6, _0x3557f2 = _0x351e04 + _0x404ac7, _0x3bba45 = (_0x3aa291) => gridToPx([_0x3aa291[0] + _0x37d959, _0x3aa291[1] + _0x404ac7], _0x3557f2), _0x27c872 = (_0x5e97f9 - _0x26d891) * CELL_PX + PAD * 2, _0x2da393 = (_0x351e04 - _0x33e7a6) * CELL_PX + PAD * 2, _0x5690f6 = _0xe9edbd ? "#18181b" : "#ffffff", _0x12ef7d = LINE_WIDTH + 3, _0x533528 = computeCanonicalOffsets(_0x3c3e3d), _0x3d1596 = /* @__PURE__ */ new Map();
  for (const _0x1e3c8e of _0x3c3e3d["nodes"]["values"]()) _0x3d1596["set"](_0x1e3c8e["id"], _0x3bba45(_0x1e3c8e["cell"]));
  const _0x2cf70a = /* @__PURE__ */ new Map(), _0x4393db = /* @__PURE__ */ new Set(), _0x1453df = [], _0x518c41 = new Map(_0x3c3e3d["edges"]["map"]((_0x527731) => [_0x527731["id"], _0x527731])), _0x342da4 = /* @__PURE__ */ new Map();
  for (const _0x43de3e of _0x3c3e3d["edges"]) for (const _0x1433b6 of _0x43de3e["lines"]) if (!_0x342da4["has"](_0x1433b6["id"])) _0x342da4["set"](_0x1433b6["id"], _0x1433b6);
  const _0x462355 = /* @__PURE__ */ new Map(), _0x563540 = (_0xf2fc8, _0x1f39cc) => {
    const _0x4a577a = _0x4df7de, _0x4b72cd = _0xf2fc8["id"] + "|" + _0x1f39cc, _0x367c16 = _0x462355["get"](_0x4b72cd);
    if (_0x367c16) return _0x367c16;
    const _0x5f5d70 = _0x533528["get"](_0x1f39cc) ?? 0, _0x1c42bb = _0xf2fc8["path"]["map"](_0x3bba45), _0x470fac = _0x5f5d70 === 0 ? _0x1c42bb : offsetPolyline(_0x1c42bb, _0x5f5d70);
    return _0x462355["set"](_0x4b72cd, _0x470fac), _0x470fac;
  }, _0x20641c = [], _0x3436f8 = (_0x20dc9b, _0x59245d) => {
    const _0x501332 = _0x59245d ? 0 : _0x20dc9b["length"] - 1, _0x5095e3 = _0x59245d ? 1 : _0x20dc9b["length"] - 2;
    return [_0x20dc9b[_0x501332][0] - _0x20dc9b[_0x5095e3][0], _0x20dc9b[_0x501332][1] - _0x20dc9b[_0x5095e3][1]];
  }, _0x1941a4 = (_0x54d78c, _0x1999fc) => {
    const _0xdb5a5b = _0x4df7de, _0x5b77b2 = _0x1999fc ? _0x54d78c["length"] - 1 : 0, _0x11d314 = _0x1999fc ? _0x54d78c["length"] - 2 : 1;
    return [_0x54d78c[_0x11d314][0] - _0x54d78c[_0x5b77b2][0], _0x54d78c[_0x11d314][1] - _0x54d78c[_0x5b77b2][1]];
  };
  for (const [_0x1ad423, _0x43728d] of _0x3c3e3d["lineTraversals"]) {
    const _0x560dbf = _0x342da4["get"](_0x1ad423);
    if (!_0x560dbf || _0x43728d["length"] === 0) continue;
    const _0x58111c = new Array(_0x43728d["length"])["fill"](![]);
    for (let _0x10d80a = 0; _0x10d80a < _0x43728d["length"] - 1; _0x10d80a++) {
      const _0x541e09 = _0x43728d[_0x10d80a], _0x543add = _0x43728d[_0x10d80a + 1], _0x2c2a86 = _0x518c41["get"](_0x541e09["edgeId"]), _0x4d6eae = _0x518c41["get"](_0x543add["edgeId"]);
      if (!_0x2c2a86 || !_0x4d6eae || _0x2c2a86["path"]["length"] < 2 || _0x4d6eae["path"]["length"] < 2) continue;
      const _0x4c275b = _0x3436f8(_0x2c2a86["path"], _0x541e09["reversed"]), _0x49b3c4 = _0x1941a4(_0x4d6eae["path"], _0x543add["reversed"]);
      if (_0x4c275b[0] !== _0x49b3c4[0] || _0x4c275b[1] !== _0x49b3c4[1]) _0x58111c[_0x10d80a] = !![];
    }
    const _0x16bb06 = [];
    let _0x248220 = null;
    const _0x343b68 = (_0x3c402b) => {
      const _0x286d69 = _0x4df7de;
      if (_0x248220) _0x1453df["push"]({ "p1": _0x248220, "p2": _0x3c402b });
      _0x16bb06["push"]("L" + _0x3c402b[0]["toFixed"](1) + "," + _0x3c402b[1]["toFixed"](1)), _0x248220 = _0x3c402b;
    }, _0x24d263 = (_0x32d4f2) => {
      const _0x122c17 = _0x4df7de;
      _0x16bb06["push"]("M" + _0x32d4f2[0]["toFixed"](1) + "," + _0x32d4f2[1]["toFixed"](1)), _0x248220 = _0x32d4f2;
    }, _0x41cfd6 = (_0xbe497a, _0x4383a0) => {
      const _0x29f1bb = _0x4df7de;
      if (_0x248220) _0x1453df["push"]({ "p1": _0x248220, "p2": _0x4383a0 });
      _0x16bb06["push"]("Q" + _0xbe497a[0]["toFixed"](1) + "," + _0xbe497a[1]["toFixed"](1) + " " + _0x4383a0[0]["toFixed"](1) + "," + _0x4383a0[1]["toFixed"](1)), _0x248220 = _0x4383a0;
    };
    for (let _0x1716f2 = 0; _0x1716f2 < _0x43728d["length"]; _0x1716f2++) {
      const _0x18579d = _0x43728d[_0x1716f2], _0x233917 = _0x518c41["get"](_0x18579d["edgeId"]);
      if (!_0x233917) continue;
      const _0x335b62 = _0x563540(_0x233917, _0x1ad423), _0x1e8412 = _0x18579d["reversed"] ? [..._0x335b62]["reverse"]() : _0x335b62, _0xaaf11f = _0x233917["stops"]["get"](_0x1ad423);
      if (_0xaaf11f) {
        const _0x108b9e = _0x18579d["reversed"] ? _0x233917["to"] : _0x233917["from"], _0x1984a6 = _0x18579d["reversed"] ? _0x233917["from"] : _0x233917["to"], _0x2373e0 = _0x18579d["reversed"] ? _0xaaf11f["atTo"] : _0xaaf11f["atFrom"], _0x41ee74 = _0x18579d["reversed"] ? _0xaaf11f["atFrom"] : _0xaaf11f["atTo"], _0x170033 = _0x1e8412[0], _0xfcf2d8 = _0x1e8412[_0x1e8412["length"] - 1], _0x3b8f89 = (_0x49d710, _0x16ef0d) => {
          const _0x27e5dd = _0x4df7de, _0x4f14f0 = _0x49d710 + "|" + _0x1ad423;
          if (_0x4393db["has"](_0x4f14f0)) return;
          _0x4393db["add"](_0x4f14f0);
          if (!_0x2cf70a["has"](_0x49d710)) _0x2cf70a["set"](_0x49d710, []);
          _0x2cf70a["get"](_0x49d710)["push"]({ "lineId": _0x1ad423, "color": _0x560dbf["color"], "pos": _0x16ef0d });
        };
        if (_0x2373e0) _0x3b8f89(_0x108b9e, _0x170033);
        if (_0x41ee74) _0x3b8f89(_0x1984a6, _0xfcf2d8);
      }
      if (_0x1716f2 === 0) {
        _0x24d263(_0x1e8412[0]);
        for (let _0x4ca96a = 1; _0x4ca96a < _0x1e8412["length"]; _0x4ca96a++) _0x343b68(_0x1e8412[_0x4ca96a]);
      } else {
        if (_0x58111c[_0x1716f2 - 1]) {
          const _0x5b24f8 = _0x18579d["reversed"] ? _0x233917["to"] : _0x233917["from"], _0x3b8fd3 = _0x3d1596["get"](_0x5b24f8);
          if (_0x3b8fd3) _0x41cfd6(_0x3b8fd3, _0x1e8412[0]);
          else _0x343b68(_0x1e8412[0]);
          for (let _0x498e1f = 1; _0x498e1f < _0x1e8412["length"]; _0x498e1f++) _0x343b68(_0x1e8412[_0x498e1f]);
        } else {
          const _0x1350d2 = _0x1e8412[0], _0x25687f = _0x248220 && _0x248220[0] === _0x1350d2[0] && _0x248220[1] === _0x1350d2[1], _0x39311f = _0x25687f ? 1 : 0;
          for (let _0xc4c08a = _0x39311f; _0xc4c08a < _0x1e8412["length"]; _0xc4c08a++) _0x343b68(_0x1e8412[_0xc4c08a]);
        }
      }
    }
    if (_0x16bb06["length"] < 2) continue;
    const _0x11fddd = _0x16bb06["join"](" ");
    _0x20641c["push"]('<path d="' + _0x11fddd + '" fill="none" stroke="' + _0x5690f6 + "\" stroke-width=\"" + _0x12ef7d + "\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"), _0x20641c["push"]("<path d=\"" + _0x11fddd + "\" fill=\"none\" stroke=\"" + escapeXml(_0x560dbf["color"]) + "\" stroke-width=\"" + LINE_WIDTH + '" stroke-linecap="round" stroke-linejoin="round" data-line-id="' + escapeXml(_0x560dbf["id"]) + "\"/>");
  }
  const _0x41171a = renderStops(_0x2cf70a, _0xe9edbd), _0x1a88c3 = _0x174270 ? placeLabels(_0x3c3e3d, _0x3d1596, _0x2cf70a, _0x1453df) : /* @__PURE__ */ new Map(), _0x573d03 = [];
  for (const _0x44f07b of _0x3c3e3d["nodes"]["values"]()) {
    const _0xaafffd = _0x1a88c3["get"](_0x44f07b["id"]);
    if (!_0xaafffd) continue;
    _0x573d03["push"](renderLabel(_0x44f07b, _0xaafffd, _0x2cf70a["has"](_0x44f07b["id"]), _0xe9edbd));
  }
  return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " + _0x27c872 + " " + _0x2da393 + "\" width=\"" + _0x27c872 + '" height="' + _0x2da393 + "\">\n<rect width=\"" + _0x27c872 + "\" height=\"" + _0x2da393 + "\" fill=\"" + _0x5690f6 + "\"/>\n<g class=\"edges\">\n" + _0x20641c["join"]("\n") + "\n</g>\n<g class=\"stops\">\n" + _0x41171a["join"]("\n") + "\n</g>\n<g class=\"stations\">\n" + _0x573d03["join"]("\n") + "\n</g>\n</svg>";
}