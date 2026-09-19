import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Text } from 'troika-three-text';
import type { NodeModel } from './model';
import { palette, reducedMotion, roleColor } from './palette';
import { footprint, solidGeometry, solidMaterial, STACK_LAYERS, STACK_OFFSET, stackDepth } from './shapes';
import type { Stage } from './stage';
import { makeText } from './text';

/** Height of a node's solid above the sheet. */
export const THICKNESS = 0.3;
const HALO_MARGIN = 0.6;
const NAME_SIZE = 0.3;
const DETAIL_SIZE = 0.2;
const PADDING = 0.3;
/** Labels smaller than this many pixels are hidden rather than drawn illegibly. */
const MIN_LABEL_PX = 5;

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
  /** How visible this node's runtime tower is, 0 to 1. Set by the runtime layer. */
  underneath = 0;

  /** Brief flash when a packet arrives. Decays on its own. */
  private pulse = 0;
  /** Brief red flash when a packet is dropped here. */
  private alarm = 0;

  private solid: THREE.ShaderMaterial;
  private outline: LineGeometry[] = [];
  private borderMaterial: LineMaterial;
  private cards: { fill: THREE.ShaderMaterial; border: LineMaterial }[] = [];
  private haloMaterial: THREE.ShaderMaterial;
  private segments: number;
  private rest: THREE.Color;
  private hot: THREE.Color;
  private errorHot = new THREE.Color(palette.error).multiplyScalar(3);

  /** Printed on the top face, so it foreshortens and turns with the shape. */
  private label = new THREE.Group();
  private name: Text;
  private detail?: Text;
  private badge?: Text;
  private nameColor = new THREE.Color('#C9D3E6');
  private nameHot = new THREE.Color('#FFFFFF');

  constructor(readonly model: NodeModel) {
    const [w, h] = model.size;
    this.accent = new THREE.Color(roleColor[model.role]);
    this.rest = new THREE.Color(palette.line).lerp(this.accent, 0.35);
    this.hot = this.accent.clone().multiplyScalar(3);

    const foot = footprint(model.shape, w, h);
    const geometry = solidGeometry(foot.shape, THICKNESS);
    const outlinePositions = foot.outline.flatMap((p) => [p.x, p.y, 0]);
    this.segments = foot.outline.length - 1;
    const dashed = model.role === 'external';

    const makeBorder = (material: LineMaterial) => {
      const g = new LineGeometry();
      g.setPositions(outlinePositions);
      this.outline.push(g);
      const line = new Line2(g, material);
      if (dashed) line.computeLineDistances();
      return line;
    };
    const lineMaterial = (linewidth: number) =>
      new LineMaterial({ linewidth, transparent: true, dashed, dashSize: 0.14, gapSize: 0.1, depthWrite: false });
    const solidFor = () => {
      const m = solidMaterial(false);
      m.uniforms.uColor.value = this.accent;
      return m;
    };

    // Flat view only: cards behind the node hint at runtime multiplicity. In 3D the real
    // tower hangs beneath instead.
    const layers = stackDepth(model) ? STACK_LAYERS : 0;
    for (let k = layers; k >= 1; k--) {
      const card = { fill: solidFor(), border: lineMaterial(1.2) };
      const mesh = new THREE.Mesh(geometry, card.fill);
      const border = makeBorder(card.border);
      mesh.position.set(k * STACK_OFFSET, k * STACK_OFFSET, THICKNESS - 0.02 * k);
      border.position.copy(mesh.position);
      mesh.renderOrder = 3;
      border.renderOrder = 3.1;
      this.group.add(mesh, border);
      this.cards.push(card);
    }

    this.solid = solidFor();
    const body = new THREE.Mesh(geometry, this.solid);
    body.position.z = THICKNESS;
    body.renderOrder = 3.4;
    this.borderMaterial = lineMaterial(1.5);
    const border = makeBorder(this.borderMaterial);
    border.position.z = THICKNESS + 0.002;
    border.renderOrder = 4;

    // Light spilling onto the sheet around the node's base.
    this.haloMaterial = haloMaterial(w, h, foot.glowRadius, HALO_MARGIN);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(w + HALO_MARGIN * 2, h + HALO_MARGIN * 2), this.haloMaterial);
    halo.position.z = 0.005;
    halo.renderOrder = 2;

    this.group.add(halo, body, border);
    this.group.position.set(model.pos[0], model.pos[1], 0);

    // Label: name over detail, centred vertically on the top face.
    const anchorX = foot.centred ? 'center' : 'left';
    const x = foot.centred ? 0 : -w / 2 + PADDING;
    const detailH = model.detail ? DETAIL_SIZE * 1.25 : 0;
    const blockH = detailH + NAME_SIZE * 1.2;
    if (model.detail) {
      this.detail = makeText({ text: model.detail, size: DETAIL_SIZE, color: '#7C8BA5', anchorX, anchorY: 'bottom' });
      this.detail.position.x = x;
      this.label.add(this.detail);
    }
    this.name = makeText({ text: model.label, size: NAME_SIZE, font: 'medium', anchorX, anchorY: 'bottom' });
    this.name.position.set(x, detailH, 0);
    this.label.add(this.name);
    if (model.runtime && model.runtime.count > 1) {
      this.badge = makeText({
        text: `×${model.runtime.count}`,
        size: 0.17,
        font: 'mono',
        color: '#7C8BA5',
        anchorX: 'right',
        anchorY: 'top',
      });
      this.badge.position.set(w / 2 - 0.2, h / 2 - 0.14, THICKNESS + 0.004);
      this.group.add(this.badge);
    }
    // Actors are small, so their label sits on the sheet beneath them rather than inside.
    const actor = model.shape === 'actor';
    this.label.position.set(0, actor ? -h / 2 - 0.2 - blockH : -blockH / 2, actor ? 0.004 : THICKNESS + 0.004);
    this.group.add(this.label);
  }

  get bounds() {
    const [x, y] = this.model.pos;
    const [w, h] = this.model.size;
    const stack = this.cards.length * STACK_OFFSET;
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
    if (!visible) return;

    const breathing = reducedMotion ? glow : glow * (0.8 + 0.2 * Math.sin(time * 2.6));
    const heat = Math.min(1, Math.max(breathing, this.pulse * 0.9));
    const brightness = 1 - 0.7 * dim;
    const alarm = this.alarm;
    const lean = smoothstep(12, 45, stage.view.tilt);

    const drawn = Math.ceil(appear * this.segments);
    for (const g of this.outline) g.instanceCount = drawn;

    this.borderMaterial.color
      .copy(this.rest)
      .lerp(this.hot, heat)
      .lerp(this.errorHot, alarm)
      .multiplyScalar(brightness);

    // Dimmed nodes also turn translucent, so they don't hide what's beneath the sheet.
    const opacity = smoothstep(0.2, 1, appear) * (1 - 0.55 * dim);
    this.solid.uniforms.uState.value.set(1, Math.max(heat * 0.6, alarm), dim);
    this.solid.uniforms.uOpacity.value = opacity;

    const cards = (1 - this.underneath) * (1 - lean);
    for (const card of this.cards) {
      card.border.color.copy(this.rest).multiplyScalar(0.55 * brightness);
      card.border.opacity = cards;
      card.fill.uniforms.uState.value.set(cards > 0.01 ? 1 : 0, 0, dim);
      card.fill.uniforms.uOpacity.value = opacity * cards;
    }

    const halo = this.haloMaterial.uniforms;
    halo.uColor.value.copy(this.accent).lerp(this.errorHot, alarm);
    halo.uStrength.value = Math.max(heat, alarm) * brightness * appear;
    this.haloMaterial.visible = halo.uStrength.value > 0.01;

    const legible = stage.pixelsPerUnit * NAME_SIZE >= MIN_LABEL_PX;
    this.label.visible = legible;
    const textOpacity = smoothstep(0.5, 1, appear) * (1 - 0.6 * dim);
    this.name.fillOpacity = textOpacity;
    (this.name.color as THREE.Color).copy(this.nameColor).lerp(this.nameHot, heat);
    if (this.detail) {
      this.detail.fillOpacity = textOpacity;
      this.detail.visible = stage.pixelsPerUnit * DETAIL_SIZE >= MIN_LABEL_PX;
    }
    if (this.badge) this.badge.fillOpacity = textOpacity * (1 - lean);
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
    depthWrite: false,
  });
}

export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
