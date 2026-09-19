export type Role = 'client' | 'edge' | 'service' | 'data' | 'async';

export interface NodeSpec {
  id: string;
  label: string;
  detail?: string;
  role: Role;
  /** Centre position in world units. */
  pos: [number, number];
  /** Width and height in world units. */
  size?: [number, number];
}

export interface EdgeSpec {
  from: string;
  to: string;
}

export interface Diagram {
  title: string;
  subtitle: string;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

/** A list of node ids and/or edge ids (`"from->to"`), or `'*'` for everything. */
export type Selector = string[] | '*';

export interface SceneSpec {
  title: string;
  /** Caption text. Wrap identifiers in backticks to set them as code. */
  body: string;
  /** Nodes on screen. An edge is shown when both of its endpoints are. */
  show: Selector;
  /** Edges with packets moving along them. */
  flow?: Selector;
  /** Nodes and edges that glow. */
  highlight?: Selector;
  /** When set, everything else dims. An edge is focused if listed, or if both endpoints are. */
  focus?: Selector;
  /** Nodes to frame with the camera. Defaults to `show`. */
  camera?: Selector;
}
