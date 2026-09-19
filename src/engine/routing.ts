import * as THREE from 'three';
import type { Graph } from './graph';
import type { NodeModel, Side } from './model';
import { stackDepth } from './shapes';

/** Space between a node's outline and where its edges start. */
const GAP = 0.1;
/** Most space between neighbouring ports on one side. */
const PORT_SPACING = 0.24;

const NORMAL: Record<Side, [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  top: [0, 1],
  bottom: [0, -1],
};

interface Attachment {
  edgeId: string;
  end: 'from' | 'to';
  other: NodeModel;
}

/**
 * Curves for every edge. Edges leave and enter by the facing sides, and edges sharing
 * a side are spread along it, ordered by where their other end is, so fanouts don't
 * all converge on one point or cross each other near the node.
 */
export function routeEdges(graph: Graph): Map<string, THREE.CubicBezierCurve3> {
  const sides = new Map<string, [Side, Side]>();
  const bySide = new Map<string, Attachment[]>();
  const attach = (node: string, side: Side, a: Attachment) => {
    const key = `${node}|${side}`;
    if (!bySide.has(key)) bySide.set(key, []);
    bySide.get(key)!.push(a);
  };

  for (const edge of graph.edges.values()) {
    const a = graph.nodes.get(edge.from)!;
    const b = graph.nodes.get(edge.to)!;
    const pair = edge.ports ?? facingSides(a, b);
    sides.set(edge.id, pair);
    attach(a.id, pair[0], { edgeId: edge.id, end: 'from', other: b });
    attach(b.id, pair[1], { edgeId: edge.id, end: 'to', other: a });
  }

  const anchors = new Map<string, THREE.Vector3>();
  for (const [key, list] of bySide) {
    const [nodeId, side] = key.split('|') as [string, Side];
    const node = graph.nodes.get(nodeId)!;
    const vertical = side === 'left' || side === 'right';
    // Order along the side: top to bottom for vertical sides, left to right otherwise.
    list.sort((p, q) => (vertical ? q.other.pos[1] - p.other.pos[1] : p.other.pos[0] - q.other.pos[0]));
    const length = vertical ? node.size[1] : node.size[0];
    const spacing = list.length > 1 ? Math.min(PORT_SPACING, (length * 0.6) / (list.length - 1)) : 0;
    list.forEach((attachment, i) => {
      const offset = (i - (list.length - 1) / 2) * spacing;
      anchors.set(`${attachment.edgeId}|${attachment.end}`, anchor(node, side, vertical ? -offset : offset));
    });
  }

  const curves = new Map<string, THREE.CubicBezierCurve3>();
  for (const edge of graph.edges.values()) {
    const [s0, s1] = sides.get(edge.id)!;
    const start = anchors.get(`${edge.id}|from`)!;
    const end = anchors.get(`${edge.id}|to`)!;
    const n0 = NORMAL[s0];
    const n1 = NORMAL[s1];
    const opposite = n0[0] === -n1[0] && n0[1] === -n1[1];
    const reach = opposite
      ? Math.abs(n0[0] ? end.x - start.x : end.y - start.y) * 0.5
      : start.distanceTo(end) * 0.45;
    const k = Math.max(reach, 0.35);
    curves.set(
      edge.id,
      new THREE.CubicBezierCurve3(
        start,
        new THREE.Vector3(start.x + n0[0] * k, start.y + n0[1] * k, 0),
        new THREE.Vector3(end.x + n1[0] * k, end.y + n1[1] * k, 0),
        end,
      ),
    );
  }
  return curves;
}

/** Left-to-right when there is horizontal clearance between the nodes; vertical otherwise. */
function facingSides(a: NodeModel, b: NodeModel): [Side, Side] {
  const dx = b.pos[0] - a.pos[0];
  const dy = b.pos[1] - a.pos[1];
  const clearance = Math.abs(dx) - (a.size[0] + b.size[0]) / 2;
  if (clearance > 0.4) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
  return dy > 0 ? ['top', 'bottom'] : ['bottom', 'top'];
}

function anchor(node: NodeModel, side: Side, offset: number) {
  const [x, y] = node.pos;
  const [w, h] = node.size;
  // Stacked cards sit up and to the right, so edges on those sides start past them.
  const stack = stackDepth(node);
  switch (side) {
    case 'left':
      return new THREE.Vector3(x - w / 2 - GAP, y + offset, 0);
    case 'right':
      return new THREE.Vector3(x + w / 2 + stack + GAP, y + offset, 0);
    case 'top':
      return new THREE.Vector3(x + offset, y + h / 2 + stack + GAP, 0);
    case 'bottom':
      return new THREE.Vector3(x + offset, y - h / 2 - GAP, 0);
  }
}
