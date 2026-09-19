import * as THREE from 'three';
import type { NodeModel, Shape } from './model';

/** Offset between the stacked cards drawn behind nodes with runtime multiplicity (flat view). */
export const STACK_OFFSET = 0.13;
export const STACK_LAYERS = 2;

/** How far a node's stacked cards extend up and to the right of it. */
export function stackDepth(node: NodeModel) {
  return node.runtime && node.runtime.count > 1 ? STACK_OFFSET * STACK_LAYERS : 0;
}

export interface Footprint {
  /** The shape seen from above. Solids are this, extruded. */
  shape: THREE.Shape;
  /** Outline as one continuous path, evenly spaced so it traces in at a steady speed. */
  outline: THREE.Vector2[];
  /** Corner radius for the rounded-rectangle glow approximation. */
  glowRadius: number;
  /** Whether labels sit centred (round shapes) or left-aligned (boxes). */
  centred: boolean;
}

const OUTLINE_POINTS = 160;
const BOX_RADIUS = 0.2;

/**
 * Every shape is a footprint: the flat view shows it from above, the 3D view shows it
 * extruded, and runtime instances are thinner copies of it stacked beneath. So a
 * database is an elliptical puck, and its shards a stack of discs.
 */
export function footprint(shape: Shape, w: number, h: number): Footprint {
  switch (shape) {
    case 'db': {
      const s = new THREE.Shape().absellipse(0, 0, w / 2, h / 2, 0, Math.PI * 2, false);
      return { shape: s, outline: s.getSpacedPoints(OUTLINE_POINTS), glowRadius: h / 2, centred: true };
    }
    case 'queue': {
      const s = roundedRect(w, h, h / 2);
      return { shape: s, outline: s.getSpacedPoints(OUTLINE_POINTS), glowRadius: h / 2, centred: false };
    }
    case 'actor': {
      const r = Math.min(w, h) / 2;
      const s = new THREE.Shape().absarc(0, 0, r, Math.PI / 2, Math.PI / 2 + Math.PI * 2, false);
      return { shape: s, outline: s.getSpacedPoints(OUTLINE_POINTS), glowRadius: r, centred: true };
    }
    default: {
      const s = roundedRect(w, h, BOX_RADIUS);
      return { shape: s, outline: s.getSpacedPoints(OUTLINE_POINTS), glowRadius: BOX_RADIUS, centred: false };
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

/**
 * Solid shading shared by nodes and runtime slabs: dark top faces, darker sides, and a
 * bright rim wherever the surface turns (bevels and side walls), so edges glow in 3D.
 * Per-instance colour and state (appear, heat, dim) come from attributes when instanced.
 */
export function solidMaterial(instanced: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFill: { value: new THREE.Color('#0B1120') },
      uLine: { value: new THREE.Color('#2E3D5C') },
      uColor: { value: new THREE.Color() },
      uState: { value: new THREE.Vector3(1, 0, 0) },
      uOpacity: { value: 1 },
    },
    defines: instanced ? { INSTANCED: '' } : {},
    vertexShader: /* glsl */ `
      #ifdef INSTANCED
        attribute vec3 aColor;
        attribute vec3 aState;
      #else
        uniform vec3 uColor;
        uniform vec3 uState;
      #endif
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vState;
      void main() {
        vNormal = normal;
        #ifdef INSTANCED
          vColor = aColor;
          vState = aState;
          mat4 m = instanceMatrix;
        #else
          vColor = uColor;
          vState = uState;
          mat4 m = mat4(1.0);
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * m * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uFill;
      uniform vec3 uLine;
      uniform float uOpacity;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vState;
      void main() {
        float appear = vState.x;
        float heat = vState.y;
        float dim = vState.z;
        if (appear < 0.01) discard;
        float up = abs(normalize(vNormal).z);
        // Bevels face partly up: that band is the rim.
        float rim = smoothstep(0.2, 0.5, up) * (1.0 - smoothstep(0.85, 0.97, up));
        float side = 1.0 - smoothstep(0.1, 0.3, up);
        float brightness = 1.0 - 0.7 * dim;

        vec3 line = mix(mix(uLine, vColor, 0.5), vColor * 3.0, heat) * brightness;
        vec3 top = mix(uFill, vColor * 0.3, 0.12 + heat * 0.4) * brightness;
        vec3 wall = mix(uFill * 1.4, vColor * 0.25, 0.35 + heat * 0.4) * brightness * 0.8;
        vec3 color = mix(mix(top, wall, side), line, rim);
        gl_FragColor = vec4(color, uOpacity * min(1.0, appear * 1.5));
      }
    `,
    transparent: true,
  });
}

/** An extruded footprint with a small bevel for the rim to catch. Top face at z = 0. */
export function solidGeometry(shape: THREE.Shape, thickness: number, bevel = 0.025) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 1,
    curveSegments: 24,
  });
  // Extrusion runs from z = 0 upward; put the top face at z = 0 and hang the solid below it.
  geometry.translate(0, 0, -(thickness - bevel));
  return geometry;
}
