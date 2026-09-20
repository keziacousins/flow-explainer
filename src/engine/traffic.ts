import * as THREE from 'three';
import { gsap } from 'gsap';
import type { EdgeView } from './edge';
import type { Graph } from './graph';
import { FlowRun, type ClusterFacts, type FlowEvent, type FlowWorld } from './flow';
import type { HopOptions, PlayModel, Route, SceneModel, StreamModel } from './model';
import { smoothstep, type NodeView } from './node';
import { palette, reducedMotion } from './palette';
import type { Random } from './random';
import type { RuntimeLayer } from './runtime';

const TRAIL = 10;
/** Distance between trail dots, in world units. */
const TRAIL_SPACING = 0.035;
const FLOW_SPEED = reducedMotion ? 1.2 : 3.2;
const STREAM_SPEED = reducedMotion ? 1 : 2.6;
/** Travel time limits in seconds, so long edges don't crawl and short ones don't blink. */
const MIN_TRAVEL = 0.35;
const MAX_TRAVEL = 1.6;
/** Default pause between repeats of a playing flow. */
const PAUSE = 2;
/** Runtime packets are smaller than logical ones; there are many more of them. */
const RUNTIME_SCALE = 0.7;

/** Something a packet travels along. `u` runs from 0 at the start to 1 at the end. */
export interface PacketPath {
  length: number;
  at(u: number, out: THREE.Vector3): void;
  /** Brightness at `u`; 0 hides the packet there. */
  light(u: number): number;
}

interface Packet {
  path: PacketPath;
  start: number;
  duration: number;
  color: THREE.Color;
  size: number;
  onArrive?: () => void;
}

interface LaunchOptions {
  color: THREE.Color;
  size?: number;
  onArrive?: () => void;
}

/** Instances (pod indices) a hop leaves from and arrives at on the runtime layer. */
interface Lowered {
  from: (number | undefined)[];
  to: (number | undefined)[];
}

/** One instanced mesh of packets with trails. */
class PacketLayer {
  readonly mesh: THREE.InstancedMesh;
  private packets: Packet[] = [];
  private point = new THREE.Vector3();

