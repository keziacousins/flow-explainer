import * as THREE from 'three';
import { gsap } from 'gsap';
import type { EdgeView } from './edge';
import type { Graph } from './graph';
import type { GroupView } from './group';
import type { SceneModel } from './model';
import type { NodeView } from './node';
import { reducedMotion } from './palette';
import type { RuntimeLayer } from './runtime';
import type { Stage } from './stage';
import type { Traffic } from './traffic';

/** Default camera angles when a scene shows the runtime layer: from above, off to one side. */
const RUNTIME_TILT = 62;
const RUNTIME_TURN = -38;
/** Default fog when the runtime layer is showing. */
const RUNTIME_FOG = 0.15;

export interface SceneChange {
  index: number;
  scene: SceneModel;
  forward: boolean;
  /** Colour of the first highlighted node or edge, for tying the caption to the diagram. */
  accent: string | null;
}

/**
 * Moves between scenes. Each scene is a target state, and every transition
 * tweens from wherever things are now, so jumping or reversing mid-animation works.
 */
export class Director {
  index = -1;
  /** True once the viewer has panned or zoomed; the camera stays put until reframed. */
  cameraFree = false;
  private timeline?: gsap.core.Timeline;
  private listeners: ((change: SceneChange) => void)[] = [];

  constructor(
    private stage: Stage,
    private graph: Graph,
    private nodes: Map<string, NodeView>,
    private edges: Map<string, EdgeView>,
    private groups: Map<string, GroupView>,
    private runtime: RuntimeLayer,
    private traffic: Traffic,
  ) {
    stage.onResize(() => {
      if (this.index < 0 || this.cameraFree) return;
      Object.assign(this.stage.view, this.framing(this.scenes[this.index]));
    });
  }

  get scenes() {
    return this.graph.model.scenes;
  }

  onChange(fn: (change: SceneChange) => void) {
    this.listeners.push(fn);
  }

  next() {
    this.go(this.index + 1);
  }

  prev() {
    this.go(this.index - 1);
  }

