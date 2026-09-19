import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { EdgeModel } from './model';
import { smoothstep, type NodeView } from './node';
import { palette } from './palette';
import type { Stage } from './stage';

const SEGMENTS = 96;
/** Points in the lookup table packets sample from. */
const SAMPLES = 128;

export interface EdgeState {
  appear: number;
  glow: number;
  dim: number;
}

export class EdgeView {
  readonly id: string;
  readonly state: EdgeState = { appear: 0, glow: 0, dim: 0 };
  readonly group = new THREE.Group();
  readonly length: number;

  private geometry: LineGeometry;
  private material: LineMaterial;
  private rest = new THREE.Color(palette.line);
  private hot: THREE.Color;
  /** Evenly spaced points along the curve, so packets don't do arc-length maths per frame. */
  private table = new Float32Array((SAMPLES + 1) * 2);
  private label?: HTMLElement;
  private mid: THREE.Vector3;

  constructor(
    readonly model: EdgeModel,
    curve: THREE.Curve<THREE.Vector3>,
    readonly from: NodeView,
    readonly to: NodeView,
    labelLayer: HTMLElement,
  ) {
    this.id = model.id;
    this.hot = from.accent.clone().multiplyScalar(2.2);
    this.length = curve.getLength();
    this.mid = curve.getPointAt(0.5);

    curve.getSpacedPoints(SAMPLES).forEach((p, i) => {
      this.table[i * 2] = p.x;
      this.table[i * 2 + 1] = p.y;
    });

    this.geometry = new LineGeometry();
    this.geometry.setPositions(curve.getSpacedPoints(SEGMENTS).flatMap((p) => [p.x, p.y, 0]));
    this.material = new LineMaterial({
      linewidth: 1.5,
      transparent: true,
      dashed: model.style === 'dashed',
      dashSize: 0.16,
      gapSize: 0.12,
      depthTest: false,
      depthWrite: false,
    });
    const line = new Line2(this.geometry, this.material);
    if (model.style === 'dashed') line.computeLineDistances();
    line.renderOrder = 1;
    this.group.add(line);

    if (model.label) {
      this.label = document.createElement('div');
      this.label.className = 'edge-label';
      this.label.textContent = model.label;
      labelLayer.appendChild(this.label);
    }
  }

  /** How bright traffic on this edge should be, given dimming. */
  get brightness() {
    return 1 - 0.75 * this.state.dim;
  }

  /** Point at fraction `u` of the way along, written into `out` (x, y). */
  sample(u: number, out: { x: number; y: number }) {
    const f = Math.min(Math.max(u, 0), 1) * SAMPLES;
    const i = Math.min(Math.floor(f), SAMPLES - 1);
    const t = f - i;
    const a = i * 2;
    out.x = this.table[a] + (this.table[a + 2] - this.table[a]) * t;
    out.y = this.table[a + 1] + (this.table[a + 3] - this.table[a + 1]) * t;
  }

  update(stage: Stage) {
    const { appear, glow } = this.state;
    const visible = appear > 0.001;
    this.group.visible = visible;
    this.geometry.instanceCount = Math.ceil(appear * SEGMENTS);
    this.material.color.copy(this.rest).lerp(this.hot, glow).multiplyScalar(this.brightness);

    if (this.label) {
      this.label.style.visibility = visible ? 'visible' : 'hidden';
      if (!visible) return;
      this.label.style.transform = stage.labelTransform(this.mid.x, this.mid.y, 0, 'translate(-50%, -130%)');
      this.label.style.opacity = String(smoothstep(0.7, 1, appear) * this.brightness);
    }
  }
}
