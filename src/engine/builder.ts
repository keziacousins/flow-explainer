import { Graph } from './graph';
import type {
  EdgeModel,
  FlowModel,
  FlowStep,
  HopOptions,
  Model,
  NodeInfo,
  NodeModel,
  Role,
  Runtime,
  SceneModel,
  Selector,
  Shape,
  Side,
  StreamModel,
} from './model';

/** Positions for `count` nodes. */
export type Layout = (count: number) => [number, number][];

/** Top to bottom, centred on `at`, `pitch` apart (centre to centre). */
export const column =
  (at: [number, number], pitch: number): Layout =>
  (n) =>
    Array.from({ length: n }, (_, i) => [at[0], at[1] + ((n - 1) / 2 - i) * pitch]);

/** Left to right, centred on `at`. */
export const row =
  (at: [number, number], pitch: number): Layout =>
  (n) =>
    Array.from({ length: n }, (_, i) => [at[0] + (i - (n - 1) / 2) * pitch, at[1]]);

/** Row-major grid centred on `at`. */
export const grid =
  (at: [number, number], columns: number, pitch: [number, number]): Layout =>
  (n) => {
    const rows = Math.ceil(n / columns);
    return Array.from({ length: n }, (_, i) => {
      const c = i % columns;
      const r = Math.floor(i / columns);
      return [at[0] + (c - (columns - 1) / 2) * pitch[0], at[1] + ((rows - 1) / 2 - r) * pitch[1]];
    });
  };

/** Along an arc, angles in degrees (0 = right, 90 = up). */
export const arc =
  (centre: [number, number], radius: number, fromDeg: number, toDeg: number): Layout =>
  (n) =>
    Array.from({ length: n }, (_, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const a = ((fromDeg + (toDeg - fromDeg) * t) * Math.PI) / 180;
      return [centre[0] + radius * Math.cos(a), centre[1] + radius * Math.sin(a)];
    });

const DEFAULT_SIZE: Record<Shape, [number, number]> = {
  box: [3.2, 1.3],
  db: [3.0, 1.5],
  queue: [3.2, 1.1],
  actor: [1.3, 1.3],
};

/**
 * Rough width a label needs, in world units, from its length. Labels are 0.3 units tall
 * in IBM Plex Sans; room is added for padding.
 */
function labelWidth(label: string, shape: Shape) {
  if (shape === 'actor') return 0;
  const text = label.length * 0.145;
  // Text sits centred inside an ellipse, where there's less usable width than in a box.
  if (shape === 'db') return text / 0.72 + 0.3;
  const padding = shape === 'queue' ? 1 : 0.6;
  return text + padding;
}

/** A node set: several nodes described together. Its id selects all members. */
export class NodeSet {
  constructor(
    readonly id: string,
    readonly ids: string[],
    private byKey: Map<string, string>,
  ) {}

  get(key: string): string {
    const id = this.byKey.get(key);
    if (!id) throw new Error(`Set "${this.id}" has no member "${key}"`);
    return id;
  }
}

type Ref = string | NodeSet;
type Refs = Ref | Ref[];

interface NodeInput {
  label: string;
  detail?: string;
  role?: Role;
  shape?: Shape;
  at: [number, number];
  size?: [number, number];
  runtime?: Runtime;
  info?: NodeInfo;
}

interface SetInput {
  label: (key: string, i: number) => string;
  detail?: (key: string, i: number) => string;
  role?: Role;
  shape?: Shape;
  size?: [number, number];
  runtime?: Runtime | ((key: string, i: number) => Runtime | undefined);
  info?: (key: string, i: number) => NodeInfo | undefined;
  layout: Layout;
}

interface ConnectOptions {
  style?: 'solid' | 'dashed';
  label?: string;
  ports?: [Side, Side];
  /** When both ends are several nodes: `zip` pairs them in order, `all` joins every pair. */
  pairing?: 'zip' | 'all';
}

