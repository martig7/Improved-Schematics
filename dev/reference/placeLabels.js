function placeLabels(_0x253935, _0x42b039, _0x5bbb3d, _0x1b90d2) {
  const _0x5eaad1 = _0xee17, _0x169e91 = /* @__PURE__ */ new Map(), _0x454690 = [], _0x342ab4 = [], _0x505ecf = LINE_WIDTH * 0.7;
  for (const [, _0x44223a] of _0x5bbb3d) {
    if (_0x44223a["length"] === 1) {
      const [_0x2d3698, _0x2a2191] = _0x44223a[0]["pos"];
      _0x342ab4["push"]({ "x": _0x2d3698 - _0x505ecf, "y": _0x2a2191 - _0x505ecf, "w": 2 * _0x505ecf, "h": 2 * _0x505ecf });
    } else {
      let _0x4723dd = Infinity, _0x31224a = -Infinity, _0x3d6653 = Infinity, _0x377bb9 = -Infinity;
      for (const _0x5d8871 of _0x44223a) {
        if (_0x5d8871["pos"][0] < _0x4723dd) _0x4723dd = _0x5d8871["pos"][0];
        if (_0x5d8871["pos"][0] > _0x31224a) _0x31224a = _0x5d8871["pos"][0];
        if (_0x5d8871["pos"][1] < _0x3d6653) _0x3d6653 = _0x5d8871["pos"][1];
        if (_0x5d8871["pos"][1] > _0x377bb9) _0x377bb9 = _0x5d8871["pos"][1];
      }
      _0x342ab4["push"]({ "x": _0x4723dd - _0x505ecf, "y": _0x3d6653 - _0x505ecf, "w": _0x31224a - _0x4723dd + 2 * _0x505ecf, "h": _0x377bb9 - _0x3d6653 + 2 * _0x505ecf });
    }
  }
  const _0x57ee47 = [..._0x253935["nodes"]["values"]()]["filter"]((_0x4794e8) => _0x5bbb3d["has"](_0x4794e8["id"]))["sort"]((_0x503ad2, _0x31bcde) => _0x31bcde["label"]["length"] - _0x503ad2["label"]["length"]);
  for (const _0x32738e of _0x57ee47) {
    const _0x5eba39 = _0x42b039["get"](_0x32738e["id"]);
    if (!_0x5eba39) continue;
    const _0xae1d41 = estimateTextWidth(_0x32738e["label"]), _0x37781e = LABEL_FONT_SIZE + 2, _0x5dbfc9 = LABEL_OFFSET, _0x4a62b1 = [{ "placement": { "x": _0x5eba39[0] + _0x5dbfc9, "y": _0x5eba39[1] + _0x37781e / 3, "anchor": "start" }, "box": { "x": _0x5eba39[0] + _0x5dbfc9, "y": _0x5eba39[1] - _0x37781e / 2, "w": _0xae1d41, "h": _0x37781e }, "priority": 1 }, { "placement": { "x": _0x5eba39[0] - _0x5dbfc9, "y": _0x5eba39[1] + _0x37781e / 3, "anchor": "end" }, "box": { "x": _0x5eba39[0] - _0x5dbfc9 - _0xae1d41, "y": _0x5eba39[1] - _0x37781e / 2, "w": _0xae1d41, "h": _0x37781e }, "priority": 1 }, { "placement": { "x": _0x5eba39[0], "y": _0x5eba39[1] - _0x5dbfc9, "anchor": "middle" }, "box": { "x": _0x5eba39[0] - _0xae1d41 / 2, "y": _0x5eba39[1] - _0x5dbfc9 - _0x37781e, "w": _0xae1d41, "h": _0x37781e }, "priority": 2 }, { "placement": { "x": _0x5eba39[0], "y": _0x5eba39[1] + _0x5dbfc9 + _0x37781e - 2, "anchor": "middle" }, "box": { "x": _0x5eba39[0] - _0xae1d41 / 2, "y": _0x5eba39[1] + _0x5dbfc9, "w": _0xae1d41, "h": _0x37781e }, "priority": 2 }, { "placement": { "x": _0x5eba39[0] + _0x5dbfc9 * 0.7, "y": _0x5eba39[1] - _0x5dbfc9 * 0.7, "anchor": "start" }, "box": { "x": _0x5eba39[0] + _0x5dbfc9 * 0.7, "y": _0x5eba39[1] - _0x5dbfc9 * 0.7 - _0x37781e, "w": _0xae1d41, "h": _0x37781e }, "priority": 3 }, { "placement": { "x": _0x5eba39[0] - _0x5dbfc9 * 0.7, "y": _0x5eba39[1] - _0x5dbfc9 * 0.7, "anchor": "end" }, "box": { "x": _0x5eba39[0] - _0x5dbfc9 * 0.7 - _0xae1d41, "y": _0x5eba39[1] - _0x5dbfc9 * 0.7 - _0x37781e, "w": _0xae1d41, "h": _0x37781e }, "priority": 3 }, { "placement": { "x": _0x5eba39[0] + _0x5dbfc9 * 0.7, "y": _0x5eba39[1] + _0x5dbfc9 * 0.7 + _0x37781e - 2, "anchor": "start" }, "box": { "x": _0x5eba39[0] + _0x5dbfc9 * 0.7, "y": _0x5eba39[1] + _0x5dbfc9 * 0.7, "w": _0xae1d41, "h": _0x37781e }, "priority": 3 }, { "placement": { "x": _0x5eba39[0] - _0x5dbfc9 * 0.7, "y": _0x5eba39[1] + _0x5dbfc9 * 0.7 + _0x37781e - 2, "anchor": "end" }, "box": { "x": _0x5eba39[0] - _0x5dbfc9 * 0.7 - _0xae1d41, "y": _0x5eba39[1] + _0x5dbfc9 * 0.7, "w": _0xae1d41, "h": _0x37781e }, "priority": 3 }];
    let _0x56a69c = _0x4a62b1[0], _0x23e8da = Infinity;
    for (const _0x5b52dc of _0x4a62b1) {
      let _0x19ceec = 0;
      for (const _0x5c074d of _0x454690) if (boxesOverlap(_0x5b52dc["box"], _0x5c074d)) _0x19ceec += 100;
      for (const _0x16832c of _0x342ab4) if (boxesOverlap(_0x5b52dc["box"], _0x16832c)) _0x19ceec += 30;
      for (const _0x4585f9 of _0x1b90d2) if (segmentIntersectsBox(_0x4585f9["p1"], _0x4585f9["p2"], _0x5b52dc["box"])) _0x19ceec += 12;
      _0x19ceec += _0x5b52dc["priority"], _0x19ceec < _0x23e8da && (_0x23e8da = _0x19ceec, _0x56a69c = _0x5b52dc);
    }
    _0x454690["push"](_0x56a69c["box"]), _0x169e91["set"](_0x32738e["id"], _0x56a69c["placement"]);
  }
  return _0x169e91;
}