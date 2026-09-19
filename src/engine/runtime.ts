import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Graph } from './graph';
import type { NodeModel, Route, Runtime } from './model';
import { smoothstep, type NodeView } from './node';
import { palette } from './palette';
import type { Stage } from './stage';

/** Depth of the gap between the logical sheet and the first slab of each tower. */
const TOWER_TOP = 2.2;
/** Vertical distance between slabs. */
const PITCH = 0.16;
const SLAB_THICKNESS = 0.07;
/** Slabs are a little smaller than the node above them, so the tower reads as beneath it. */
const SLAB_INSET = 0.82;
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

/** The running instances of one logical node: a tower of slabs hanging beneath it. */
export class Cluster {
  readonly state: ClusterState = { appear: 0, dim: 0 };
  /** Centre of each slab. */
  readonly positions: THREE.Vector3[] = [];
  readonly heat: Float32Array;
  readonly route: Route;
  readonly slab: [number, number];
  readonly bottom: number;
  readonly label?: HTMLElement;
  /** Fine lines from the node's corners down to the top of its tower. */
  readonly tethers: LineSegments2;
  readonly tetherMaterial: LineMaterial;

  constructor(
    readonly node: NodeView,
    readonly kind: Runtime['kind'],
    readonly count: number,
    route: Runtime['route'],
    readonly offset: number,
    labelLayer: HTMLElement,
  ) {
    this.route = route ?? DEFAULT_ROUTE[kind];
    this.heat = new Float32Array(count);
    const [w, h] = node.model.size;
    this.slab = [w * SLAB_INSET, h * SLAB_INSET];
    const pitch = PITCH * Math.min(1, MAX_SLABS_TALL / count);
    const [x, y] = node.model.pos;
    for (let i = 0; i < count; i++) this.positions.push(new THREE.Vector3(x, y, -TOWER_TOP - i * pitch));
    this.bottom = -TOWER_TOP - (count - 1) * pitch - SLAB_THICKNESS;

    const [sw, sh] = [this.slab[0] / 2, this.slab[1] / 2];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(
      corners.flatMap(([dx, dy]) => [
        x + (dx * w) / 2, y + (dy * h) / 2, 0,
        x + dx * sw, y + dy * sh, -TOWER_TOP + SLAB_THICKNESS / 2,
      ]),
    );
    this.tetherMaterial = new LineMaterial({
      linewidth: 1,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.tethers = new LineSegments2(geometry, this.tetherMaterial);
    this.tethers.renderOrder = -8;

    if (count > 1) {
      this.label = document.createElement('div');
      this.label.className = 'cluster-label';
      this.label.textContent = `${count} ${kind}`;
      labelLayer.appendChild(this.label);
    }
  }

  /** Corners of the tower's bounding box, for camera framing. */
  get corners() {
    const [x, y] = this.node.model.pos;
    const [hw, hh] = [this.slab[0] / 2, this.slab[1] / 2];
    const out: THREE.Vector3[] = [];
    for (const z of [-TOWER_TOP, this.bottom]) {
      for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) out.push(new THREE.Vector3(x + dx, y + dy, z));
    }
    return out;
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
}

/**
 * What each logical node runs as, shown as towers of slabs hanging beneath a frosted
 * sheet that carries the diagram. Lowering the fog makes the sheet clear.
 */
export class RuntimeLayer {
  readonly group = new THREE.Group();
  readonly clusters = new Map<string, Cluster>();
  /** How much the sheet hides what's beneath it, 0 to 1. */
  readonly state = { fog: 1 };

  private mesh: THREE.InstancedMesh;
  private slabState: THREE.InstancedBufferAttribute;
  private sheetMaterial: THREE.MeshBasicMaterial;
  private sheetEdge: LineMaterial;
  private sheetColor = new THREE.Color('#3A4A6B');

  constructor(
    graph: Graph,
    private nodes: Map<string, NodeView>,
    labelLayer: HTMLElement,
  ) {
    let total = 0;
    for (const model of graph.nodes.values()) {
      if (OUTSIDE.has(model.role)) continue;
      const runtime = runtimeOf(model);
      const cluster = new Cluster(nodes.get(model.id)!, runtime.kind, runtime.count, runtime.route, total, labelLayer);
      total += runtime.count;
      this.clusters.set(model.id, cluster);
      this.group.add(cluster.tethers);
    }

    const colors = new Float32Array(total * 3);
    this.slabState = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    this.slabState.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    geometry.setAttribute('aState', this.slabState);

    this.mesh = new THREE.InstancedMesh(geometry, slabMaterial(), total);
    this.mesh.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (const cluster of this.clusters.values()) {
      scale.set(cluster.slab[0], cluster.slab[1], SLAB_THICKNESS);
      cluster.positions.forEach((p, i) => {
        const n = cluster.offset + i;
        this.mesh.setMatrixAt(n, matrix.compose(p, q, scale));
        colors.set([cluster.node.accent.r, cluster.node.accent.g, cluster.node.accent.b], n * 3);
      });
    }

    // The sheet the diagram sits on, covering every node with some room around.
    const box = new THREE.Box2();
    for (const node of nodes.values()) box.union(node.bounds);
    box.expandByScalar(SHEET_PAD);
    const size = box.getSize(new THREE.Vector2());
    const centre = box.getCenter(new THREE.Vector2());
    this.sheetMaterial = new THREE.MeshBasicMaterial({
      color: palette.bg,
      transparent: true,
      depthWrite: false,
    });
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.y), this.sheetMaterial);
    sheet.position.set(centre.x, centre.y, -0.05);
    sheet.renderOrder = -5;

    const edge = new LineGeometry();
    const [x0, y0, x1, y1] = [box.min.x, box.min.y, box.max.x, box.max.y];
    edge.setPositions([x0, y0, -0.05, x1, y0, -0.05, x1, y1, -0.05, x0, y1, -0.05, x0, y0, -0.05]);
    this.sheetEdge = new LineMaterial({ linewidth: 1, transparent: true, depthWrite: false });
    const edgeLine = new Line2(edge, this.sheetEdge);
    edgeLine.renderOrder = -4;

    this.group.add(this.mesh, sheet, edgeLine);
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
    const state = this.slabState.array as Float32Array;
    let anyVisible = false;

    for (const cluster of this.clusters.values()) {
      const { appear, dim } = cluster.state;
      anyVisible ||= appear > 0.001;
      cluster.node.underneath = appear;
      cluster.tethers.visible = appear > 0.001;
      cluster.tetherMaterial.color.copy(cluster.node.accent).multiplyScalar(0.4 * (1 - 0.7 * dim));
      cluster.tetherMaterial.opacity = smoothstep(0, 0.5, appear);
      for (let i = 0; i < cluster.count; i++) {
        cluster.heat[i] *= decay;
        const n = (cluster.offset + i) * 3;
        // Towers grow downward: each slab appears a little after the one above it.
        const start = (i / cluster.count) * 0.6;
        state[n] = smoothstep(start, start + 0.4, appear);
        state[n + 1] = cluster.heat[i];
        state[n + 2] = dim;
      }

      if (cluster.label) {
        const visible = appear > 0.5;
        cluster.label.style.visibility = visible ? 'visible' : 'hidden';
        if (visible) {
          const [x, y] = cluster.node.model.pos;
          cluster.label.style.transform = stage.labelTransform(x, y, cluster.bottom - 0.15, 'translate(-50%, 0)');
          cluster.label.style.opacity = String(smoothstep(0.6, 1, appear) * (1 - 0.7 * dim));
        }
      }
    }
    this.slabState.needsUpdate = true;
    this.mesh.visible = anyVisible;

    // The sheet only shows once the camera leans back; looking straight down it's invisible.
    const lean = smoothstep(2, 25, stage.view.tilt);
    this.sheetMaterial.opacity = anyVisible ? 0.3 + 0.65 * this.state.fog : lean * 0.5;
    this.sheetEdge.color.copy(this.sheetColor);
    this.sheetEdge.opacity = lean * 0.8;
    // The dot grid sits on the sheet; thin it out when looking through to the towers.
    (stage.grid.material as THREE.PointsMaterial).opacity = 0.35 + 0.65 * this.state.fog;
  }
}

