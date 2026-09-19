import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { palette, reducedMotion, roleColor } from './palette';
import type { Stage } from './stage';
import type { NodeSpec } from './types';

const DEFAULT_SIZE: [number, number] = [3.2, 1.5];
const RADIUS = 0.2;
const BORDER_SEGMENTS = 160;

/** Tweenable state. Scenes animate these; `update` turns them into visuals. */
export interface NodeState {
  appear: number;
  glow: number;
  dim: number;
}

export class NodeView {
  readonly state: NodeState = { appear: 0, glow: 0, dim: 0 };
  readonly group = new THREE.Group();
  readonly accent: THREE.Color;
  readonly width: number;
  readonly height: number;

  private fillMaterial: THREE.MeshBasicMaterial;
  private borderGeometry: LineGeometry;
  private borderMaterial: LineMaterial;
  private haloMaterial: THREE.ShaderMaterial;
  private label: HTMLElement;
  private rest: THREE.Color;
  private hot: THREE.Color;
  private fillRest = new THREE.Color(palette.fill);
  private fillHot: THREE.Color;

  constructor(
    readonly spec: NodeSpec,
    labelLayer: HTMLElement,
  ) {
    [this.width, this.height] = spec.size ?? DEFAULT_SIZE;
    this.accent = new THREE.Color(roleColor[spec.role]);
    this.rest = new THREE.Color(palette.line).lerp(this.accent, 0.35);
    this.hot = this.accent.clone().multiplyScalar(3);
    this.fillHot = this.fillRest.clone().lerp(this.accent, 0.05);

    const shape = roundedRect(this.width, this.height, RADIUS);

    this.fillMaterial = new THREE.MeshBasicMaterial({
      color: palette.fill,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape, 6), this.fillMaterial);
    fill.renderOrder = 3;

    // Evenly spaced points so the border traces in at a constant speed.
    const points = shape.getSpacedPoints(BORDER_SEGMENTS);
    this.borderGeometry = new LineGeometry();
    this.borderGeometry.setPositions(points.flatMap((p) => [p.x, p.y, 0]));
    this.borderMaterial = new LineMaterial({
      linewidth: 1.5,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const border = new Line2(this.borderGeometry, this.borderMaterial);
    border.renderOrder = 4;

    const margin = 0.6;
    this.haloMaterial = haloMaterial(this.width, this.height, RADIUS, margin, this.accent);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(this.width + margin * 2, this.height + margin * 2), this.haloMaterial);
    halo.renderOrder = 2;

    this.group.add(halo, fill, border);
    this.group.position.set(spec.pos[0], spec.pos[1], 0);

    this.label = document.createElement('div');
    this.label.className = 'node-label';
    this.label.style.setProperty('--w', String(this.width));
    this.label.style.setProperty('--h', String(this.height));
    this.label.innerHTML = `<span class="name"></span><span class="detail"></span>`;
    this.label.querySelector('.name')!.textContent = spec.label;
    this.label.querySelector('.detail')!.textContent = spec.detail ?? '';
    labelLayer.appendChild(this.label);
  }

  get bounds() {
    const [x, y] = this.spec.pos;
    const hw = this.width / 2;
    const hh = this.height / 2;
    return new THREE.Box2(new THREE.Vector2(x - hw, y - hh), new THREE.Vector2(x + hw, y + hh));
  }

  update(time: number, stage: Stage) {
    const { appear, glow, dim } = this.state;
    const visible = appear > 0.001;
    this.group.visible = visible;
    this.label.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) return;

    const pulse = reducedMotion ? glow : glow * (0.8 + 0.2 * Math.sin(time * 2.6));
    const brightness = 1 - 0.7 * dim;

    this.borderGeometry.instanceCount = Math.ceil(appear * BORDER_SEGMENTS);
    this.borderMaterial.color.copy(this.rest).lerp(this.hot, pulse).multiplyScalar(brightness);

    this.haloMaterial.uniforms.uStrength.value = pulse * brightness * appear;
    this.haloMaterial.visible = pulse > 0.01;

    this.fillMaterial.opacity = smoothstep(0.2, 1, appear) * 0.94;
    this.fillMaterial.color.copy(this.fillRest).lerp(this.fillHot, glow);

    const [sx, sy] = stage.toScreen(this.spec.pos[0], this.spec.pos[1]);
    this.label.style.transform = `translate3d(${sx}px, ${sy}px, 0) translate(-50%, -50%)`;
    this.label.style.opacity = String(smoothstep(0.5, 1, appear) * (1 - 0.6 * dim));
    this.label.classList.toggle('is-hot', glow > 0.5);
  }
}

/** Soft glow hugging a rounded rectangle, from its signed distance field. */
function haloMaterial(w: number, h: number, r: number, margin: number, color: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHalfSize: { value: new THREE.Vector2(w / 2, h / 2) },
      uRadius: { value: r },
      uMargin: { value: margin },
      uColor: { value: color },
      uStrength: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vPos;
      void main() {
        vPos = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uHalfSize;
      uniform float uRadius;
      uniform float uMargin;
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vPos;
      void main() {
        vec2 q = abs(vPos) - uHalfSize + uRadius;
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
        // Wide falloff outside the border, a tight one inside.
        float glow = d > 0.0 ? exp(-d * 7.0) : exp(d * 14.0) * 0.5;
        // Reach zero before the plane's edge so its outline never shows.
        glow *= 1.0 - smoothstep(uMargin * 0.5, uMargin * 0.95, d);
        gl_FragColor = vec4(uColor, glow * uStrength * 0.55);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
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

export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
