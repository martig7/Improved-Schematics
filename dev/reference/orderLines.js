function orderLines(_0x310fbb) {
  const _0x420f4d = _0x37b9;
  for (const _0x2a13ba of _0x310fbb["edges"]) {
    _0x2a13ba["lineOrder"] = [..._0x2a13ba["lines"]]["map"]((_0x17a8e5) => _0x17a8e5["id"])["sort"]();
  }
  const _0x640d29 = /* @__PURE__ */ new Map();
  for (const _0x457eb9 of _0x310fbb["edges"]) {
    if (!_0x640d29["has"](_0x457eb9["from"])) _0x640d29["set"](_0x457eb9["from"], []);
    if (!_0x640d29["has"](_0x457eb9["to"])) _0x640d29["set"](_0x457eb9["to"], []);
    _0x640d29["get"](_0x457eb9["from"])["push"](_0x457eb9["id"]), _0x640d29["get"](_0x457eb9["to"])["push"](_0x457eb9["id"]);
  }
  const _0x209d3f = new Map(_0x310fbb["edges"]["map"]((_0xe1c01a) => [_0xe1c01a["id"], _0xe1c01a]));
  for (let _0x518f2b = 0; _0x518f2b < 6; _0x518f2b++) {
    let _0x260835 = ![];
    for (const [, _0x353954] of _0x640d29) {
      for (const _0xd2613a of _0x353954) {
        const _0x2ed2d3 = _0x209d3f["get"](_0xd2613a), _0x19c8f4 = /* @__PURE__ */ new Map();
        for (const _0x768a16 of _0x2ed2d3["lines"]) {
          let _0x343977 = 0, _0xa42e0a = 0;
          for (const _0x2eef05 of _0x353954) {
            if (_0x2eef05 === _0xd2613a) continue;
            const _0x3c7910 = _0x209d3f["get"](_0x2eef05), _0x27e9c2 = _0x3c7910["lineOrder"]["indexOf"](_0x768a16["id"]);
            if (_0x27e9c2 >= 0) {
              const _0x509888 = Math["max"](1, _0x3c7910["lineOrder"]["length"] - 1);
              _0x343977 += _0x27e9c2 / _0x509888, _0xa42e0a++;
            }
          }
          const _0x802919 = _0x2ed2d3["lineOrder"]["indexOf"](_0x768a16["id"]), _0x32bfda = _0x802919 / Math["max"](1, _0x2ed2d3["lineOrder"]["length"] - 1);
          _0x19c8f4["set"](_0x768a16["id"], _0xa42e0a > 0 ? _0x343977 / _0xa42e0a : _0x32bfda);
        }
        const _0x4fea5f = _0x2ed2d3["lineOrder"]["join"](",");
        _0x2ed2d3["lineOrder"] = [..._0x2ed2d3["lineOrder"]]["sort"]((_0x4c49ba, _0x38a787) => {
          const _0x132da3 = _0x420f4d, _0x5472f3 = _0x19c8f4[_0x132da3(432)](_0x4c49ba) ?? 0, _0xfb527 = _0x19c8f4["get"](_0x38a787) ?? 0;
          if (_0x5472f3 === _0xfb527) return _0x4c49ba[_0x132da3(433)](_0x38a787);
          return _0x5472f3 - _0xfb527;
        });
        if (_0x2ed2d3["lineOrder"]["join"](",") !== _0x4fea5f) _0x260835 = !![];
      }
    }
    if (!_0x260835) break;
  }
}