export function runtimeOf(model: NodeModel): Runtime {
  return model.runtime ?? { kind: 'replicas', count: 1 };
}

/** Solid slabs with shaded faces and bright edges, drawn with depth so towers occlude properly. */
function slabMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFill: { value: new THREE.Color(palette.fill) },
      uLine: { value: new THREE.Color(palette.line) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute vec3 aState;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vState;
      void main() {
        vUv = uv;
        vNormal = normal;
        vColor = aColor;
        vState = aState;
        // Slabs grow into place as they appear.
        vec3 p = position * vec3(mix(0.3, 1.0, aState.x), mix(0.3, 1.0, aState.x), 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uFill;
      uniform vec3 uLine;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vState;
      void main() {
        float appear = vState.x;
        float heat = vState.y;
        float dim = vState.z;
        if (appear < 0.01) discard;

        // Distance to the nearest edge of this face, about a pixel and a half wide.
        vec2 e = min(vUv, 1.0 - vUv);
        float d = min(e.x, e.y);
        float w = fwidth(d);
        float edge = 1.0 - smoothstep(w * 0.5, w * 1.5, d);

        // Tops catch the light; sides are darker, so the slabs read as solid.
        float top = abs(vNormal.z);
        float shade = mix(0.55, 1.0, top);
        float brightness = (1.0 - 0.7 * dim) * appear;

        vec3 line = mix(mix(uLine, vColor, 0.45), vColor * 3.0, heat) * brightness;
        vec3 fill = mix(uFill * 1.6, vColor * 0.35, 0.25 + heat * 0.5) * shade * brightness;
        gl_FragColor = vec4(mix(fill, line, edge * mix(0.6, 1.0, top)), 1.0);
      }
    `,
  });
}
