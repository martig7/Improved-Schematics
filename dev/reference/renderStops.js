function renderStops(_0x90113c, _0x3f8e74) {
  const _0x3680b5 = _0xee17, _0x143251 = [], _0x312e9f = LINE_WIDTH * 0.7, _0x17c15e = _0x3f8e74 ? "#18181b" : "#ffffff", _0x24687e = _0x3f8e74 ? "#e4e4e7" : "#111111";
  for (const [_0x5340c4, _0xa5a66e] of _0x90113c) {
    if (_0xa5a66e["length"] === 1) {
      const [_0x38bc25, _0x1c767e] = _0xa5a66e[0]["pos"];
      _0x143251["push"]("<circle cx=\"" + _0x38bc25["toFixed"](1) + "\" cy=\"" + _0x1c767e["toFixed"](1) + "\" r=\"" + _0x312e9f["toFixed"](1) + "\" fill=\"" + _0x17c15e + "\" stroke=\"" + escapeXml(_0xa5a66e[0]["color"]) + "\" stroke-width=\"1.5\" data-stops=\"" + escapeXml(_0xa5a66e[0]["lineId"]) + "\" data-station-id=\"" + escapeXml(_0x5340c4) + "\"/>");
      continue;
    }
    let _0x1e5d91 = Infinity, _0x548135 = -Infinity, _0x44eaad = Infinity, _0x110f19 = -Infinity;
    for (const _0x5eba5c of _0xa5a66e) {
      if (_0x5eba5c["pos"][0] < _0x1e5d91) _0x1e5d91 = _0x5eba5c["pos"][0];
      if (_0x5eba5c["pos"][0] > _0x548135) _0x548135 = _0x5eba5c["pos"][0];
      if (_0x5eba5c["pos"][1] < _0x44eaad) _0x44eaad = _0x5eba5c["pos"][1];
      if (_0x5eba5c["pos"][1] > _0x110f19) _0x110f19 = _0x5eba5c["pos"][1];
    }
    const _0xb23668 = _0x312e9f, _0x3a546d = _0x1e5d91 - _0xb23668, _0x3c32ee = _0x44eaad - _0xb23668, _0x4bd8dd = _0x548135 - _0x1e5d91 + 2 * _0xb23668, _0x129044 = _0x110f19 - _0x44eaad + 2 * _0xb23668, _0x53cbbd = Math["min"](_0x4bd8dd, _0x129044) / 2, _0x32d994 = _0xa5a66e["map"]((_0xc70269) => _0xc70269["lineId"])["join"](",");
    _0x143251["push"]('<rect x="' + _0x3a546d["toFixed"](1) + '" y="' + _0x3c32ee["toFixed"](1) + "\" width=\"" + _0x4bd8dd["toFixed"](1) + "\" height=\"" + _0x129044["toFixed"](1) + "\" rx=\"" + _0x53cbbd["toFixed"](1) + "\" ry=\"" + _0x53cbbd["toFixed"](1) + "\" fill=\"" + _0x17c15e + "\" stroke=\"" + _0x24687e + "\" stroke-width=\"1.5\" data-stops=\"" + escapeXml(_0x32d994) + "\" data-station-id=\"" + escapeXml(_0x5340c4) + "\"/>");
  }
  return _0x143251;
}