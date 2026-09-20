import type { ClusterFacts, FlowEvent, FlowWorld, HopEvent } from '../src/engine/flow';
import { Graph } from '../src/engine/graph';
import { DEFAULT_ROUTE, type Model } from '../src/engine/model';
import { makeRandom } from '../src/engine/random';

/** Every packet takes the same time, so expected timings are easy to reason about. */
const TRAVEL = 1;

/**
 * A FlowWorld with no rendering and a virtual clock: flows run as fast as the test can
 * step them, and everything they do is recorded.
 */
export class TestWorld implements FlowWorld {
  readonly graph: Graph;
  readonly log: { at: number; event: FlowEvent }[] = [];
  readonly warnings: string[] = [];
  random = makeRandom(1);
  now = 0;
  private timers: { at: number; order: number; fn: () => void }[] = [];
  private queued = 0;

  constructor(
    model: Model,
    private options: { lowered?: boolean } = {},
  ) {
    this.graph = new Graph(model);
  }

  after(seconds: number, fn: () => void) {
    this.timers.push({ at: this.now + Math.max(seconds, 0), order: this.queued++, fn });
  }

  travelTime() {
    return TRAVEL;
  }

  cluster(id: string): ClusterFacts | undefined {
    const runtime = this.graph.nodes.get(id)?.runtime;
    if (!runtime) return undefined;
    return { count: runtime.count, route: runtime.route ?? DEFAULT_ROUTE[runtime.kind] };
  }

  lowered() {
    return this.options.lowered ?? false;
  }

  emit(event: FlowEvent) {
    this.log.push({ at: this.now, event });
  }

  warn(message: string) {
    this.warnings.push(message);
  }

  /** Run the clock until nothing is scheduled. Throws rather than hanging if a flow stalls. */
  run(limit = 500) {
    for (let steps = 0; this.timers.length; steps++) {
      if (steps > limit) throw new Error('flow did not settle');
      this.timers.sort((a, b) => a.at - b.at || a.order - b.order);
      const next = this.timers.shift()!;
      this.now = next.at;
      next.fn();
    }
  }

  get events() {
    return this.log.map((entry) => entry.event);
  }

  hops(): HopEvent[] {
    return this.events.filter((e): e is HopEvent => e.type === 'hop');
  }

  /** Hops as `from->to`, in the order they were sent. */
  route(): string[] {
    return this.hops().map((h) => `${h.from}->${h.to}`);
  }

  arrivals(): string[] {
    return this.events.filter((e) => e.type === 'arrive').map((e) => e.node);
  }
}
