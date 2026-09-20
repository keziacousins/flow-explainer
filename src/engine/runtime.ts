import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Graph } from './graph';
import type { NodeModel, Route, Runtime } from './model';
import { smoothstep, type NodeView } from './node';
import { palette } from './palette';
import { footprint, solidGeometry, solidMaterial } from './shapes';
import type { Stage } from './stage';

/** The first slab sits just beneath the sheet, directly under its node. */
const TOWER_TOP = -0.14;
/** Vertical distance between slabs. */
const PITCH = 0.16;
const SLAB_THICKNESS = 0.1;
/** Slabs are a touch smaller than the node above, so the node reads as the tower's cap. */
const SLAB_INSET = 0.94;
/** Towers taller than this many slabs are compressed to fit. */
const MAX_SLABS_TALL = 40;
const SHEET_PAD = 1.4;

const DEFAULT_ROUTE: Record<Runtime['kind'], Route> = {
  replicas: 'any',
  shards: 'all',
  partitions: 'key',
};

/** Roles that aren't ours to run, so they have no runtime instances. */
const OUTSIDE = new Set(['external', 'client']);

export interface ClusterState {
  appear: number;
  dim: number;
}

/** The running instances of one logical node: a tower of slabs stacked down beneath it. */
export class Cluster {
  readonly state: ClusterState = { appear: 0, dim: 0 };
  /** Centre of each slab, top to bottom. */
  readonly positions: THREE.Vector3[] = [];
  readonly heat: Float32Array;
  readonly route: Route;
  readonly mesh: THREE.InstancedMesh;
  readonly bottom: number;
  private slabState: THREE.InstancedBufferAttribute;

  constructor(
    readonly node: NodeView,
    readonly kind: Runtime['kind'],
    readonly count: number,
    route: Runtime['route'],
  ) {
    this.route = route ?? DEFAULT_ROUTE[kind];
    this.heat = new Float32Array(count);
    const model = node.model;
    const [w, h] = model.size;
    const [x, y] = model.pos;
    const pitch = PITCH * Math.min(1, MAX_SLABS_TALL / count);

    // Each instance is the node's own footprint, a little smaller and thinner.
    const shape = footprint(model.shape, w * SLAB_INSET, h * SLAB_INSET).shape;
    const geometry = solidGeometry(shape, SLAB_THICKNESS, 0.02);
    const colors = new Float32Array(count * 3);
    this.slabState = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.slabState.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    geometry.setAttribute('aState', this.slabState);
    this.mesh = new THREE.InstancedMesh(geometry, solidMaterial(true), count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.userData.nodeId = model.id;

    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const top = TOWER_TOP - i * pitch;
      this.mesh.setMatrixAt(i, matrix.makeTranslation(x, y, top));
      this.positions.push(new THREE.Vector3(x, y, top - SLAB_THICKNESS / 2));
      colors.set([node.accent.r, node.accent.g, node.accent.b], i * 3);
    }
    this.bottom = TOWER_TOP - (count - 1) * pitch - SLAB_THICKNESS;
  }

  /** Corners of the tower's bounding box, for camera framing. */
  get corners() {
    const [x, y] = this.node.model.pos;
    const [hw, hh] = [this.node.model.size[0] / 2, this.node.model.size[1] / 2];
    const out: THREE.Vector3[] = [];
    for (const z of [TOWER_TOP, this.bottom]) {
      for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) out.push(new THREE.Vector3(x + dx, y + dy, z));
    }
    return out;
  }

  /** Where a callout about this tower points: the middle of its front face. */
  get anchor() {
    const [x, y] = this.node.model.pos;
    return new THREE.Vector3(x, y - (this.node.model.size[1] * SLAB_INSET) / 2, (TOWER_TOP + this.bottom) / 2);
  }

  get visible() {
    return this.state.appear > 0.5;
  }

  get brightness() {
    return this.state.appear * (1 - 0.75 * this.state.dim);
  }

  /** Instances a request to this node reaches. `key` picks consistently for the same key. */
  pick(key: number, route: Route = this.route): number[] {
    if (route === 'all') return this.positions.map((_, i) => i);
    if (route === 'key') return [key % this.count];
    return [Math.floor(Math.random() * this.count)];
  }

  /** Instances a request leaves from when no earlier hop says which. */
  origin(): number[] {
    if (this.route === 'all') return this.positions.map((_, i) => i);
    return [Math.floor(Math.random() * this.count)];
  }

  update(decay: number) {
    const { appear, dim } = this.state;
    this.mesh.visible = appear > 0.001;
    const state = this.slabState.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      this.heat[i] *= decay;
      // Towers grow downward: each slab appears a little after the one above it.
      const start = (i / this.count) * 0.6;
      state[i * 3] = smoothstep(start, start + 0.4, appear);
      state[i * 3 + 1] = this.heat[i];
      state[i * 3 + 2] = dim;
    }
    this.slabState.needsUpdate = true;
  }
}

