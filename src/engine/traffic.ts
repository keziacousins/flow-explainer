import * as THREE from 'three';
import { gsap } from 'gsap';
import type { EdgeView } from './edge';
import type { Graph } from './graph';
import type { FlowModel, HopOptions, PlayModel, Route, SceneModel, StreamModel } from './model';
import { smoothstep, type NodeView } from './node';
import { palette, reducedMotion } from './palette';
import type { RuntimeLayer } from './runtime';

const TRAIL = 10;
/** Distance between trail dots, in world units. */
const TRAIL_SPACING = 0.035;
const FLOW_SPEED = reducedMotion ? 1.2 : 3.2;
const STREAM_SPEED = reducedMotion ? 1 : 2.6;
/** Travel time limits in seconds, so long edges don't crawl and short ones don't blink. */
const MIN_TRAVEL = 0.35;
const MAX_TRAVEL = 1.6;
/** Default pause at each node before a flow's next step. */
const HOLD = 0.12;
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
 * and packets stay in step with the frame loop.
 */
export class Traffic {
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

  travelTime(length: number, speed = FLOW_SPEED) {
    return Math.min(Math.max(length / speed, MIN_TRAVEL), MAX_TRAVEL);
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
      from: source ? (opts.fromPods ?? source.origin()) : [undefined],
      to: target ? (opts.toPods ?? target.pick(key, opts.route)) : [undefined],
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
        next: now + Math.random() * this.interval,
      });
    }
  }

  tick(now: number) {
    const { rate, jitter = 0.3, burst = 1, kind, speed } = this.spec;
    if (rate === 0) return;
    for (const lane of this.lanes) {
      while (now >= lane.next) {
        lane.next += this.interval * (1 + jitter * (Math.random() * 2 - 1));
        const live = lane.edge.state.appear > 0.99 || this.traffic.canRevealHidden;
        if (!live) continue;
        for (let b = 0; b < burst; b++) this.traffic.after(b * 0.07, () => this.send(lane, kind, speed));
      }
    }
  }

  private send(lane: StreamRunner['lanes'][number], kind: StreamModel['kind'], speed?: number) {
    const t = this.traffic;
    const duration = t.travelTime(lane.edge.length, speed ?? t.streamSpeed);
    const color = t.colorFor(lane.source, kind);
    const size = kind === 'response' ? 0.8 : 0.9;
    t.launch(lane.edge, lane.reverse, duration, { color, size });
    const route = t.lower(lane.source, lane.target, randomKey(), { route: this.spec.route });
    if (route) t.launchUnderneath(lane.source, lane.target, route, duration, color, size);
  }
}

function randomKey() {
  return Math.floor(Math.random() * 1e6);
}

interface Token {
  node: string;
  /** Nodes visited on the way here, most recent last. `respond` walks back along it. */
  path: string[];
  /** Instances holding this token at `node`, when the runtime layer is showing. */
  pods?: number[];
  /** Instances used at each node visited, so responses and gathers return to the caller. */
  seen: Map<string, number[]>;
  /** Stands in for a routing key (hotel id, search id) so keyed hops pick consistently. */
  key: number;
  /** Index of the step this token runs next. */
  stage: number;
  /** Arrived at a gather point and waiting for the others. */
  waiting: boolean;
}

/**
 * One run of a flow. Each packet is a token that works through the steps on its own,
 * so fanned-out packets proceed independently; `gather` is where they join up again.
 */
class FlowRun {
  cancelled = false;
  private tokens = new Set<Token>();
  private finished = false;

  constructor(
    private traffic: Traffic,
    private flow: FlowModel,
    private onDone: () => void,
  ) {}

  start() {
    this.traffic.nodes.get(this.flow.start)?.flash();
    const token: Token = {
      node: this.flow.start,
      path: [],
      key: randomKey(),
      seen: new Map(),
      stage: 0,
      waiting: false,
    };
    this.tokens.add(token);
    this.step(token);
  }

