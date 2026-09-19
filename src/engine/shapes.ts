import * as THREE from 'three';
import type { NodeModel, Shape } from './model';

/** Offset between the stacked cards drawn behind nodes with runtime multiplicity. */
export const STACK_OFFSET = 0.13;
export const STACK_LAYERS = 2;

/** How far a node's stacked cards extend up and to the right of it. */
export function stackDepth(node: NodeModel) {
  return node.runtime && node.runtime.count > 1 ? STACK_OFFSET * STACK_LAYERS : 0;
}

export interface ShapeGeometry {
  /** Filled area. */
  fill: THREE.Shape;
  /** Outline as one continuous path, evenly spaced so it traces in at a steady speed. */
  outline: THREE.Vector2[];
  /** Corner radius for the rounded-rectangle glow approximation. */
  glowRadius: number;
}

const OUTLINE_POINTS = 160;
const BOX_RADIUS = 0.2;

export function shapeGeometry(shape: Shape, w: number, h: number): ShapeGeometry {
  switch (shape) {
    case 'db':
      return cylinder(w, h);
    case 'queue': {
      const s = roundedRect(w, h, h / 2);
      return { fill: s, outline: s.getSpacedPoints(OUTLINE_POINTS), glowRadius: h / 2 };
    }
    case 'actor': {
      const r = Math.min(w, h) / 2;
      const s = new THREE.Shape().absarc(0, 0, r, Math.PI / 2, Math.PI / 2 + Math.PI * 2, false);
      return { fill: s, outline: s.getSpacedPoints(OUTLINE_POINTS), glowRadius: r };
    }
    default: {
      const s = roundedRect(w, h, BOX_RADIUS);
      return { fill: s, outline: s.getSpacedPoints(OUTLINE_POINTS), glowRadius: BOX_RADIUS };
    }
  }
}

function roundedRect(w: number, h: number, r: number) {
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** A database cylinder seen side-on: elliptical top, straight sides, rounded base. */
function cylinder(w: number, h: number): ShapeGeometry {
  const rx = w / 2;
  const ry = Math.min(0.22, h * 0.16);
  const top = h / 2 - ry;
  const bottom = -h / 2 + ry;

  const fill = new THREE.Shape();
  fill.moveTo(-rx, top);
  fill.lineTo(-rx, bottom);
  fill.absellipse(0, bottom, rx, ry, Math.PI, Math.PI * 2, false);
  fill.lineTo(rx, top);
  fill.absellipse(0, top, rx, ry, 0, Math.PI, false);

  // Top ellipse all the way round, down the left, across the front of the base, up the right.
  const outline = new THREE.Path();
  outline.moveTo(-rx, top);
  outline.absellipse(0, top, rx, ry, Math.PI, Math.PI * 3, false);
  outline.lineTo(-rx, bottom);
  outline.absellipse(0, bottom, rx, ry, Math.PI, Math.PI * 2, false);
  outline.lineTo(rx, top);

  return { fill, outline: outline.getSpacedPoints(OUTLINE_POINTS), glowRadius: 0.3 };
}