  go(target: number) {
    const index = Math.min(Math.max(target, 0), this.scenes.length - 1);
    if (index === this.index) return;
    const first = this.index < 0;
    const forward = index > this.index;
    this.index = index;
    this.cameraFree = false;
    const scene = this.scenes[index];
    const graph = this.graph;

    const shown = graph.nodeIds(scene.show);
    const hotNodes = graph.nodeIds(scene.highlight);
    const hotEdges = graph.edgeIds(scene.highlight);
    const focusNodes = scene.focus ? graph.nodeIds(scene.focus) : null;
    const focusEdges = scene.focus ? graph.edgeIds(scene.focus) : null;
    const shownGroups = new Set(parts(scene.groups));
    const onUse = scene.reveal === 'onUse';
    const underneath = graph.nodeIds(scene.runtime);

    // New things build in left to right, following the usual direction of flow.
    const nodes = [...this.nodes.values()].sort((a, b) => a.model.pos[0] - b.model.pos[0]);
    const entering = nodes.filter((n) => shown.has(n.model.id) && n.state.appear < 1);
    const nodeStagger = Math.min(0.14, 1.2 / Math.max(entering.length, 1));
    const edgeStart = 0.7 + nodeStagger * Math.max(entering.length - 1, 0);

    this.traffic.setScene(scene, edgeStart + (onUse ? 0.2 : 0.5));

    this.timeline?.kill();
    const tl = gsap.timeline();
    this.timeline = tl;

    for (const node of nodes) {
      const id = node.model.id;
      const on = shown.has(id);
      const k = entering.indexOf(node);
      if (k >= 0) tl.to(node.state, { appear: 1, duration: 0.9, ease: 'power2.inOut' }, 0.3 + nodeStagger * k);
      else if (!on && node.state.appear > 0) tl.to(node.state, { appear: 0, duration: 0.4, ease: 'power1.in' }, 0);
      tl.to(
        node.state,
        { glow: hotNodes.has(id) ? 1 : 0, dim: focusNodes && !focusNodes.has(id) ? 1 : 0, duration: 0.8 },
        0.4,
      );
    }

    const edges = [...this.edges.values()].sort((a, b) => a.from.model.pos[0] - b.from.model.pos[0]);
    const drawing = edges.filter(
      (e) => !onUse && shown.has(e.model.from) && shown.has(e.model.to) && e.state.appear < 1,
    );
    const edgeStagger = Math.min(0.12, 1 / Math.max(drawing.length, 1));
    for (const edge of edges) {
      const { from, to } = edge.model;
      const on = shown.has(from) && shown.has(to);
      const k = drawing.indexOf(edge);
      if (k >= 0) {
        tl.to(edge.state, { appear: 1, duration: 0.8, ease: 'power2.inOut' }, edgeStart + edgeStagger * k);
      } else if ((!on || onUse) && edge.state.appear > 0) {
        // In `onUse` scenes, edges are cleared so the scene's traffic can draw them afresh.
        tl.to(edge.state, { appear: 0, duration: 0.35, ease: 'power1.in' }, 0);
      }
      const focused =
        !focusNodes || focusEdges!.has(edge.id) || (focusNodes.has(from) && focusNodes.has(to));
      tl.to(edge.state, { glow: hotEdges.has(edge.id) ? 1 : 0, dim: focused ? 0 : 1, duration: 0.8 }, 0.4);
    }

    for (const group of this.groups.values()) {
      const on = shownGroups.has(group.model.id) || scene.groups === '*';
      const focused = !focusNodes || group.model.members.some((m) => focusNodes.has(m));
      tl.to(group.state, { appear: on ? 1 : 0, dim: focused ? 0 : 1, duration: on ? 0.8 : 0.4 }, on ? 0.2 : 0);
    }

    // Runtime instances rise into view after the camera has started to lean back.
    const clusters = [...this.runtime.clusters.entries()].sort((a, b) => a[1].node.model.pos[0] - b[1].node.model.pos[0]);
    const rising = clusters.filter(([id, c]) => underneath.has(id) && c.state.appear < 1);
    const clusterStagger = Math.min(0.08, 1 / Math.max(rising.length, 1));
    for (const [id, cluster] of clusters) {
      const on = underneath.has(id);
      const k = rising.findIndex(([r]) => r === id);
      if (k >= 0) tl.to(cluster.state, { appear: 1, duration: 0.8, ease: 'power2.out' }, 0.7 + clusterStagger * k);
      else if (!on && cluster.state.appear > 0) tl.to(cluster.state, { appear: 0, duration: 0.5, ease: 'power1.in' }, 0);
      tl.to(cluster.state, { dim: focusNodes && !focusNodes.has(id) ? 1 : 0, duration: 0.8 }, 0.4);
    }
    tl.to(this.runtime.state, { fog: underneath.size ? (scene.fog ?? RUNTIME_FOG) : 1, duration: 1.2 }, 0.3);

    const view = this.framing(scene);
    if (first) Object.assign(this.stage.view, view);
    else tl.to(this.stage.view, { ...view, duration: 1.6, ease: 'power3.inOut' }, 0);

    if (reducedMotion) tl.timeScale(3);

    for (const fn of this.listeners) fn({ index, scene, forward, accent: this.accentOf(scene) });
  }

  /** Animate the camera back to the current scene's framing. */
  reframe() {
    if (this.index < 0) return;
    this.cameraFree = false;
    const view = this.framing(this.scenes[this.index]);
    gsap.to(this.stage.view, { ...view, duration: reducedMotion ? 0.3 : 0.9, ease: 'power3.inOut' });
  }

  private accentOf(scene: SceneModel) {
    const first = parts(scene.highlight)[0];
    if (!first || first === '*') return null;
    const edge = first.includes('->') ? [...this.graph.edgeIds(first)][0] : undefined;
    const node = edge ? this.edges.get(edge)?.from : this.nodes.get([...this.graph.nodeIds(first)][0]);
    return node ? `#${node.accent.getHexString()}` : null;
  }

  /** The view for a scene: its angles, and the position and zoom that fit its nodes. */
  private framing(scene: SceneModel) {
    const underneath = this.graph.nodeIds(scene.runtime);
    const tilt = scene.tilt ?? (underneath.size ? RUNTIME_TILT : 0);
    const turn = scene.turn ?? (underneath.size ? RUNTIME_TURN : 0);
    const points: THREE.Vector3[] = [];
    for (const id of this.graph.nodeIds(scene.camera ?? scene.show)) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const { min, max } = node.bounds;
      points.push(new THREE.Vector3(min.x, min.y, 0), new THREE.Vector3(max.x, max.y, 0));
      points.push(new THREE.Vector3(min.x, max.y, 0), new THREE.Vector3(max.x, min.y, 0));
      const cluster = this.runtime.clusters.get(id);
      if (cluster && underneath.has(id)) points.push(...cluster.corners);
    }
    return { ...this.stage.framing(points, tilt, turn), tilt, turn };
  }
}

function parts(selector: string | string[] | undefined): string[] {
  if (selector === undefined) return [];
  return typeof selector === 'string' ? [selector] : selector;
}
