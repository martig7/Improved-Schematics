function orderEdgesByImportance(_0x12764c) {
  const _0xcc36f4 = _0x109c;
  return [..._0x12764c["edges"]]["sort"]((_0x48123a, _0x5320ce) => {
    const _0x20e351 = _0xcc36f4, _0x3b53ab = _0x5320ce["lines"]["length"] - _0x48123a["lines"]["length"];
    if (_0x3b53ab !== 0) return _0x3b53ab;
    const _0x594c32 = _0x12764c["nodes"]["get"](_0x48123a["from"]), _0x394640 = _0x12764c["nodes"]["get"](_0x5320ce["from"]), _0x5b229d = _0x12764c["nodes"]["get"](_0x48123a["to"]), _0x4ec2dd = _0x12764c["nodes"]["get"](_0x5320ce["to"]);
    return Math["hypot"](_0x594c32["pos"][0] - _0x5b229d["pos"][0], _0x594c32["pos"][1] - _0x5b229d["pos"][1]) - Math["hypot"](_0x394640["pos"][0] - _0x4ec2dd["pos"][0], _0x394640["pos"][1] - _0x4ec2dd["pos"][1]);
  });
}