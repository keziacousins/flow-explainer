import './style.css';
import { diagram, scenes } from './diagram';
import { mountViewControls } from './engine/controls';
import { Director } from './engine/director';
import { EdgeView } from './engine/edge';
import { NodeView } from './engine/node';
import { Stage } from './engine/stage';
import { mountUI } from './engine/ui';

const labelLayer = document.getElementById('labels')!;
const stage = new Stage(document.getElementById('stage')!, labelLayer);

const nodes = new Map(diagram.nodes.map((spec) => [spec.id, new NodeView(spec, labelLayer)]));
const edges = new Map(
  diagram.edges.map((spec) => {
    const edge = new EdgeView(spec, nodes.get(spec.from)!, nodes.get(spec.to)!);
    return [edge.id, edge];
  }),
);
for (const node of nodes.values()) stage.scene.add(node.group);
for (const edge of edges.values()) stage.scene.add(edge.group);

stage.onTick((time) => {
  for (const node of nodes.values()) node.update(time, stage);
  for (const edge of edges.values()) edge.update(time);
});

document.querySelector('.deck-name')!.textContent = diagram.title;
document.querySelector('.deck-sub')!.textContent = diagram.subtitle;
document.title = diagram.title;

const director = new Director(stage, nodes, edges, scenes);
mountUI(director);
mountViewControls(stage, director);

const sceneFromHash = () => {
  const n = parseInt(location.hash.slice(1), 10);
  return Number.isFinite(n) ? n - 1 : 0;
};
director.go(sceneFromHash());
addEventListener('hashchange', () => director.go(sceneFromHash()));
