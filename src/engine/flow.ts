import type { Graph } from './graph';
import type { FlowModel, HopOptions, Route } from './model';
import type { Random } from './random';

/** Default pause at a node before a flow's next step. */
export const HOLD = 0.12;
const DEFAULT_GAP = 0.08;

/** Packets set off from one node to another. */
export interface HopEvent {
  type: 'hop';
  from: string;
  to: string;
  /** Edge travelled, and whether this goes against its direction. */
  edge: string;
  reverse: boolean;
  opts: HopOptions;
  /** How many packets, how far apart, and how long each takes. */
  packets: number;
  gap: number;
  duration: number;
  /** Runtime instances at each end, when the runtime layer is showing for them. */
  fromPods?: number[];
  toPods?: number[];
}

export interface ArriveEvent {
  type: 'arrive';
  node: string;
  pods?: number[];
}

export interface DropEvent {
  type: 'drop';
  node: string;
}

export type FlowEvent = HopEvent | ArriveEvent | DropEvent;

/** What a node runs as, as far as a flow is concerned. */
export interface ClusterFacts {
  count: number;
  route: Route;
}

/** Everything a flow needs from the outside world, so it can run without any rendering. */
export interface FlowWorld {
  graph: Graph;
  random: Random;
  /** Call `fn` after a delay in seconds. */
  after(seconds: number, fn: () => void): void;
  /** How long a packet takes to cross an edge. */
  travelTime(edge: string, speed?: number): number;
  /** The runtime instances of a node, if it has any. */
  cluster(id: string): ClusterFacts | undefined;
  /** Whether traffic between these nodes should also play on the runtime layer. */
  lowered(from: string, to: string): boolean;
  emit(event: FlowEvent): void;
  warn(message: string): void;
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
 * One run of a flow. Each packet is a token that works through the steps on its own, so
 * fanned-out branches proceed independently; `gather` is where they join up again.
 */
export class FlowRun {
  cancelled = false;
  private tokens = new Set<Token>();
  private finished = false;

  constructor(
    private world: FlowWorld,
    private flow: FlowModel,
    private onDone: () => void,
  ) {}

  start() {
    const token: Token = {
      node: this.flow.start,
      path: [],
      key: Math.floor(this.world.random() * 1e6),
      seen: new Map(),
      stage: 0,
      waiting: false,
    };
    this.tokens.add(token);
    this.world.emit({ type: 'arrive', node: token.node });
    this.step(token);
  }

  private step(t: Token) {
    if (this.cancelled) return;
    const s = this.flow.steps[t.stage];
    const graph = this.world.graph;
    if (!s) return this.remove(t);

    switch (s.op) {
      case 'hold':
        this.world.after(s.seconds, () => this.advance(t));
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
          this.world.after(i * (s.opts.stagger ?? 0), () =>
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
        this.hop(t, s.to, s.opts, wait);
        return;
      }

      case 'drop':
        if (s.at === undefined || graph.nodeIds(s.at).has(t.node)) {
          this.world.emit({ type: 'drop', node: t.node });
          this.remove(t);
        } else this.advance(t);
        return;
    }
  }

  /** Send the token's packets to `target`, and move it there once the last one lands. */
  private hop(t: Token, target: string, opts: HopOptions, done: () => void, back = false) {
    if (this.cancelled) return;
    const world = this.world;
    const link = world.graph.between(t.node, target);
    if (!link) return this.lost(t, `no edge between ${t.node} and ${target}`);

    const from = t.node;
    const duration = world.travelTime(link.edge.id, opts.speed);
    const packets = opts.packets ?? 1;
    const gap = opts.gap ?? DEFAULT_GAP;

    let fromPods: number[] | undefined;
    let toPods: number[] | undefined;
    if (world.lowered(from, target)) {
      const source = world.cluster(from);
      const destination = world.cluster(target);
      // Instances a request leaves from: the ones holding the token, or a fresh pick.
      if (source) fromPods = t.pods ?? this.instances(source, t.key, source.route === 'all' ? 'all' : 'any');
      // Instances it reaches: the ones it used here before, so responses return to the caller.
      if (destination) toPods = t.seen.get(target) ?? this.instances(destination, t.key, opts.route);
      if (source && !t.pods && fromPods?.length) {
        t.pods = fromPods;
        t.seen.set(from, fromPods);
      }
    }

    world.emit({
      type: 'hop',
      from,
      to: target,
      edge: link.edge.id,
      reverse: link.reverse,
      opts,
      packets,
      gap,
      duration,
      fromPods,
      toPods,
    });

    world.after(duration + (packets - 1) * gap, () => {
      if (this.cancelled) return;
      if (back) t.path.pop();
      else t.path.push(from);
      t.node = target;
      t.pods = toPods?.length ? toPods : undefined;
      if (t.pods) t.seen.set(target, t.pods);
      world.emit({ type: 'arrive', node: target, pods: t.pods });
      done();
    });
  }

  /** Which instances of a node a request reaches. */
  private instances(facts: ClusterFacts, key: number, route: Route = facts.route): number[] {
    if (route === 'all') return Array.from({ length: facts.count }, (_, i) => i);
    if (route === 'key') return [key % facts.count];
    return [Math.floor(this.world.random() * facts.count)];
  }

  private arrived(t: Token, opts: HopOptions) {
    t.stage++;
    this.world.after(opts.hold ?? HOLD, () => this.step(t));
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
    this.world.warn(`Flow "${this.flow.id}": ${why}`);
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
      this.world.after(s.opts.hold ?? HOLD, () => this.step(joined));
    });
  }
}
