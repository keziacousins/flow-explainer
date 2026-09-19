import * as THREE from 'three';
import { THICKNESS, type NodeView } from './node';
import type { RuntimeLayer } from './runtime';
import type { Stage } from './stage';

export interface Callout {
  text: string;
  /** Hex colour for the dot and leader line. */
  accent: string;
  /** World point the callout refers to. */
  anchor: THREE.Vector3;
  /** 0 to 1; callouts fade with whatever they point at. */
  opacity: () => number;
  /** Node the callout is about; its own shape doesn't count as an obstacle for the leader. */
  owner?: string;
}

/** A screen-space rectangle, in pixels. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  owner?: string;
}

const ANGLES = 16;
const DISTANCES = [40, 70, 105, 150, 210, 280];
/** Horizontal tick between the leader's elbow and the label. */
const TICK = 10;
const MARGIN = 8;
/** Space kept around placed labels. */
const PAD = 4;

interface Placed {
  callout: Callout;
  label: HTMLElement;
  line: SVGPolylineElement;
  dot: SVGCircleElement;
  size?: [number, number];
  /** Last chosen candidate, favoured next frame so labels don't hop around. */
  choice?: number;
}

/**
 * Small labels set off to the side of what they describe, joined by an elbowed leader
 * line ending in a dot. Each frame they look for empty screen space: away from the
 * projected diagram, the caption and each other, with leaders that avoid crossing shapes.
 */
export class Callouts {
  private placed: Placed[] = [];

  constructor(
    private layer: HTMLElement,
    private svg: SVGSVGElement,
  ) {}

  set(callouts: Callout[]) {
    for (const p of this.placed) {
      p.label.remove();
      p.line.remove();
      p.dot.remove();
    }
    this.placed = callouts.map((callout) => {
      const label = document.createElement('div');
      label.className = 'callout';
      label.textContent = callout.text;
      this.layer.appendChild(label);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '2.5');
      for (const el of [line, dot]) {
        el.style.setProperty('--accent', callout.accent);
        this.svg.appendChild(el);
      }
      return { callout, label, line, dot };
    });
  }

  update(stage: Stage, obstacles: Rect[]) {
    const taken = [...obstacles];
    const bounds = { x0: MARGIN, y0: MARGIN, x1: stage.width - MARGIN, y1: stage.height - MARGIN };

    for (const p of this.placed) {
      const opacity = p.callout.opacity();
      const shown = opacity > 0.02;
      for (const el of [p.label, p.line, p.dot]) el.style.visibility = shown ? 'visible' : 'hidden';
      if (!shown) continue;

      if (!p.size?.[0]) p.size = [p.label.offsetWidth, p.label.offsetHeight];
      const [w, h] = p.size;
      const { anchor, owner } = p.callout;
      const [ax, ay] = stage.toScreen(anchor.x, anchor.y, anchor.z);

      let best = { cost: Infinity, index: -1, ex: ax, ey: ay, side: 1, rect: { x0: 0, y0: 0, x1: 0, y1: 0 } };
      for (let d = 0; d < DISTANCES.length; d++) {
        for (let a = 0; a < ANGLES; a++) {
          const index = d * ANGLES + a;
          const angle = (a / ANGLES) * Math.PI * 2;
          const ex = ax + Math.cos(angle) * DISTANCES[d];
          const ey = ay - Math.sin(angle) * DISTANCES[d];
          const side = Math.cos(angle) >= -0.01 ? 1 : -1;
          const lx = ex + side * TICK;
          const rect = side > 0 ? { x0: lx, y0: ey - h / 2, x1: lx + w, y1: ey + h / 2 } : { x0: lx - w, y0: ey - h / 2, x1: lx, y1: ey + h / 2 };
          if (rect.x0 < bounds.x0 || rect.y0 < bounds.y0 || rect.x1 > bounds.x1 || rect.y1 > bounds.y1) continue;

          let overlap = 0;
          let crossings = 0;
          for (const o of taken) {
            overlap += intersection(rect, o);
            if (o.owner !== owner && segmentHits(ax, ay, ex, ey, o)) crossings++;
          }
          const cost = overlap * 10 + crossings * 300 + DISTANCES[d] - (index === p.choice ? 40 : 0);
          if (cost < best.cost) best = { cost, index, ex, ey, side, rect };
        }
      }
      if (best.index < 0) continue;
      p.choice = best.index;
      taken.push({ x0: best.rect.x0 - PAD, y0: best.rect.y0 - PAD, x1: best.rect.x1 + PAD, y1: best.rect.y1 + PAD });

      const { ex, ey, side } = best;
      const endX = ex + side * TICK;
      p.dot.setAttribute('cx', ax.toFixed(1));
      p.dot.setAttribute('cy', ay.toFixed(1));
      p.line.setAttribute('points', `${ax},${ay} ${ex},${ey} ${endX},${ey}`);
      p.label.style.transform = `translate(${best.rect.x0}px, ${best.rect.y0}px)`;
      for (const el of [p.label, p.line, p.dot]) el.style.opacity = String(opacity);
    }
  }
}

/**
 * What callouts should keep clear of: every visible shape and tower as projected on
 * screen, plus the caption, navigation and title.
 */
export function diagramObstacles(stage: Stage, nodes: Map<string, NodeView>, runtime: RuntimeLayer): Rect[] {
  const out: Rect[] = [];
  const v = new THREE.Vector3();
  const project = (points: THREE.Vector3[], owner: string) => {
    const r: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, owner };
    for (const p of points) {
      const [x, y] = stage.toScreen(p.x, p.y, p.z);
      r.x0 = Math.min(r.x0, x);
      r.y0 = Math.min(r.y0, y);
      r.x1 = Math.max(r.x1, x);
      r.y1 = Math.max(r.y1, y);
    }
    out.push(r);
  };

  for (const [id, node] of nodes) {
    if (node.state.appear < 0.1) continue;
    const { min, max } = node.bounds;
    const corners: THREE.Vector3[] = [];
    for (const z of [0, THICKNESS]) {
      corners.push(v.clone().set(min.x, min.y, z), v.clone().set(max.x, min.y, z));
      corners.push(v.clone().set(max.x, max.y, z), v.clone().set(min.x, max.y, z));
    }
    // Actors carry their label beneath them, on the sheet.
    if (node.model.shape === 'actor') corners.push(v.clone().set((min.x + max.x) / 2, min.y - 0.8, 0));
    project(corners, id);
  }
  for (const [id, cluster] of runtime.clusters) {
    if (cluster.state.appear > 0.1) project(cluster.corners, id);
  }
  for (const selector of ['#caption', '#nav', '.deck-title:not(.is-gone)', '#info:not([hidden])']) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width) out.push({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
  }
  return out;
}

function intersection(a: Rect, b: Rect) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Whether the segment from (x0, y0) to (x1, y1) passes through a rectangle (Liang–Barsky). */
function segmentHits(x0: number, y0: number, x1: number, y1: number, r: Rect) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, x0 - r.x0],
    [dx, r.x1 - x0],
    [-dy, y0 - r.y0],
    [dy, r.y1 - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}