interface StreamInput extends Omit<StreamModel, 'from' | 'to'> {
  from: Refs;
  to: Refs;
}

interface SceneInput
  extends Omit<SceneModel, 'show' | 'highlight' | 'focus' | 'camera' | 'groups' | 'streams' | 'runtime'> {
  show: Refs;
  runtime?: Refs;
  highlight?: Refs;
  focus?: Refs;
  camera?: Refs;
  groups?: Refs;
  streams?: StreamInput[];
}

export class FlowBuilder {
  readonly steps: FlowStep[] = [];

  /** Move to the connected node matching `to`. */
  send(to: Refs, opts: HopOptions = {}) {
    this.steps.push({ op: 'send', to: selector(to), opts });
    return this;
  }

  /** Split into one packet per connected node matching `to`. */
  fanout(to: Refs, opts: HopOptions = {}) {
    this.steps.push({ op: 'fanout', to: selector(to), opts });
    return this;
  }

  /** Go back one step along the way the packet came. Repeated calls keep unwinding. */
  respond(opts: HopOptions = {}) {
    this.steps.push({ op: 'respond', opts: { kind: 'response', ...opts } });
    return this;
  }

  /** Every packet travels to `to`, then the flow continues as one. */
  gather(to: Ref, opts: HopOptions = {}) {
    this.steps.push({ op: 'gather', to: refId(to), opts });
    return this;
  }

  /** Stop packets at nodes matching `at`, or all packets. */
  drop(at?: Refs) {
    this.steps.push({ op: 'drop', at: at === undefined ? undefined : selector(at) });
    return this;
  }

  hold(seconds: number) {
    this.steps.push({ op: 'hold', seconds });
    return this;
  }
}

export class DiagramBuilder {
  private nodes: NodeModel[] = [];
  private edges: EdgeModel[] = [];
  private groups: Model['groups'] = [];
  private sets: Model['sets'] = {};
  private flows: FlowModel[] = [];
  private scenes: SceneModel[] = [];
  private ids = new Set<string>();

  constructor(private meta: { title: string; subtitle: string }) {}

  node(id: string, input: NodeInput): string {
    this.claim(id);
    const shape = input.shape ?? 'box';
    const [w, h] = input.size ?? DEFAULT_SIZE[shape];
    this.nodes.push({
      id,
      label: input.label,
      detail: input.detail,
      role: input.role ?? 'service',
      shape,
      pos: input.at,
      // Boxes grow to fit their label rather than letting it spill out.
      size: [Math.max(w, labelWidth(input.label, shape)), h],
      runtime: input.runtime,
      info: input.info,
    });
    return id;
  }

  /** Several similar nodes, ids `${id}.${key}`, placed by `layout`. */
  set(id: string, keys: string[], input: SetInput): NodeSet {
    this.claim(id);
    const positions = input.layout(keys.length);
    const labels = keys.map((key, i) => input.label(key, i));
    const runtimes = keys.map((key, i) =>
      typeof input.runtime === 'function' ? input.runtime(key, i) : input.runtime,
    );
    // Members share one width, wide enough for the longest label.
    const shape = input.shape ?? 'box';
    const [w, h] = input.size ?? DEFAULT_SIZE[shape];
    const width = Math.max(w, ...labels.map((l) => labelWidth(l, shape)));
    const byKey = new Map<string, string>();
    keys.forEach((key, i) => {
      const nodeId = this.node(`${id}.${key}`, {
        label: labels[i],
        detail: input.detail?.(key, i),
        role: input.role,
        shape,
        size: [width, h],
        runtime: runtimes[i],
        info: input.info?.(key, i),
        at: positions[i],
      });
      byKey.set(key, nodeId);
    });
    const set = new NodeSet(id, [...byKey.values()], byKey);
    this.sets[id] = set.ids;
    return set;
  }