  private step(t: Token) {
    if (this.cancelled) return;
    const s = this.flow.steps[t.stage];
    const graph = this.traffic.graph;
    if (!s) return this.remove(t);

    switch (s.op) {
      case 'hold':
        this.traffic.after(s.seconds, () => this.advance(t));
        return;

      case 'send': {
        const [target] = graph.neighbours(t.node, s.to);
        if (!target) return this.lost(t, `nothing matching ${JSON.stringify(s.to)} is connected to ${t.node}`);
        this.hop(t, target, s.opts, () => this.arrived(t, s.opts));
        return;
      }

      case 'fanout': {
        const targets = graph.neighbours(t.node, s.to);
        if (!targets.length) return this.lost(t, `nothing matching ${JSON.stringify(s.to)} is connected to ${t.node}`);
        this.tokens.delete(t);
        targets.forEach((target, i) => {
          // Each branch carries different data, so give it its own key.
          const child: Token = {
            ...t,
            path: [...t.path],
            key: t.key + (i + 1) * 7919,
            seen: new Map(t.seen),
            waiting: false,
          };
          this.tokens.add(child);
          this.traffic.after(i * (s.opts.stagger ?? 0), () =>
            this.hop(child, target, s.opts, () => this.arrived(child, s.opts)),
          );
        });
        return;
      }

      case 'respond': {
        const target = t.path[t.path.length - 1];
        if (!target) return this.lost(t, `respond at ${t.node} has nowhere to go back to`);
        this.hop(t, target, s.opts, () => this.arrived(t, s.opts), true);
        return;
      }

      case 'gather': {
        const wait = () => {
          t.waiting = true;
          this.checkJoins();
        };
        if (t.node === s.to) return wait();
        this.hop(t, s.to, s.opts, () => {
          this.traffic.nodes.get(s.to)?.flash();
          wait();
        });
        return;
      }

      case 'drop':
        if (s.at === undefined || graph.nodeIds(s.at).has(t.node)) {
          this.traffic.nodes.get(t.node)?.fail();
          this.remove(t);
        } else this.advance(t);
        return;
    }
  }

  /** Send the token's packets to `target`, on both layers. Moves the token when the last lands. */
  private hop(t: Token, target: string, opts: HopOptions, done: () => void, back = false) {
    if (this.cancelled) return;
    const traffic = this.traffic;
    const link = traffic.graph.between(t.node, target);
    if (!link) return this.lost(t, `no edge between ${t.node} and ${target}`);
    const edge = traffic.edges.get(link.edge.id)!;
    const duration = traffic.travelTime(edge.length, opts.speed);
    const count = opts.packets ?? 1;
    const color = traffic.colorFor(t.node, opts.kind);
    const size = opts.size ?? (opts.kind === 'response' ? 0.8 : 1);
    const route = traffic.lower(t.node, target, t.key, {
      fromPods: t.pods,
      toPods: t.seen.get(target),
      route: opts.route,
    });
    const from = t.node;
    if (route && !t.pods) {
      // First hop on the runtime layer: remember which instances it left from.
      t.pods = route.from.filter((i): i is number => i !== undefined);
      if (t.pods.length) t.seen.set(from, t.pods);
    }

    for (let k = 0; k < count; k++) {
      const last = k === count - 1;
      traffic.after(k * (opts.gap ?? 0.08), () => {
        traffic.launch(edge, link.reverse, duration, {
          color,
          size,
          onArrive: () => {
            if (this.cancelled) return;
            if (!last) return traffic.nodes.get(target)?.flash();
            if (back) t.path.pop();
            else t.path.push(from);
            t.node = target;
            t.pods = route?.to.filter((i): i is number => i !== undefined);
            if (t.pods?.length) t.seen.set(target, t.pods);
            else t.pods = undefined;
            done();
          },
        });
        if (route) traffic.launchUnderneath(from, target, route, duration, color, size);
      });
    }
  }

  private arrived(t: Token, opts: HopOptions) {
    t.stage++;
    this.traffic.nodes.get(t.node)?.flash();
    this.traffic.after(opts.hold ?? HOLD, () => this.step(t));
  }

  private advance(t: Token) {
    t.stage++;
    this.step(t);
  }

  private remove(t: Token) {
    this.tokens.delete(t);
    this.checkJoins();
    if (this.tokens.size === 0 && !this.finished) {
      this.finished = true;
      this.onDone();
    }
  }

  private lost(t: Token, why: string) {
    console.warn(`Flow "${this.flow.id}": ${why}`);
    this.remove(t);
  }

  /** Release a gather once every token that could still reach it is waiting there. */
  private checkJoins() {
    this.flow.steps.forEach((s, i) => {
      if (s.op !== 'gather') return;
      const waiting = [...this.tokens].filter((t) => t.stage === i && t.waiting);
      if (!waiting.length) return;
      const pending = [...this.tokens].some((t) => t.stage < i || (t.stage === i && !t.waiting));
      if (pending) return;
      waiting.forEach((t) => this.tokens.delete(t));
      // The joined token sits on whichever instances the gathered packets reached.
      const pods = [...new Set(waiting.flatMap((t) => t.pods ?? []))];
      // Its way back is the way the first of them came, up to the gather point.
      const path = waiting[0].path;
      const at = path.lastIndexOf(s.to);
      const joined: Token = {
        node: s.to,
        path: at >= 0 ? path.slice(0, at) : path,
        key: waiting[0].key,
        pods: pods.length ? pods : undefined,
        seen: new Map(waiting[0].seen),
        stage: i + 1,
        waiting: false,
      };
      this.tokens.add(joined);
      this.traffic.after(s.opts.hold ?? HOLD, () => this.step(joined));
    });
  }
}
