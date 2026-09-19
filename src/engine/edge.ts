import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { smoothstep, type NodeView } from './node';
import { palette, reducedMotion } from './palette';
import type { EdgeSpec } from './types';

const SEGMENTS = 96;
const PACKETS = 4;
const TRAIL = 12;
/** Distance between trail dots, in world units. */
const TRAIL_SPACING = 0.03;
/** Packet speed in world units per second. */
const SPEED = reducedMotion ? 0.8 : 2.4;
const GAP = 0.1;

export interface EdgeState {
  appear: number;
  glow: number;
  dim: number;
  flow: number;
}

export class EdgeView {
  readonly id: string;
  readonly state: EdgeState = { appear: 0, glow: 0, dim: 0, flow: 0 };
  readonly group = new THREE.Group();

  private curve: THREE.CubicBezierCurve3;
  private length: number;
  private geometry: LineGeometry;
  private material: LineMaterial;
  private packets: THREE.InstancedMesh;
  private rest = new THREE.Color(palette.line);
  private hot: THREE.Color;
  private accent: THREE.Color;
  private offsets: number[];

  private matrix = new THREE.Matrix4();
  private point = new THREE.Vector3();
  private scale = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private color = new THREE.Color();

  constructor(
    readonly spec: EdgeSpec,
    readonly from: NodeView,
    readonly to: NodeView,
  ) {
    this.id = `${spec.from}->${spec.to}`;
    this.accent = from.accent.clone();
    this.hot = this.accent.clone().multiplyScalar(2.2);

    this.curve = connect(from, to);
    this.length = this.curve.getLength();

    this.geometry = new LineGeometry();
    this.geometry.setPositions(this.curve.getSpacedPoints(SEGMENTS).flatMap((p) => [p.x, p.y, 0]));
    this.material = new LineMaterial({
      linewidth: 1.5,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const line = new Line2(this.geometry, this.material);
    line.renderOrder = 1;

    this.packets = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.05, 12),
      new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
      PACKETS * TRAIL,
    );
    this.packets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.packets.frustumCulled = false;
    this.packets.renderOrder = 2;
    for (let i = 0; i < PACKETS * TRAIL; i++) this.packets.setColorAt(i, this.color.setRGB(0, 0, 0));

    // Slightly uneven spacing reads as traffic rather than a conveyor belt.
    this.offsets = Array.from({ length: PACKETS }, (_, i) => (i + (Math.random() - 0.5) * 0.35) / PACKETS);

    this.group.add(line, this.packets);
  }

  update(time: number) {
    const { appear, glow, dim, flow } = this.state;
    const visible = appear > 0.001;
    this.group.visible = visible;
    if (!visible) return;

    const brightness = 1 - 0.75 * dim;
    this.geometry.instanceCount = Math.ceil(appear * SEGMENTS);
    this.material.color.copy(this.rest).lerp(this.hot, glow).multiplyScalar(brightness);

    const phase = (time * SPEED) / this.length;
    const trailStep = TRAIL_SPACING / this.length;
    for (let p = 0; p < PACKETS; p++) {
      const head = (phase + this.offsets[p]) % 1;
      for (let k = 0; k < TRAIL; k++) {
        const i = p * TRAIL + k;
        const u = head - k * trailStep;
        const falloff = 1 - k / TRAIL;
        // Fade in and out at the ends, and never run ahead of the drawn line.
        const endFade = smoothstep(0, 0.08, u) * (1 - smoothstep(0.92, 1, u)) * (u <= appear ? 1 : 0);
        const strength = flow * endFade * brightness;

        this.curve.getPointAt(Math.min(Math.max(u, 0), 1), this.point);
        this.point.z = 0;
        const size = strength > 0 ? (k === 0 ? 1.1 : 0.85 * falloff) : 0;
        this.matrix.compose(this.point, this.quaternion, this.scale.setScalar(size));
        this.packets.setMatrixAt(i, this.matrix);
        this.packets.setColorAt(i, this.color.copy(this.accent).multiplyScalar((k === 0 ? 5 : 1.6 * falloff) * strength));
      }
    }
    this.packets.instanceMatrix.needsUpdate = true;
    this.packets.instanceColor!.needsUpdate = true;
  }
}

/** An S-curve from the facing side of `a` to the facing side of `b`. */
function connect(a: NodeView, b: NodeView) {
  const [ax, ay] = a.spec.pos;
  const [bx, by] = b.spec.pos;
  const dx = bx - ax;
  const dy = by - ay;
  const horizontal = Math.abs(dx) > (a.width + b.width) / 4;

  const v = (x: number, y: number) => new THREE.Vector3(x, y, 0);
  if (horizontal) {
    const s = Math.sign(dx);
    const start = v(ax + s * (a.width / 2 + GAP), ay);
    const end = v(bx - s * (b.width / 2 + GAP), by);
    const k = Math.abs(end.x - start.x) * 0.5;
    return new THREE.CubicBezierCurve3(start, v(start.x + s * k, start.y), v(end.x - s * k, end.y), end);
  }
  const s = Math.sign(dy);
  const start = v(ax, ay + s * (a.height / 2 + GAP));
  const end = v(bx, by - s * (b.height / 2 + GAP));
  const k = Math.abs(end.y - start.y) * 0.5;
  return new THREE.CubicBezierCurve3(start, v(start.x, start.y + s * k), v(end.x, end.y - s * k), end);
}
