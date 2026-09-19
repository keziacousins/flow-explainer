/**
 * The plain-data description of a diagram, its flows and its scenes. Everything the
 * engine renders comes from this. It holds no functions, so a future text DSL can
 * compile to it directly. The builder in `builder.ts` is the current way to write one.
 */

export type Role = 'client' | 'external' | 'edge' | 'service' | 'data' | 'async';
export type Shape = 'box' | 'db' | 'queue' | 'actor';
export type Side = 'left' | 'right' | 'top' | 'bottom';

/** How a logical node is multiplied at runtime. */
export interface Runtime {
  kind: 'replicas' | 'shards' | 'partitions';
  count: number;
}

/**
 * Picks nodes by id. An id can name a node, a node set (all its members) or a group
 * (all its members). `'*'` is every node. Edge selectors use `from->to`, where each
 * side is itself a node selector, e.g. `fetcher->provider`.
 */
export type Selector = string | string[];

export interface NodeModel {
  id: string;
  label: string;
  detail?: string;
  role: Role;
  shape: Shape;
  pos: [number, number];
  size: [number, number];
  runtime?: Runtime;
}

export interface EdgeModel {
  id: string;
  from: string;
  to: string;
  style: 'solid' | 'dashed';
  label?: string;
  /** Force the sides the edge leaves and enters by. Chosen automatically otherwise. */
  ports?: [Side, Side];
}

export interface GroupModel {
  id: string;
  label: string;
  members: string[];
}

export type PacketKind = 'request' | 'response' | 'error';

export interface HopOptions {
  kind?: PacketKind;
  /** Seconds between launches when one step sends to several targets. */
  stagger?: number;
  /** Packets per hop, e.g. pages of a response. The flow moves on when the last one lands. */
  packets?: number;
  /** Seconds between packets in a multi-packet hop. */
  gap?: number;
  /** World units per second. */
  speed?: number;
  /** Packet scale. */
  size?: number;
  /** Seconds the receiving node spends before the next step. */
  hold?: number;
}

export type FlowStep =
  /** Move to the one node matching `to` that is connected to the current node. */
  | { op: 'send'; to: Selector; opts: HopOptions }
  /** Split into one packet per node matching `to` that is connected to the current node. */
  | { op: 'fanout'; to: Selector; opts: HopOptions }
  /** Go back to the node the packet came from. */
  | { op: 'respond'; opts: HopOptions }
  /** Every packet travels to `to`; the flow continues as one packet once all have arrived. */
  | { op: 'gather'; to: string; opts: HopOptions }
  /** Stop packets that are at a node matching `at` (or every packet). */
  | { op: 'drop'; at?: Selector }
  | { op: 'hold'; seconds: number };

export interface FlowModel {
  id: string;
  start: string;
  steps: FlowStep[];
}

/** Continuous background traffic between two sets of nodes. */
export interface StreamModel {
  from: Selector;
  to: Selector;
  /** Packets per second, per edge. */
  rate?: number;
  speed?: number;
  /** 0 is evenly spaced; 1 is very irregular. */
  jitter?: number;
  /** Packets sent together each time. */
  burst?: number;
  kind?: PacketKind;
}

export interface PlayModel {
  flow: string;
  /** Seconds to wait before the first run. */
  delay?: number;
  /** Seconds between the end of one run and the start of the next. */
  pause?: number;
  once?: boolean;
}

export interface SceneModel {
  title: string;
  /** Caption text. Wrap identifiers in backticks to set them as code. */
  body: string;
  /** Nodes on screen. An edge is shown when both of its endpoints are. */
  show: Selector;
  /** Nodes and edges that glow. */
  highlight?: Selector;
  /** When set, everything else dims. An edge is focused if listed, or if both endpoints are. */
  focus?: Selector;
  /** Nodes to frame with the camera. Defaults to `show`. */
  camera?: Selector;
  /** Group outlines to draw. */
  groups?: Selector;
  streams?: StreamModel[];
  play?: PlayModel[];
  /** `onUse`: edges stay hidden until a packet travels them, drawing the line as it goes. */
  reveal?: 'eager' | 'onUse';
}

export interface Model {
  title: string;
  subtitle: string;
  nodes: NodeModel[];
  edges: EdgeModel[];
  groups: GroupModel[];
  /** Node set id to member node ids. */
  sets: Record<string, string[]>;
  flows: FlowModel[];
  scenes: SceneModel[];
}
