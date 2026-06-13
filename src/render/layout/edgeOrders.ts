import type { LayoutEdge } from './types';

/** The lateral line orders at an edge's two endpoints. When orderFrom/orderTo
 *  are unset the edge has no internal crossings and both ends equal lineOrder.
 *  Returns fresh arrays so callers may sort/splice without touching the edge. */
export function edgeEndpointOrders(edge: LayoutEdge): { from: string[]; to: string[] } {
  return {
    from: [...(edge.orderFrom ?? edge.lineOrder)],
    to: [...(edge.orderTo ?? edge.lineOrder)],
  };
}
