import * as THREE from 'three';
import { gsap } from 'gsap';
import type { EdgeView } from './edge';
import type { Graph } from './graph';
import type { FlowModel, HopOptions, PlayModel, SceneModel, StreamModel } from './model';
import { smoothstep, type NodeView } from './node';
import { palette, reducedMotion } from './palette';

const CAPACITY = 2048;
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

interface Packet {
  edge: EdgeView;
  reverse: boolean;
  start: number;
  duration: number;
  color: THREE.Color;
  size: number;
  onArrive?: () => void;
}

interface LaunchOptions {
  color: THREE.Color;
  size?: number;
  speed?: number;
  onArrive?: () => void;
}

/**
 * Every packet on screen: background streams and flows. Drawn as one instanced mesh.
 * Keeps its own clock so timers and packets stay in step with the frame loop.
 */
export class Traffic {
  readonly mesh: THREE.InstancedMesh;
  private packets: Packet[] = [];
  private timers: { at: number; fn: () => void }[] = [];
  private streams: StreamRunner[] = [];
  private runs = new Set<FlowRun>();
  private revealing = new Set<EdgeView>();
  private revealOnUse = false;
  private now = 0;
  private point = { x: 0, y: 0 };
  private error = new THREE.Color(palette.error);

  constructor(
    readonly graph: Graph,
    readonly nodes: Map<string, NodeView>,
    readonly edges: Map<string, EdgeView>,
  ) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.05, 12),
      new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
      CAPACITY * TRAIL,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2.5;
    this.mesh.count = 0;
  }

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

  launch(edge: EdgeView, reverse: boolean, opts: LaunchOptions) {
    const duration = Math.min(Math.max(edge.length / (opts.speed ?? FLOW_SPEED), MIN_TRAVEL), MAX_TRAVEL);
    if (this.revealOnUse && edge.state.appear < 1 && !this.revealing.has(edge)) {
      // The packet draws the line as it travels. Packets going against the edge's
      // direction can't lead the draw, so the line appears quickly ahead of them.
      this.revealing.add(edge);
      gsap.to(edge.state, { appear: 1, duration: reverse ? 0.25 : duration, ease: 'none' });
    }
    if (this.packets.length >= CAPACITY) {
      // Too busy to draw, but keep flows moving.
      if (opts.onArrive) this.after(duration, opts.onArrive);
      return;
    }
    this.packets.push({
      edge,
      reverse,
      start: this.now,
      duration,
      color: opts.color,
      size: opts.size ?? 1,
      onArrive: opts.onArrive,
    });
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

    // Retire arrived packets. Arrival callbacks may launch more.
    for (let i = 0; i < this.packets.length; ) {
      const p = this.packets[i];
      if (this.now - p.start >= p.duration) {
        this.packets[i] = this.packets[this.packets.length - 1];
        this.packets.pop();
        p.onArrive?.();
      } else i++;
    }

    this.draw();
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

  private draw() {
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    const colors = this.mesh.instanceColor!.array as Float32Array;
    let n = 0;

    for (const p of this.packets) {
      const { edge } = p;
      if (!edge.group.visible) continue;
      const u = (this.now - p.start) / p.duration;
      const step = TRAIL_SPACING / edge.length;
      for (let k = 0; k < TRAIL; k++) {
        const along = u - k * step;
        if (along < 0) break;
        // Forward packets never run ahead of a line that is still drawing.
        if (!p.reverse && along > edge.state.appear) continue;
        const falloff = 1 - k / TRAIL;
        const fade = smoothstep(0, 0.06, along) * (1 - smoothstep(0.94, 1, along));
        const strength = fade * edge.brightness;
        if (strength <= 0.001) continue;

        edge.sample(p.reverse ? 1 - along : along, this.point);
        const scale = p.size * (k === 0 ? 1.1 : 0.85 * falloff);
        const m = n * 16;
        matrices.fill(0, m, m + 16);
        matrices[m] = scale;
        matrices[m + 5] = scale;
        matrices[m + 10] = 1;
        matrices[m + 12] = this.point.x;
        matrices[m + 13] = this.point.y;
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

/** Launches packets along every edge between two node sets at a steady, jittered rate. */
class StreamRunner {
  private lanes: { edge: EdgeView; reverse: boolean; source: string; next: number }[] = [];
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
        // Stagger lanes so they don't all fire together.
        next: now + Math.random() * this.interval,
      });
    }
  }

  tick(now: number) {
    const { rate, jitter = 0.3, burst = 1, kind, speed } = this.spec;
    if (!rate && rate !== undefined) return;
    for (const lane of this.lanes) {
      while (now >= lane.next) {
        lane.next += this.interval * (1 + jitter * (Math.random() * 2 - 1));
        const live = lane.edge.state.appear > 0.99 || this.traffic.canRevealHidden;
        if (!live) continue;
        for (let b = 0; b < burst; b++) {
          this.traffic.after(b * 0.07, () =>
            this.traffic.launch(lane.edge, lane.reverse, {
              color: this.traffic.colorFor(lane.source, kind),
              size: kind === 'response' ? 0.8 : 0.9,
              speed: speed ?? this.traffic.streamSpeed,
            }),
          );
        }
      }
    }
  }
}

