import './style.css';
import { mountViewControls } from './engine/controls';
import { Director } from './engine/director';
import { EdgeView } from './engine/edge';
import { Graph } from './engine/graph';
import { GroupView } from './engine/group';
import { NodeView } from './engine/node';
import { routeEdges } from './engine/routing';
import { Stage } from './engine/stage';
import { Traffic } from './engine/traffic';
import { mountUI } from './engine/ui';
import { estate } from './estate';

const labelLayer = document.getElementById('labels')!;
const stage = new Stage(document.getElementById('stage')!, labelLayer);
const graph = new Graph(estate);

const nodes = new Map(estate.nodes.map((m) => [m.id, new NodeView(m, labelLayer)]));
const curves = routeEdges(graph);
const edges = new Map(
  estate.edges.map((m) => [
    m.id,
    new EdgeView(m, curves.get(m.id)!, nodes.get(m.from)!, nodes.get(m.to)!, labelLayer),
  ]),
);
const groups = new Map(
  estate.groups.map((m) => [m.id, new GroupView(m, m.members.map((id) => nodes.get(id)!), labelLayer)]),
);
const traffic = new Traffic(graph, nodes, edges);

for (const g of groups.values()) stage.scene.add(g.group);
for (const n of nodes.values()) stage.scene.add(n.group);
for (const e of edges.values()) stage.scene.add(e.group);
stage.scene.add(traffic.mesh);

stage.onTick((time, delta) => {
  for (const g of groups.values()) g.update(stage);
  for (const n of nodes.values()) n.update(time, delta, stage);
  for (const e of edges.values()) e.update(stage);
  traffic.tick(delta);
});

document.querySelector('.deck-name')!.textContent = estate.title;
document.querySelector('.deck-sub')!.textContent = estate.subtitle;
document.title = estate.title;

const director = new Director(stage, graph, nodes, edges, groups, traffic);
mountUI(director);
mountViewControls(stage, director);

const sceneFromHash = () => {
  const n = parseInt(location.hash.slice(1), 10);
  return Number.isFinite(n) ? n - 1 : 0;
};
director.go(sceneFromHash());
addEventListener('hashchange', () => director.go(sceneFromHash()));
