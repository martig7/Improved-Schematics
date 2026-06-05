function computeCanonicalOffsets(_0x521bac) {
  const _0x44beb4 = _0xee17, _0x1e2294 = LINE_WIDTH + LINE_GAP, _0x3ea081 = /* @__PURE__ */ new Map();
  for (const _0x1b04b3 of _0x521bac["edges"]) {
    for (const _0x209424 of _0x1b04b3["lines"]) {
      if (!_0x3ea081["has"](_0x209424["id"])) _0x3ea081["set"](_0x209424["id"], []);
      _0x3ea081["get"](_0x209424["id"])["push"](_0x1b04b3);
    }
  }
  const _0x16a7cd = /* @__PURE__ */ new Map();
  for (const [_0x46ab02, _0x4dc505] of _0x3ea081) {
    const _0xd3a877 = [..._0x4dc505]["sort"]((_0x4a48d6, _0x1ddce0) => {
      const _0x871917 = _0x44beb4;
      if (_0x1ddce0["lineOrder"]["length"] !== _0x4a48d6["lineOrder"]["length"]) return _0x1ddce0["lineOrder"]["length"] - _0x4a48d6["lineOrder"]["length"];
      return _0x4a48d6["id"]["localeCompare"](_0x1ddce0["id"]);
    })[0], _0x1be659 = _0xd3a877["lineOrder"]["indexOf"](_0x46ab02), _0xd156f6 = (_0xd3a877["lineOrder"]["length"] - 1) / 2;
    _0x16a7cd["set"](_0x46ab02, (_0x1be659 - _0xd156f6) * _0x1e2294);
  }
  return _0x16a7cd;
}