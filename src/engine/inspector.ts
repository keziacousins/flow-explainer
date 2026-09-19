import * as THREE from 'three';
import type { Director } from './director';
import type { Graph } from './graph';
import type { Route, Runtime } from './model';
import { THICKNESS, type NodeView } from './node';
import type { RuntimeLayer } from './runtime';
import type { Stage } from './stage';

const GAP = 28;
const MARGIN = 12;

interface Pick {
  id: string;
  /** Which runtime instance, when a tower slab was clicked. */
  instance?: number;
}

const KIND_SINGULAR: Record<Runtime['kind'], string> = { replicas: 'Replica', shards: 'Shard', partitions: 'Partition' };
const ROUTE_TEXT: Record<Route, string> = {
  any: 'each request goes to one of them',
  all: 'each request goes to all of them',
  key: 'each request goes to the one that owns its key',
};

/**
 * Click a shape (or a slab in its tower) for an info box beside it: what it is, how it
 * runs, and what it talks to. The box follows the shape as the camera moves.
 */
export function mountInspector(
  stage: Stage,
  graph: Graph,
  nodes: Map<string, NodeView>,
  runtime: RuntimeLayer,
  director: Director,
) {
  const surface = document.getElementById('stage')!;
  const box = document.getElementById('info')!;
  const connector = document.querySelector<SVGPolylineElement>('#leaders .info-connector')!;
  const raycaster = new THREE.Raycaster();
  let selected: Pick | null = null;
  let hovered: NodeView | null = null;

  const pick = (clientX: number, clientY: number): Pick | null => {
    const rect = surface.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, stage.camera);
    const targets: THREE.Object3D[] = [];
    for (const node of nodes.values()) if (node.state.appear > 0.5) targets.push(node.body);
    for (const cluster of runtime.clusters.values()) if (cluster.visible) targets.push(cluster.mesh);
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    return { id: hit.object.userData.nodeId, instance: hit.instanceId };
  };

  const close = () => {
    if (selected) nodes.get(selected.id)!.selected = false;
    selected = null;
    box.hidden = true;
    connector.style.visibility = 'hidden';
  };

  const open = (p: Pick) => {
    close();
    selected = p;
    const node = nodes.get(p.id)!;
    node.selected = true;
    box.style.setProperty('--accent', `#${node.accent.getHexString()}`);
    connector.style.setProperty('--accent', `#${node.accent.getHexString()}`);
    box.replaceChildren(...content(p));
    box.hidden = false;
  };

  const content = (p: Pick): Node[] => {
    const model = graph.nodes.get(p.id)!;
    const cluster = runtime.clusters.get(p.id);
    const out: Node[] = [];
    const el = (tag: string, cls: string, text: string) => {
      const e = document.createElement(tag);
      e.className = cls;
      e.textContent = text;
      return e;
    };

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'info-close';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.textContent = '×';
    out.push(closeButton);
    out.push(el('h2', 'info-name', model.label));
    if (model.detail) out.push(el('p', 'info-detail', model.detail));
    if (model.info?.about) out.push(el('p', 'info-about', model.info.about));

    const rows: [string, string][] = [];
    if (cluster && p.instance !== undefined) {
      rows.push(['Instance', `${KIND_SINGULAR[cluster.kind]} ${p.instance + 1} of ${cluster.count}`]);
    }
    if (cluster && cluster.count > 1) rows.push(['Runs as', `${cluster.count} ${cluster.kind}; ${ROUTE_TEXT[cluster.route]}`]);
    else if (cluster) rows.push(['Runs as', 'A single instance']);
    rows.push(...(model.info?.facts ?? []));
    const incoming: string[] = [];
    const outgoing: string[] = [];
    for (const edge of graph.edges.values()) {
      if (edge.to === p.id) incoming.push(graph.nodes.get(edge.from)!.label);
      if (edge.from === p.id) outgoing.push(graph.nodes.get(edge.to)!.label);
    }
    if (incoming.length) rows.push(['Receives from', incoming.join(', ')]);
    if (outgoing.length) rows.push(['Sends to', outgoing.join(', ')]);

    const dl = document.createElement('dl');
    dl.className = 'info-facts';
    for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v));
    out.push(dl);
    return out;
  };

  // Runs after the view controls' capture listener, so a drag never counts as a pick.
  surface.addEventListener(
    'click',
    (e) => {
      const hit = pick(e.clientX, e.clientY);
      if (hit) {
        if (selected?.id === hit.id && selected.instance === hit.instance) close();
        else open(hit);
        e.stopImmediatePropagation();
      } else if (selected) {
        // With a box open, clicking empty space closes it rather than advancing the scene.
        close();
        e.stopImmediatePropagation();
      }
    },
    { capture: true },
  );

  surface.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const hit = pick(e.clientX, e.clientY);
    const node = hit ? nodes.get(hit.id)! : null;
    if (node === hovered) return;
    if (hovered) hovered.hovered = false;
    hovered = node;
    if (hovered) hovered.hovered = true;
    surface.classList.toggle('is-over-shape', !!hovered);
  });

  box.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.info-close')) close();
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  director.onChange(close);

  // Keep the box beside its shape: to the right if there's room, else the left, and
  // clear of the caption.
  stage.onTick(() => {
    if (!selected) return;
    const node = nodes.get(selected.id)!;
    if (node.state.appear < 0.1) return close();
    const { min, max } = node.bounds;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const z of [0, THICKNESS]) {
      for (const [x, y] of [[min.x, min.y], [max.x, min.y], [max.x, max.y], [min.x, max.y]]) {
        const [sx, sy] = stage.toScreen(x, y, z);
        x0 = Math.min(x0, sx);
        y0 = Math.min(y0, sy);
        x1 = Math.max(x1, sx);
        y1 = Math.max(y1, sy);
      }
    }
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const right = x1 + GAP + w < stage.width - MARGIN || x0 - GAP - w < MARGIN;
    const left = right ? x1 + GAP : x0 - GAP - w;
    const caption = document.getElementById('caption')!.getBoundingClientRect();
    const bottom = Math.min(stage.height - MARGIN, left < caption.right + MARGIN ? caption.top - MARGIN : stage.height - MARGIN);
    const top = Math.max(MARGIN, Math.min((y0 + y1) / 2 - h / 2, bottom - h));
    box.style.transform = `translate(${left}px, ${top}px)`;

    const edgeX = right ? x1 : x0;
    const boxX = right ? left : left + w;
    const midY = Math.max(top + 14, Math.min((y0 + y1) / 2, top + h - 14));
    connector.setAttribute('points', `${edgeX},${(y0 + y1) / 2} ${(edgeX + boxX) / 2},${(y0 + y1) / 2} ${(edgeX + boxX) / 2},${midY} ${boxX},${midY}`);
    connector.style.visibility = 'visible';
  });
}