interface Token {
  node: string;
  prev?: string;
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
    const token: Token = { node: this.flow.start, stage: 0, waiting: false };
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
        this.hop(t, target, s.opts, () => this.arrived(t, target, s.opts));
        return;
      }

      case 'fanout': {
        const targets = graph.neighbours(t.node, s.to);
        if (!targets.length) return this.lost(t, `nothing matching ${JSON.stringify(s.to)} is connected to ${t.node}`);
        this.tokens.delete(t);
        targets.forEach((target, i) => {
          const child: Token = { node: t.node, prev: t.prev, stage: t.stage, waiting: false };
          this.tokens.add(child);
          this.traffic.after(i * (s.opts.stagger ?? 0), () =>
            this.hop(child, target, s.opts, () => this.arrived(child, target, s.opts)),
          );
        });
        return;
      }

      case 'respond': {
        const target = t.prev;
        if (!target) return this.lost(t, `respond at ${t.node} has nowhere to go back to`);
        this.hop(t, target, s.opts, () => this.arrived(t, target, s.opts));
        return;
      }

      case 'gather': {
        const wait = () => {
          t.waiting = true;
          this.checkJoins();
        };
        if (t.node === s.to) return wait();
        this.hop(t, s.to, s.opts, () => {
          t.prev = t.node;
          t.node = s.to;
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

  private hop(t: Token, target: string, opts: HopOptions, done: () => void) {
    if (this.cancelled) return;
    const link = this.traffic.graph.between(t.node, target);
    if (!link) return this.lost(t, `no edge between ${t.node} and ${target}`);
    const edge = this.traffic.edges.get(link.edge.id)!;
    const count = opts.packets ?? 1;
    const color = this.traffic.colorFor(t.node, opts.kind);
    const size = opts.size ?? (opts.kind === 'response' ? 0.8 : 1);
    for (let k = 0; k < count; k++) {
      const last = k === count - 1;
      this.traffic.after(k * (opts.gap ?? 0.08), () =>
        this.traffic.launch(edge, link.reverse, {
          color,
          size,
          speed: opts.speed,
          onArrive: () => {
            if (this.cancelled) return;
            if (last) done();
            else this.traffic.nodes.get(target)?.flash();
          },
        }),
      );
    }
  }

  private arrived(t: Token, target: string, opts: HopOptions) {
    t.prev = t.node;
    t.node = target;
    t.stage++;
    this.traffic.nodes.get(target)?.flash();
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
      const joined: Token = { node: s.to, stage: i + 1, waiting: false };
      this.tokens.add(joined);
      this.traffic.after(s.opts.hold ?? HOLD, () => this.step(joined));
    });
  }
}
