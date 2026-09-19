import * as THREE from 'three';
import { gsap } from 'gsap';
import type { EdgeView } from './edge';
import type { NodeView } from './node';
import { reducedMotion } from './palette';
import type { Stage } from './stage';
import type { SceneSpec, Selector } from './types';

export interface SceneChange {
  index: number;
  scene: SceneSpec;
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
    private nodes: Map<string, NodeView>,
    private edges: Map<string, EdgeView>,
    readonly scenes: SceneSpec[],
  ) {
    stage.onResize(() => {
      if (this.index < 0 || this.cameraFree) return;
      const frame = this.framing(this.scenes[this.index]);
      this.stage.camera.position.set(frame.x, frame.y, this.stage.camera.position.z);
      this.stage.camera.zoom = frame.zoom;
    });
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

    const nodeIds = [...this.nodes.keys()];
    const allIds = [...nodeIds, ...this.edges.keys()];
    const shown = resolve(scene.show, nodeIds);
    const flows = resolve(scene.flow, [...this.edges.keys()]);
    const hot = resolve(scene.highlight, allIds);
    const focus = scene.focus ? resolve(scene.focus, allIds) : null;

    this.timeline?.kill();
    const tl = gsap.timeline();
    this.timeline = tl;

    // New things build in left to right, following the direction of flow.
    const nodes = [...this.nodes.values()].sort((a, b) => a.spec.pos[0] - b.spec.pos[0]);
    let entering = 0;
    for (const node of nodes) {
      const id = node.spec.id;
      const on = shown.has(id);
      if (on && node.state.appear < 1) {
        tl.to(node.state, { appear: 1, duration: 0.9, ease: 'power2.inOut' }, 0.3 + 0.14 * entering++);
      } else if (!on && node.state.appear > 0) {
        tl.to(node.state, { appear: 0, duration: 0.4, ease: 'power1.in' }, 0);
      }
      tl.to(
        node.state,
        { glow: hot.has(id) ? 1 : 0, dim: focus && !focus.has(id) ? 1 : 0, duration: 0.8, ease: 'power2.inOut' },
        0.4,
      );
    }

    const edges = [...this.edges.values()].sort((a, b) => a.from.spec.pos[0] - b.from.spec.pos[0]);
    const edgeStart = 0.7 + 0.14 * Math.max(entering - 1, 0);
    entering = 0;
    for (const edge of edges) {
      const { from, to } = edge.spec;
      const on = shown.has(from) && shown.has(to);
      if (on && edge.state.appear < 1) {
        tl.to(edge.state, { appear: 1, duration: 0.8, ease: 'power2.inOut' }, edgeStart + 0.12 * entering++);
      } else if (!on && edge.state.appear > 0) {
        tl.to(edge.state, { appear: 0, flow: 0, duration: 0.35, ease: 'power1.in' }, 0);
      }
      const focused = !focus || focus.has(edge.id) || (focus.has(from) && focus.has(to));
      const flowing = on && flows.has(edge.id);
      tl.to(edge.state, { glow: hot.has(edge.id) ? 1 : 0, dim: focused ? 0 : 1, duration: 0.8 }, 0.4);
      tl.to(edge.state, { flow: flowing ? 1 : 0, duration: 0.6 }, flowing ? edgeStart + 0.5 : 0);
    }

    const frame = this.framing(scene);
    const camera = this.stage.camera;
    if (first) {
      camera.position.set(frame.x, frame.y, camera.position.z);
      camera.zoom = frame.zoom;
    } else {
      tl.to(camera.position, { x: frame.x, y: frame.y, duration: 1.4, ease: 'power3.inOut' }, 0);
      tl.to(camera, { zoom: frame.zoom, duration: 1.4, ease: 'power3.inOut' }, 0);
    }

    if (reducedMotion) tl.timeScale(3);

    const firstHot = scene.highlight === '*' ? null : scene.highlight?.[0];
    const accent = firstHot
      ? `#${(this.nodes.get(firstHot)?.accent ?? this.edges.get(firstHot)?.from.accent)?.getHexString()}`
      : null;
    for (const fn of this.listeners) fn({ index, scene, forward, accent });
  }

  /** Animate the camera back to the current scene's framing. */
  reframe() {
    if (this.index < 0) return;
    this.cameraFree = false;
    const frame = this.framing(this.scenes[this.index]);
    const camera = this.stage.camera;
    const duration = reducedMotion ? 0.3 : 0.9;
    gsap.to(camera.position, { x: frame.x, y: frame.y, duration, ease: 'power3.inOut' });
    gsap.to(camera, { zoom: frame.zoom, duration, ease: 'power3.inOut' });
  }

  private framing(scene: SceneSpec) {
    const ids = resolve(scene.camera ?? scene.show, [...this.nodes.keys()]);
    const box = new THREE.Box2();
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node) box.union(node.bounds);
    }
    return this.stage.framing(box);
  }
}

function resolve(selector: Selector | undefined, all: string[]) {
  if (selector === '*') return new Set(all);
  return new Set(selector ?? []);
}
