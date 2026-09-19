import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { NodeModel } from './model';
import { palette, reducedMotion, roleColor } from './palette';
import { shapeGeometry, STACK_LAYERS, STACK_OFFSET, stackDepth } from './shapes';
import type { Stage } from './stage';

const HALO_MARGIN = 0.6;
/** Labels smaller than this many pixels are hidden rather than drawn illegibly. */
const MIN_LABEL_PX = 6;
const LABEL_EM = 0.3;

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

  /** Brief flash when a packet arrives. Decays on its own. */
  private pulse = 0;
  /** Brief red flash when a packet is dropped here. */
  private alarm = 0;

  private fillMaterial: THREE.MeshBasicMaterial;
  private outline: LineGeometry[] = [];
  private borderMaterial: LineMaterial;
  private stack: { fill: THREE.MeshBasicMaterial; border: LineMaterial }[] = [];
  private haloMaterial: THREE.ShaderMaterial;
  private label: HTMLElement;
  private segments: number;
  private rest: THREE.Color;
  private hot: THREE.Color;
  private errorHot = new THREE.Color(palette.error).multiplyScalar(3);
  private fillRest = new THREE.Color(palette.fill);
  private fillHot: THREE.Color;

  constructor(
    readonly model: NodeModel,
    labelLayer: HTMLElement,
  ) {
    const [w, h] = model.size;
    this.accent = new THREE.Color(roleColor[model.role]);
    this.rest = new THREE.Color(palette.line).lerp(this.accent, 0.35);
    this.hot = this.accent.clone().multiplyScalar(3);
    this.fillHot = this.fillRest.clone().lerp(this.accent, 0.05);

    const shape = shapeGeometry(model.shape, w, h);
    const fillGeometry = new THREE.ShapeGeometry(shape.fill, 12);
    const outlinePositions = shape.outline.flatMap((p) => [p.x, p.y, 0]);
    this.segments = shape.outline.length - 1;
    const dashed = model.role === 'external';

    const makeBorder = (material: LineMaterial) => {
      const geometry = new LineGeometry();
      geometry.setPositions(outlinePositions);
      this.outline.push(geometry);
      const line = new Line2(geometry, material);
      if (dashed) line.computeLineDistances();
      return line;
    };
    const lineMaterial = (linewidth: number) =>
      new LineMaterial({
        linewidth,
        transparent: true,
        dashed,
        dashSize: 0.14,
        gapSize: 0.1,
        depthTest: false,
        depthWrite: false,
      });
    const fillMaterial = () =>
      new THREE.MeshBasicMaterial({ color: palette.fill, transparent: true, depthTest: false, depthWrite: false });

    // Cards stacked behind the node hint at its runtime multiplicity.
    const layers = stackDepth(model) ? STACK_LAYERS : 0;
    for (let k = layers; k >= 1; k--) {
      const layer = { fill: fillMaterial(), border: lineMaterial(1.2) };
      const fill = new THREE.Mesh(fillGeometry, layer.fill);
      const border = makeBorder(layer.border);
      fill.position.set(k * STACK_OFFSET, k * STACK_OFFSET, 0);
      border.position.copy(fill.position);
      fill.renderOrder = 3;
      border.renderOrder = 3.1;
      this.group.add(fill, border);
      this.stack.push(layer);
    }

    this.fillMaterial = fillMaterial();
    const fill = new THREE.Mesh(fillGeometry, this.fillMaterial);
    fill.renderOrder = 3.4;
    this.borderMaterial = lineMaterial(1.5);
    const border = makeBorder(this.borderMaterial);
    border.renderOrder = 4;

    this.haloMaterial = haloMaterial(w, h, shape.glowRadius, HALO_MARGIN);
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(w + HALO_MARGIN * 2, h + HALO_MARGIN * 2),
      this.haloMaterial,
    );
    halo.renderOrder = 2;

    this.group.add(halo, fill, border);
    this.group.position.set(model.pos[0], model.pos[1], 0);

    this.label = document.createElement('div');
    this.label.className = `node-label shape-${model.shape}`;
    this.label.style.setProperty('--w', String(w));
    this.label.style.setProperty('--h', String(h));
    this.label.innerHTML = `<span class="name"></span><span class="detail"></span>`;
    this.label.querySelector('.name')!.textContent = model.label;
    this.label.querySelector('.detail')!.textContent = model.detail ?? '';
    if (model.runtime && model.runtime.count > 1) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `×${model.runtime.count}`;
      badge.title = `${model.runtime.count} ${model.runtime.kind}`;
      this.label.appendChild(badge);
    }
    labelLayer.appendChild(this.label);
  }

  get bounds() {
    const [x, y] = this.model.pos;
    const [w, h] = this.model.size;
    const stack = this.stack.length * STACK_OFFSET;
    return new THREE.Box2(new THREE.Vector2(x - w / 2, y - h / 2), new THREE.Vector2(x + w / 2 + stack, y + h / 2 + stack));
  }

  /** A packet arrived. */
  flash() {
    this.pulse = 1;
  }

  /** A packet was dropped here. */
  fail() {
    this.alarm = 1;
  }

  update(time: number, delta: number, stage: Stage) {
    this.pulse *= Math.exp(-delta * 5);
    this.alarm *= Math.exp(-delta * 2.2);

    const { appear, glow, dim } = this.state;
    const visible = appear > 0.001;
    this.group.visible = visible;
    this.label.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) return;

    const breathing = reducedMotion ? glow : glow * (0.8 + 0.2 * Math.sin(time * 2.6));
    const heat = Math.min(1, Math.max(breathing, this.pulse * 0.9));
    const brightness = 1 - 0.7 * dim;
    const alarm = this.alarm;

    const drawn = Math.ceil(appear * this.segments);
    for (const g of this.outline) g.instanceCount = drawn;

    this.borderMaterial.color
      .copy(this.rest)
      .lerp(this.hot, heat)
      .lerp(this.errorHot, alarm)
      .multiplyScalar(brightness);
    for (const layer of this.stack) {
      layer.border.color.copy(this.rest).multiplyScalar(0.55 * brightness);
      layer.fill.opacity = smoothstep(0.2, 1, appear) * 0.94;
    }

    const halo = this.haloMaterial.uniforms;
    halo.uColor.value.copy(this.accent).lerp(this.errorHot, alarm);
    halo.uStrength.value = Math.max(heat, alarm) * brightness * appear;
    this.haloMaterial.visible = halo.uStrength.value > 0.01;

    this.fillMaterial.opacity = smoothstep(0.2, 1, appear) * 0.94;
    this.fillMaterial.color.copy(this.fillRest).lerp(this.fillHot, Math.max(glow, this.pulse));

    const [sx, sy] = stage.toScreen(this.model.pos[0], this.model.pos[1]);
    const legible = stage.pixelsPerUnit * LABEL_EM >= MIN_LABEL_PX;
    this.label.style.transform = `translate3d(${sx}px, ${sy}px, 0) translate(-50%, -50%)`;
    this.label.style.opacity = legible ? String(smoothstep(0.5, 1, appear) * (1 - 0.6 * dim)) : '0';
    this.label.classList.toggle('is-hot', heat > 0.5);
  }
}

/** Soft glow hugging a rounded rectangle, from its signed distance field. */
function haloMaterial(w: number, h: number, r: number, margin: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHalfSize: { value: new THREE.Vector2(w / 2, h / 2) },
      uRadius: { value: r },
      uMargin: { value: margin },
      uColor: { value: new THREE.Color() },
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

export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
