import { describe, expect, it } from 'vitest';
import { column, diagram } from '../src/engine/builder';
import { Graph } from '../src/engine/graph';

function model() {
  const d = diagram({ title: 'Graph', subtitle: '' });
  const hub = d.node('hub', { label: 'Hub', at: [0, 0] });
  const workers = d.set('worker', ['a', 'b'], { label: (k) => `Worker ${k}`, layout: column([4, 0], 2) });
  const store = d.node('store', { label: 'Store', role: 'data', at: [8, 0] });
  d.connect(hub, workers);
  d.connect(workers, [store, store], { pairing: 'zip' });
  d.group('team', 'Team', [hub, workers]);
  d.scene({ title: '', body: '', show: '*' });
  return new Graph(d.build());
}

describe('selectors', () => {
  const graph = model();

  it('resolves node, set and group ids, and everything', () => {
    expect([...graph.nodeIds('hub')]).toEqual(['hub']);
    expect([...graph.nodeIds('worker')]).toEqual(['worker.a', 'worker.b']);
    expect([...graph.nodeIds('team')]).toEqual(['hub', 'worker.a', 'worker.b']);
    expect(graph.nodeIds('*').size).toBe(4);
  });

  it('matches edges in either direction', () => {
    expect([...graph.edgeIds('hub->worker')].sort()).toEqual(['hub->worker.a', 'hub->worker.b']);
    // The edges are declared worker -> store, but either way round finds them.
    expect([...graph.edgeIds('store->worker')].sort()).toEqual(['worker.a->store', 'worker.b->store']);
    expect(graph.edgeIds('*').size).toBe(4);
  });

  it('finds neighbours matching a selector', () => {
    expect(graph.neighbours('hub', 'worker')).toEqual(['worker.a', 'worker.b']);
    expect(graph.neighbours('worker.a', 'store')).toEqual(['store']);
    expect(graph.neighbours('store', 'hub')).toEqual([]);
  });

  it('says which id it did not recognise', () => {
    expect(() => graph.nodeIds('nope')).toThrow(/Unknown node, set or group "nope"/);
  });

  it('finds the edge between two nodes, and which way it runs', () => {
    expect(graph.between('hub', 'worker.a')).toMatchObject({ reverse: false });
    expect(graph.between('worker.a', 'hub')).toMatchObject({ reverse: true });
    expect(graph.between('hub', 'store')).toBeUndefined();
  });
});
