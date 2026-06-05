function rebuildLayoutFromCells(_0x2de8c0, _0x316278) {
  const _0x1ee0c7 = _0x109c, _0x2801a3 = /* @__PURE__ */ new Set();
  for (const _0x282845 of _0x316278["values"]()) _0x2801a3["add"](cellKey(_0x282845));
  const _0x5453f0 = /* @__PURE__ */ new Map();
  for (const [_0x436886, _0x569f47] of _0x316278) {
    const _0xf8161b = _0x2de8c0["nodes"]["get"](_0x436886);
    _0x5453f0["set"](_0x436886, { "id": _0x436886, "cell": _0x569f47, "label": _0xf8161b["label"], "lngLat": _0xf8161b["lngLat"] });
  }
  const _0x117747 = /* @__PURE__ */ new Map(), _0x1aa7b8 = [], _0x12b0bf = orderEdgesByImportance(_0x2de8c0);
  for (const _0x4c58c7 of _0x12b0bf) {
    const _0xe9e47b = _0x316278["get"](_0x4c58c7["from"]), _0x3a9aed = _0x316278["get"](_0x4c58c7["to"]), _0x227484 = new Set(_0x4c58c7["lines"]["map"]((_0x14d068) => _0x14d068["id"])), _0x118ac4 = routeEdge(_0xe9e47b, _0x3a9aed, _0x227484, _0x2801a3, _0x117747);
    for (let _0x250441 = 0; _0x250441 < _0x118ac4["length"] - 1; _0x250441++) {
      const _0x1b3b23 = edgeKey(_0x118ac4[_0x250441], _0x118ac4[_0x250441 + 1]);
      let _0xab564f = _0x117747["get"](_0x1b3b23);
      !_0xab564f && (_0xab564f = /* @__PURE__ */ new Set(), _0x117747["set"](_0x1b3b23, _0xab564f));
      for (const _0x230b41 of _0x227484) _0xab564f["add"](_0x230b41);
    }
    _0x1aa7b8["push"]({ "id": _0x4c58c7["id"], "from": _0x4c58c7["from"], "to": _0x4c58c7["to"], "path": _0x118ac4, "lines": _0x4c58c7["lines"], "lineOrder": _0x4c58c7["lines"]["map"]((_0x23fea8) => _0x23fea8["id"]), "stops": _0x4c58c7["stops"] });
  }
  return { "cellSize": STEP_SIZE, "nodes": _0x5453f0, "edges": _0x1aa7b8, "lineTraversals": _0x2de8c0["lineTraversals"] };
}