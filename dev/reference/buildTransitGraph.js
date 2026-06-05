function buildTransitGraph(_0x14a169, _0x102528, _0x27af4a) {
  const _0x563b13 = _0x5e27;
  if (_0x27af4a["length"] === 0) return { "nodes": /* @__PURE__ */ new Map(), "edges": [], "adj": /* @__PURE__ */ new Map(), "lineTraversals": /* @__PURE__ */ new Map() };
  const _0x344e13 = /* @__PURE__ */ new Map();
  for (const _0x3ce998 of _0x27af4a) {
    for (const _0x30e29f of _0x3ce998["stationIds"]) _0x344e13["set"](_0x30e29f, _0x3ce998["id"]);
  }
  const _0x51783d = /* @__PURE__ */ new Map(), _0x533548 = /* @__PURE__ */ new Map();
  for (const _0x285e46 of _0x14a169) {
    if (_0x285e46["buildType"] !== "constructed") continue;
    const _0xda6f82 = _0x344e13["get"](_0x285e46["id"]);
    if (!_0xda6f82) continue;
    for (const _0x3c0696 of _0x285e46["stNodeIds"]) _0x51783d["set"](_0x3c0696, _0xda6f82);
    for (const _0x4e830c of _0x285e46["trackIds"]) _0x533548["set"](_0x4e830c, _0xda6f82);
  }
  const _0xc2659e = _0x27af4a["reduce"]((_0x363d3e, _0x565478) => _0x363d3e + _0x565478["center"][1], 0), _0x1d8544 = projectFactory(_0xc2659e / _0x27af4a["length"]), _0xc4f416 = /* @__PURE__ */ new Map();
  for (const _0x3136ff of _0x27af4a) {
    const [_0x419c7d, _0x373d93] = _0x3136ff["center"];
    _0xc4f416["set"](_0x3136ff["id"], { "id": _0x3136ff["id"], "label": _0x3136ff["name"], "pos": _0x1d8544(_0x419c7d, _0x373d93), "lngLat": [_0x419c7d, _0x373d93] });
  }
  const _0x8a6526 = /* @__PURE__ */ new Map();
  let _0x72c23 = 0;
  const _0x424d82 = /* @__PURE__ */ new Map();
  for (const _0x278a73 of _0x102528) {
    if (_0x278a73["tempParentId"]) continue;
    const _0x1efdb3 = walkRouteVisits(_0x278a73, _0x51783d, _0x533548), _0x292407 = { "id": _0x278a73["id"], "label": _0x278a73["bullet"] || _0x278a73["id"], "color": normalizeColor(_0x278a73["color"]) }, _0x4451a9 = [];
    for (let _0x57b0ae = 0; _0x57b0ae < _0x1efdb3["length"] - 1; _0x57b0ae++) {
      const _0x5c5889 = _0x1efdb3[_0x57b0ae], _0x315a7b = _0x1efdb3[_0x57b0ae + 1];
      if (_0x5c5889["groupId"] === _0x315a7b["groupId"]) continue;
      const _0x3bd5f7 = edgeKey$1(_0x5c5889["groupId"], _0x315a7b["groupId"]);
      let _0x86dd92 = _0x8a6526["get"](_0x3bd5f7);
      !_0x86dd92 && (_0x86dd92 = { "id": "e" + _0x72c23++, "from": _0x5c5889["groupId"], "to": _0x315a7b["groupId"], "lines": [], "stops": /* @__PURE__ */ new Map() }, _0x8a6526["set"](_0x3bd5f7, _0x86dd92));
      if (!_0x86dd92["lines"]["some"]((_0x1fc667) => _0x1fc667["id"] === _0x292407["id"])) _0x86dd92["lines"]["push"](_0x292407);
      const _0xc40bcb = _0x86dd92["from"] === _0x5c5889["groupId"], _0xb4648f = _0xc40bcb ? _0x5c5889["isStop"] : _0x315a7b["isStop"], _0x5e2dae = _0xc40bcb ? _0x315a7b["isStop"] : _0x5c5889["isStop"], _0x48cd6c = _0x86dd92["stops"]["get"](_0x292407["id"]);
      _0x48cd6c ? (_0x48cd6c["atFrom"] = _0x48cd6c["atFrom"] || _0xb4648f, _0x48cd6c["atTo"] = _0x48cd6c["atTo"] || _0x5e2dae) : _0x86dd92["stops"]["set"](_0x292407["id"], { "atFrom": _0xb4648f, "atTo": _0x5e2dae }), _0x4451a9["push"]({ "edgeId": _0x86dd92["id"], "reversed": !_0xc40bcb });
    }
    if (_0x4451a9["length"] > 0) _0x424d82["set"](_0x292407["id"], _0x4451a9);
  }
  const _0x2b4159 = [..._0x8a6526["values"]()], _0x214f41 = /* @__PURE__ */ new Map();
  for (const _0x368d53 of _0xc4f416["keys"]()) _0x214f41["set"](_0x368d53, []);
  for (const _0x1bf794 of _0x2b4159) {
    _0x214f41["get"](_0x1bf794["from"])["push"](_0x1bf794["id"]), _0x214f41["get"](_0x1bf794["to"])["push"](_0x1bf794["id"]);
  }
  for (const [_0x12cb78, _0x339864] of _0x214f41) {
    _0x339864["length"] === 0 && (_0xc4f416["delete"](_0x12cb78), _0x214f41["delete"](_0x12cb78));
  }
  return { "nodes": _0xc4f416, "edges": _0x2b4159, "adj": _0x214f41, "lineTraversals": _0x424d82 };
}