  constructor(
    private capacity: number,
    renderOrder: number,
    /** Whether solid things (runtime towers) can hide these packets. */
    depthTest: boolean,
  ) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.05, 12),
      new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest,
        depthWrite: false,
        fog: false,
      }),
      capacity * TRAIL,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.count = 0;
  }

  /** False when full; the caller should keep flows moving without drawing. */
  add(packet: Packet) {
    if (this.packets.length >= this.capacity) return false;
    this.packets.push(packet);
    return true;
  }

  /** Retire packets that have arrived. Arrival callbacks may add more. */
  retire(now: number) {
    for (let i = 0; i < this.packets.length; ) {
      const p = this.packets[i];
      if (now - p.start >= p.duration) {
        this.packets[i] = this.packets[this.packets.length - 1];
        this.packets.pop();
        p.onArrive?.();
      } else i++;
    }
  }

  draw(now: number) {
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    const colors = this.mesh.instanceColor!.array as Float32Array;
    let n = 0;

    for (const p of this.packets) {
      const u = (now - p.start) / p.duration;
      const step = TRAIL_SPACING / Math.max(p.path.length, 0.1);
      for (let k = 0; k < TRAIL; k++) {
        const along = u - k * step;
        if (along < 0) break;
        const falloff = 1 - k / TRAIL;
        const fade = smoothstep(0, 0.06, along) * (1 - smoothstep(0.94, 1, along));
        const strength = fade * p.path.light(along);
        if (strength <= 0.001) continue;

        p.path.at(along, this.point);
        const scale = p.size * (k === 0 ? 1.1 : 0.85 * falloff);
        const m = n * 16;
        matrices.fill(0, m, m + 16);
        matrices[m] = scale;
        matrices[m + 5] = scale;
        matrices[m + 10] = 1;
        matrices[m + 12] = this.point.x;
        matrices[m + 13] = this.point.y;
        matrices[m + 14] = this.point.z;
        matrices[m + 15] = 1;

        const intensity = (k === 0 ? 5 : 1.6 * falloff) * strength;
        colors[n * 3] = p.color.r * intensity;
        colors[n * 3 + 1] = p.color.g * intensity;
        colors[n * 3 + 2] = p.color.b * intensity;
        n++;
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.clearUpdateRanges();
    this.mesh.instanceColor!.addUpdateRange(0, n * 3);
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

/**
 * Every packet on screen: background streams and flows, on the logical layer and,
 * where it's showing, mirrored on the runtime layer. Keeps its own clock so timers
 * and packets stay in step with the frame loop. Flows themselves run in `flow.ts`;
 * this is the `FlowWorld` they run against, turning their events into packets.
 */
export class Traffic implements FlowWorld {
  /** Packets on the logical layer. */
  readonly logical = new PacketLayer(2048, 2.5, false);
  /** Packets between runtime instances, drawn beneath the fog and hidden behind towers. */
  readonly underneath = new PacketLayer(4096, -9, true);
  private timers: { at: number; fn: () => void }[] = [];
  private streams: StreamRunner[] = [];
  private runs = new Set<FlowRun>();
  private revealing = new Set<EdgeView>();
  private revealOnUse = false;
  private now = 0;
  private error = new THREE.Color(palette.error);

  constructor(
    readonly graph: Graph,
    readonly nodes: Map<string, NodeView>,
    readonly edges: Map<string, EdgeView>,
    readonly runtime: RuntimeLayer,
    readonly random: Random = Math.random,
  ) {}

  /** Stop the current scene's traffic and start the next scene's after `delay` seconds. */
  setScene(scene: SceneModel, delay: number) {
    this.timers = [];
    for (const run of this.runs) run.cancelled = true;
    this.runs.clear();
    this.streams = [];
    for (const edge of this.revealing) gsap.killTweensOf(edge.state, 'appear');
    this.revealing.clear();
    this.revealOnUse = scene.reveal === 'onUse';

    this.after(delay, () => {
      this.streams = (scene.streams ?? []).map((s) => new StreamRunner(this, s, this.now));
      for (const play of scene.play ?? []) this.play(play);
    });
  }

  after(seconds: number, fn: () => void) {
    if (seconds <= 0) fn();
    else this.timers.push({ at: this.now + seconds, fn });
  }

  /** How long a packet takes to cross an edge, by id (what flows ask for). */
  travelTime(edge: string, speed?: number) {
    return this.travel(this.edges.get(edge)!.length, speed);
  }

  travel(length: number, speed = FLOW_SPEED) {
    return Math.min(Math.max(length / speed, MIN_TRAVEL), MAX_TRAVEL);
  }

  /** What a node runs as, for a flow deciding which instances a hop reaches. */
  cluster(id: string): ClusterFacts | undefined {
    const cluster = this.runtime.clusters.get(id);
    return cluster && { count: cluster.count, route: cluster.route };
  }

  lowered(from: string, to: string) {
    return this.runtime.active(from, to);
  }

  warn(message: string) {
    console.warn(message);
  }

  /** Draw what a flow just did. */
  emit(event: FlowEvent) {
    if (event.type === 'arrive') {
      this.nodes.get(event.node)?.flash();
      return;
    }
    if (event.type === 'drop') {
      this.nodes.get(event.node)?.fail();
      return;
    }
    const { from, to, opts, packets, gap, duration, fromPods, toPods } = event;
    const edge = this.edges.get(event.edge)!;
    const color = this.colorFor(from, opts.kind);
    const size = opts.size ?? (opts.kind === 'response' ? 0.8 : 1);
    const route = fromPods || toPods ? { from: fromPods ?? [undefined], to: toPods ?? [undefined] } : undefined;
    for (let k = 0; k < packets; k++) {
      this.after(k * gap, () => {
        this.launch(edge, event.reverse, duration, { color, size, onArrive: () => this.nodes.get(to)?.flash() });
        if (route) this.launchUnderneath(from, to, route, duration, color, size);
      });
    }
  }

  /** A packet along a logical edge. */
  launch(edge: EdgeView, reverse: boolean, duration: number, opts: LaunchOptions) {
    if (this.revealOnUse && edge.state.appear < 1 && !this.revealing.has(edge)) {
      // The packet draws the line as it travels. Packets going against the edge's
      // direction can't lead the draw, so the line appears quickly ahead of them.
      this.revealing.add(edge);
      gsap.to(edge.state, { appear: 1, duration: reverse ? 0.25 : duration, ease: 'none' });
    }
    const added = this.logical.add({
      path: {
        length: edge.length,
        at: (u, out) => {
          edge.sample(reverse ? 1 - u : u, out);
          out.z = 0;
        },
        light: (u) => (!edge.group.visible || (!reverse && u > edge.state.appear) ? 0 : edge.brightness),
      },
      start: this.now,
      duration,
      color: opts.color,
      size: opts.size ?? 1,
      onArrive: opts.onArrive,
    });
    // Too busy to draw, but keep flows moving.
    if (!added && opts.onArrive) this.after(duration, opts.onArrive);
  }

  /**
   * Which instances a hop between two nodes goes from and to on the runtime layer,
   * or undefined when the runtime layer isn't showing for them.
   */
  lower(
    from: string,
    to: string,
    key: number,
    opts: { fromPods?: number[]; toPods?: number[]; route?: Route } = {},
  ): Lowered | undefined {
    if (!this.runtime.active(from, to)) return undefined;
    const source = this.runtime.clusters.get(from);
    const target = this.runtime.clusters.get(to);
    return {
      from: source ? (opts.fromPods ?? source.origin(this.random)) : [undefined],
      to: target ? (opts.toPods ?? target.pick(key, this.random, opts.route)) : [undefined],
    };
  }

  /** Packets between instances, mirroring a logical hop. */
  launchUnderneath(from: string, to: string, route: Lowered, duration: number, color: THREE.Color, size = 1) {
    const pairs: [number | undefined, number | undefined][] = [];
    if (route.from.length > 1 && route.to.length > 1) {
      // Many to many: pair them up rather than send every combination.
      const n = Math.max(route.from.length, route.to.length);
      for (let i = 0; i < n; i++) pairs.push([route.from[i % route.from.length], route.to[i % route.to.length]]);
    } else {
      for (const a of route.from) for (const b of route.to) pairs.push([a, b]);
    }
    const light = () => Math.min(this.runtime.brightness(from), this.runtime.brightness(to));
    for (const [a, b] of pairs) {
      this.underneath.add({
        path: arc(this.runtime.point(from, a), this.runtime.point(to, b), light),
        start: this.now,
        duration,
        color,
        size: size * RUNTIME_SCALE,
        onArrive: () => {
          if (b !== undefined) this.runtime.flash(to, b);
        },
      });
    }
  }

  colorFor(node: string, kind: HopOptions['kind']) {
    return kind === 'error' ? this.error : this.nodes.get(node)!.accent;
  }

  get streamSpeed() {
    return STREAM_SPEED;
  }

  get canRevealHidden() {
    return this.revealOnUse;
  }

  tick(delta: number) {
    this.now += delta;

    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= this.now);
      if (due.length) {
        this.timers = this.timers.filter((t) => t.at > this.now);
        due.sort((a, b) => a.at - b.at).forEach((t) => t.fn());
      }
    }

    for (const stream of this.streams) stream.tick(this.now);
    this.logical.retire(this.now);
    this.underneath.retire(this.now);
    this.logical.draw(this.now);
    this.underneath.draw(this.now);
  }

  private play(spec: PlayModel) {
    const flow = this.graph.model.flows.find((f) => f.id === spec.flow)!;
    const run = () => {
      const r = new FlowRun(this, flow, () => {
        this.runs.delete(r);
        if (!spec.once) this.after(spec.pause ?? PAUSE, run);
      });
      this.runs.add(r);
      r.start();
    };
    this.after(spec.delay ?? 0, run);
  }
}

/** A curve between two instances that dips below them, keeping runtime traffic under the sheet. */
function arc(a: THREE.Vector3, b: THREE.Vector3, light: () => number): PacketPath {
  const length = a.distanceTo(b);
  const c = a.clone().add(b).multiplyScalar(0.5);
  c.z -= Math.min(1.5, length * 0.2);
  return {
    length,
    at(u, out) {
      const v = 1 - u;
      out.set(
        v * v * a.x + 2 * v * u * c.x + u * u * b.x,
        v * v * a.y + 2 * v * u * c.y + u * u * b.y,
        v * v * a.z + 2 * v * u * c.z + u * u * b.z,
      );
    },
    light,
  };
}

/** Launches packets along every edge between two node sets at a steady, jittered rate. */
class StreamRunner {
  private lanes: { edge: EdgeView; reverse: boolean; source: string; target: string; next: number }[] = [];
  private interval: number;

  constructor(
    private traffic: Traffic,
    private spec: StreamModel,
    now: number,
  ) {
    const from = traffic.graph.nodeIds(spec.from);
    const to = traffic.graph.nodeIds(spec.to);
    this.interval = 1 / (spec.rate ?? 1);
    for (const edge of traffic.graph.edges.values()) {
      const forward = from.has(edge.from) && to.has(edge.to);
      const backward = from.has(edge.to) && to.has(edge.from);
      if (!forward && !backward) continue;
      this.lanes.push({
        edge: traffic.edges.get(edge.id)!,
        reverse: !forward,
        source: forward ? edge.from : edge.to,
        target: forward ? edge.to : edge.from,
        // Stagger lanes so they don't all fire together.
        next: now + traffic.random() * this.interval,
      });
    }
  }

  tick(now: number) {
    const { rate, jitter = 0.3, burst = 1, kind, speed } = this.spec;
    if (rate === 0) return;
    for (const lane of this.lanes) {
      while (now >= lane.next) {
        lane.next += this.interval * (1 + jitter * (this.traffic.random() * 2 - 1));
        const live = lane.edge.state.appear > 0.99 || this.traffic.canRevealHidden;
        if (!live) continue;
        for (let b = 0; b < burst; b++) this.traffic.after(b * 0.07, () => this.send(lane, kind, speed));
      }
    }
  }

  private send(lane: StreamRunner['lanes'][number], kind: StreamModel['kind'], speed?: number) {
    const t = this.traffic;
    const duration = t.travel(lane.edge.length, speed ?? t.streamSpeed);
    const color = t.colorFor(lane.source, kind);
    const size = kind === 'response' ? 0.8 : 0.9;
    t.launch(lane.edge, lane.reverse, duration, { color, size });
    const route = t.lower(lane.source, lane.target, Math.floor(t.random() * 1e6), { route: this.spec.route });
    if (route) t.launchUnderneath(lane.source, lane.target, route, duration, color, size);
  }
}