/**
 * What each logical node runs as, shown as towers of slabs stacked down beneath a
 * frosted sheet that carries the diagram. Lowering the fog makes the sheet clear.
 */
export class RuntimeLayer {
  readonly group = new THREE.Group();
  readonly clusters = new Map<string, Cluster>();
  /** How much the sheet hides what's beneath it, 0 to 1. */
  readonly state = { fog: 1 };

  private sheetMaterial: THREE.MeshBasicMaterial;
  private sheetEdge: LineMaterial;
  private sheetColor = new THREE.Color('#3A4A6B');

  constructor(
    graph: Graph,
    private nodes: Map<string, NodeView>,
  ) {
    for (const model of graph.nodes.values()) {
      if (OUTSIDE.has(model.role)) continue;
      const runtime = runtimeOf(model);
      const cluster = new Cluster(nodes.get(model.id)!, runtime.kind, runtime.count, runtime.route);
      this.clusters.set(model.id, cluster);
      this.group.add(cluster.mesh);
    }

    // The sheet the diagram sits on, covering every node with some room around.
    const box = new THREE.Box2();
    for (const node of nodes.values()) box.union(node.bounds);
    box.expandByScalar(SHEET_PAD);
    const size = box.getSize(new THREE.Vector2());
    const centre = box.getCenter(new THREE.Vector2());
    this.sheetMaterial = new THREE.MeshBasicMaterial({ color: palette.bg, transparent: true, depthWrite: false });
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.y), this.sheetMaterial);
    sheet.position.set(centre.x, centre.y, -0.05);
    sheet.renderOrder = -5;

    const edge = new LineGeometry();
    const [x0, y0, x1, y1] = [box.min.x, box.min.y, box.max.x, box.max.y];
    edge.setPositions([x0, y0, -0.05, x1, y0, -0.05, x1, y1, -0.05, x0, y1, -0.05, x0, y0, -0.05]);
    this.sheetEdge = new LineMaterial({ linewidth: 1, transparent: true, depthWrite: false });
    const edgeLine = new Line2(edge, this.sheetEdge);
    edgeLine.renderOrder = -4;

    this.group.add(sheet, edgeLine);
  }

  /** Where a packet to or from this node should start or end on the runtime layer. */
  point(nodeId: string, index?: number): THREE.Vector3 {
    const cluster = this.clusters.get(nodeId);
    if (cluster && index !== undefined) return cluster.positions[index];
    // Nodes without instances (shoppers, providers) send from the sheet.
    const [x, y] = this.nodes.get(nodeId)!.model.pos;
    return new THREE.Vector3(x, y, 0);
  }

  /** Whether traffic between two nodes should also be shown on the runtime layer. */
  active(a: string, b: string) {
    const ca = this.clusters.get(a);
    const cb = this.clusters.get(b);
    if (!ca && !cb) return false;
    return (!ca || ca.visible) && (!cb || cb.visible);
  }

  brightness(nodeId: string) {
    return this.clusters.get(nodeId)?.brightness ?? 1;
  }

  flash(nodeId: string, index: number) {
    const cluster = this.clusters.get(nodeId);
    if (cluster) cluster.heat[index] = 1;
  }

  update(delta: number, stage: Stage) {
    const decay = Math.exp(-delta * 4);
    let anyVisible = false;
    for (const cluster of this.clusters.values()) {
      cluster.update(decay);
      cluster.node.underneath = cluster.state.appear;
      anyVisible ||= cluster.state.appear > 0.001;
    }

    // The sheet only shows once the camera leans back; looking straight down it's invisible.
    const lean = smoothstep(2, 25, stage.view.tilt);
    this.sheetMaterial.opacity = anyVisible ? 0.3 + 0.65 * this.state.fog : lean * 0.5;
    this.sheetEdge.color.copy(this.sheetColor);
    this.sheetEdge.opacity = lean * 0.8;
    // The dot grid sits on the sheet; thin it out when looking through to the towers, and
    // fade it when zoomed out so far that the dots crowd into a moiré texture.
    const spacing = stage.pixelsPerUnit * 0.5;
    (stage.grid.material as THREE.PointsMaterial).opacity =
      (0.35 + 0.65 * this.state.fog) * smoothstep(5, 12, spacing);
  }
}

export function runtimeOf(model: NodeModel): Runtime {
  return model.runtime ?? { kind: 'replicas', count: 1 };
}
