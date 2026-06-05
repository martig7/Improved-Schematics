function projectFactory(_0x500177) {
  const _0x235592 = _0x5e27, _0x2d80f7 = 6371e3, _0x33e1b7 = Math["cos"](_0x500177 * Math["PI"] / 180);
  return (_0x3e5385, _0x4b69d5) => [_0x2d80f7 * _0x3e5385 * Math["PI"] * _0x33e1b7 / 180, _0x2d80f7 * _0x4b69d5 * Math["PI"] / 180];
}