  connect(from: Refs, to: Refs, opts: ConnectOptions = {}) {
    const a = this.expand(from);
    const b = this.expand(to);
    const pairs: [string, string][] = [];
    if (a.length > 1 && b.length > 1 && (opts.pairing ?? 'zip') === 'zip') {
      if (a.length !== b.length) throw new Error(`Can't zip ${a.length} nodes with ${b.length}; use pairing: 'all'`);
      a.forEach((id, i) => pairs.push([id, b[i]]));
    } else {
      for (const x of a) for (const y of b) pairs.push([x, y]);
    }
    for (const [x, y] of pairs) {
      const id = `${x}->${y}`;
      if (this.edges.some((e) => e.id === id)) throw new Error(`Duplicate edge ${id}`);
      this.edges.push({ id, from: x, to: y, style: opts.style ?? 'solid', label: opts.label, ports: opts.ports });
    }
  }

  group(id: string, label: string, members: Refs) {
    this.claim(id);
    this.groups.push({ id, label, members: this.expand(members) });
    return id;
  }

  flow(id: string, start: Ref, build: (f: FlowBuilder) => unknown) {
    const f = new FlowBuilder();
    build(f);
    this.flows.push({ id, start: refId(start), steps: f.steps });
    return id;
  }

  scene(input: SceneInput) {
    this.scenes.push({
      ...input,
      show: selector(input.show),
      highlight: optional(input.highlight),
      focus: optional(input.focus),
      camera: optional(input.camera),
      groups: optional(input.groups),
      runtime: optional(input.runtime),
      streams: input.streams?.map((s) => ({ ...s, from: selector(s.from), to: selector(s.to) })),
    });
  }

  /** Check every reference resolves, and return the model. */
  build(): Model {
    const model: Model = {
      ...this.meta,
      nodes: this.nodes,
      edges: this.edges,
      groups: this.groups,
      sets: this.sets,
      flows: this.flows,
      scenes: this.scenes,
    };
    validate(model);
    return model;
  }

  private claim(id: string) {
    if (this.ids.has(id)) throw new Error(`Id "${id}" is already used`);
    this.ids.add(id);
  }

  private expand(refs: Refs): string[] {
    const list = Array.isArray(refs) ? refs : [refs];
    return list.flatMap((r) => {
      if (r instanceof NodeSet) return r.ids;
      if (this.sets[r]) return this.sets[r];
      if (!this.nodes.some((n) => n.id === r)) throw new Error(`Unknown node "${r}"`);
      return [r];
    });
  }
}

export function diagram(meta: { title: string; subtitle: string }) {
  return new DiagramBuilder(meta);
}

function refId(ref: Ref) {
  return ref instanceof NodeSet ? ref.id : ref;
}

function selector(refs: Refs): Selector {
  return Array.isArray(refs) ? refs.map(refId) : refId(refs);
}

function optional(refs: Refs | undefined): Selector | undefined {
  return refs === undefined ? undefined : selector(refs);
}

function validate(model: Model) {
  const graph = new Graph(model);
  const flowIds = new Set(model.flows.map((f) => f.id));

  for (const flow of model.flows) {
    const where = `flow "${flow.id}"`;
    check(where, () => graph.nodeIds(flow.start));
    for (const step of flow.steps) {
      if ('to' in step) check(where, () => graph.nodeIds(step.to));
      if (step.op === 'drop') check(where, () => graph.nodeIds(step.at));
    }
  }

  model.scenes.forEach((scene, i) => {
    const where = `scene ${i + 1} ("${scene.title}")`;
    for (const sel of [scene.show, scene.highlight, scene.focus, scene.camera, scene.groups, scene.runtime]) {
      check(where, () => {
        graph.nodeIds(sel);
        graph.edgeIds(sel);
      });
    }
    for (const stream of scene.streams ?? []) {
      check(where, () => {
        graph.nodeIds(stream.from);
        graph.nodeIds(stream.to);
      });
    }
    for (const play of scene.play ?? []) {
      if (!flowIds.has(play.flow)) throw new Error(`${where}: unknown flow "${play.flow}"`);
    }
  });
}

function check(where: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
}

