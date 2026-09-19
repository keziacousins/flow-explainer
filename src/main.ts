import './style.css';
import { Callouts, diagramObstacles } from './engine/callouts';
import { mountViewControls } from './engine/controls';
import { Director } from './engine/director';
import { EdgeView } from './engine/edge';
import { Graph } from './engine/graph';
import { GroupView } from './engine/group';
import { mountInspector } from './engine/inspector';
import { NodeView } from './engine/node';
import { routeEdges } from './engine/routing';
import { RuntimeLayer } from './engine/runtime';
import { Stage } from './engine/stage';
import { Traffic } from './engine/traffic';
import { mountUI } from './engine/ui';
import { estate } from './estate';

const labelLayer = document.getElementById('labels')!;
const stage = new Stage(document.getElementById('stage')!, labelLayer);
const graph = new Graph(estate);

const nodes = new Map(estate.nodes.map((m) => [m.id, new NodeView(m)]));
const curves = routeEdges(graph);
const edges = new Map(
  estate.edges.map((m) => [
    m.id,
    new EdgeView(m, curves.get(m.id)!, nodes.get(m.from)!, nodes.get(m.to)!),
  ]),
);
const groups = new Map(
  estate.groups.map((m) => [m.id, new GroupView(m, m.members.map((id) => nodes.get(id)!))]),
);
const runtime = new RuntimeLayer(graph, nodes);
const callouts = new Callouts(labelLayer, document.querySelector<SVGSVGElement>('#leaders')!);
const traffic = new Traffic(graph, nodes, edges, runtime);

for (const g of groups.values()) stage.scene.add(g.group);
for (const n of nodes.values()) stage.scene.add(n.group);
for (const e of edges.values()) stage.scene.add(e.group);
stage.scene.add(runtime.group, traffic.logical.mesh, traffic.underneath.mesh);

stage.onTick((time, delta) => {
  for (const g of groups.values()) g.update(stage, runtime.state.fog);
  for (const n of nodes.values()) n.update(time, delta, stage);
  for (const e of edges.values()) e.update(stage);
  runtime.update(delta, stage);
  traffic.tick(delta);
  callouts.update(stage, diagramObstacles(stage, nodes, runtime));
});

document.querySelector('.deck-name')!.textContent = estate.title;
document.querySelector('.deck-sub')!.textContent = estate.subtitle;
document.title = estate.title;

const director = new Director(stage, graph, nodes, edges, groups, runtime, traffic, callouts);
mountUI(director);
mountViewControls(stage, director);
// After the view controls, so their drag detection runs first.
mountInspector(stage, graph, nodes, runtime, director);

const sceneFromHash = () => {
  const n = parseInt(location.hash.slice(1), 10);
  return Number.isFinite(n) ? n - 1 : 0;
};
director.go(sceneFromHash());
addEventListener('hashchange', () => director.go(sceneFromHash()));
