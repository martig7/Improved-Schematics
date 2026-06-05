function walkRouteVisits(_0x4f389a, _0x1dec32, _0x31f41a) {
  const _0x418339 = _0x5e27, _0x37dec1 = [], _0x208ca0 = (_0x56ee9c, _0x201649) => {
    const _0x11d872 = _0x5e27;
    if (!_0x56ee9c) return;
    const _0x288443 = _0x37dec1[_0x37dec1["length"] - 1];
    if (_0x288443 && _0x288443["groupId"] === _0x56ee9c) {
      if (_0x201649) _0x288443["isStop"] = !![];
      return;
    }
    _0x37dec1["push"]({ "groupId": _0x56ee9c, "isStop": _0x201649 });
  }, _0x2eb26e = _0x4f389a["stCombos"] ?? [];
  if (_0x2eb26e["length"] > 0) {
    for (const _0x2c7382 of _0x2eb26e) {
      _0x208ca0(_0x1dec32["get"](_0x2c7382["startStNodeId"]), !![]);
      for (const _0x5161a5 of _0x2c7382["path"] ?? []) _0x208ca0(_0x31f41a["get"](_0x5161a5["trackId"]), ![]);
      _0x208ca0(_0x1dec32["get"](_0x2c7382["endStNodeId"]), !![]);
    }
    return _0x37dec1;
  }
  for (const _0xa401fb of _0x4f389a["stNodes"] ?? []) _0x208ca0(_0x1dec32["get"](_0xa401fb["id"]), !![]);
  return _0x37dec1;
}