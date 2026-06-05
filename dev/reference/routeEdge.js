function routeEdge(_0x455b22, _0x36632d, _0x46a399, _0x3e2164, _0x3d7c48) {
  const _0xd6c6e9 = _0x109c, _0x2b15f5 = cellKey(_0x455b22), _0x46257e = cellKey(_0x36632d), _0x1fa509 = [], _0xbbebc8 = /* @__PURE__ */ new Map(), _0x5dec48 = { "cell": _0x455b22, "dirIdx": -1, "g": 0, "f": octilinearDistance(_0x455b22, _0x36632d), "parent": null };
  _0x1fa509["push"](_0x5dec48), _0xbbebc8["set"](_0x2b15f5 + "|-1", 0);
  while (_0x1fa509["length"] > 0) {
    let _0x5a58d2 = 0;
    for (let _0x2e838b = 1; _0x2e838b < _0x1fa509["length"]; _0x2e838b++) if (_0x1fa509[_0x2e838b]["f"] < _0x1fa509[_0x5a58d2]["f"]) _0x5a58d2 = _0x2e838b;
    const _0x3bc59b = _0x1fa509["splice"](_0x5a58d2, 1)[0];
    if (cellKey(_0x3bc59b["cell"]) === _0x46257e) {
      const _0x4bbabf = [];
      let _0x5f2003 = _0x3bc59b;
      while (_0x5f2003) {
        _0x4bbabf["push"](_0x5f2003["cell"]), _0x5f2003 = _0x5f2003["parent"];
      }
      return _0x4bbabf["reverse"](), _0x4bbabf;
    }
    for (let _0x5602d6 = 0; _0x5602d6 < 8; _0x5602d6++) {
      const _0x51bc0c = DIRS[_0x5602d6], _0x205912 = [_0x3bc59b["cell"][0] + _0x51bc0c[0], _0x3bc59b["cell"][1] + _0x51bc0c[1]], _0x2d559a = cellKey(_0x205912);
      let _0x4dcf83 = _0x5602d6 % 2 === 0 ? 1 : Math["SQRT2"];
      _0x3e2164["has"](_0x2d559a) && _0x2d559a !== _0x46257e && (_0x4dcf83 += 1.5);
      if (_0x3bc59b["dirIdx"] >= 0) {
        const _0x39ed3d = Math["min"](Math["abs"](_0x5602d6 - _0x3bc59b["dirIdx"]), 8 - Math["abs"](_0x5602d6 - _0x3bc59b["dirIdx"]));
        _0x4dcf83 += _0x39ed3d * 2.5;
      }
      const _0x26aca7 = edgeKey(_0x3bc59b["cell"], _0x205912), _0x5e4695 = _0x3d7c48["get"](_0x26aca7);
      if (_0x5e4695 && _0x5e4695["size"] > 0) {
        let _0x5a8957 = 0, _0x744552 = 0;
        for (const _0x3a888d of _0x5e4695) {
          if (_0x46a399["has"](_0x3a888d)) _0x5a8957++;
          else _0x744552++;
        }
        _0x4dcf83 -= _0x5a8957 * 2, _0x4dcf83 += _0x744552 * 1.5;
      }
      if (_0x4dcf83 < 0.1) _0x4dcf83 = 0.1;
      const _0x51ab0d = _0x3bc59b["g"] + _0x4dcf83, _0x71bdeb = _0x2d559a + "|" + _0x5602d6;
      if (_0x51ab0d >= (_0xbbebc8["get"](_0x71bdeb) ?? Infinity)) continue;
      _0xbbebc8["set"](_0x71bdeb, _0x51ab0d), _0x1fa509["push"]({ "cell": _0x205912, "dirIdx": _0x5602d6, "g": _0x51ab0d, "f": _0x51ab0d + octilinearDistance(_0x205912, _0x36632d), "parent": _0x3bc59b });
    }
    if (_0xbbebc8["size"] > 5e4) break;
  }
  const _0x198aa0 = [_0x455b22];
  let _0x1e6a7d = _0x455b22, _0xcc6f74 = 0;
  while (cellKey(_0x1e6a7d) !== _0x46257e && _0xcc6f74++ < 1e3) {
    const _0x39e02c = preferredDirIdx(_0x1e6a7d, _0x36632d);
    if (_0x39e02c < 0) break;
    const _0x8ceab3 = DIRS[_0x39e02c];
    _0x1e6a7d = [_0x1e6a7d[0] + _0x8ceab3[0], _0x1e6a7d[1] + _0x8ceab3[1]], _0x198aa0["push"](_0x1e6a7d);
  }
  return _0x198aa0;
}