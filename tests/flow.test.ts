import { describe, expect, it } from 'vitest';
import { diagram } from '../src/engine/builder';
import { FlowRun } from '../src/engine/flow';
import type { Model } from '../src/engine/model';
import { TestWorld } from './world';

/** A hub joined to three leaves, each of which reads the same store. */
function fanoutModel() {
  const d = diagram({ title: 'Test', subtitle: '' });
  const hub = d.node('hub', { label: 'Hub', at: [0, 0], runtime: { kind: 'replicas', count: 4 } });
  const leaves = ['x', 'y', 'z'].map((id) =>
    d.node(id, { label: id, at: [4, 0], runtime: { kind: 'replicas', count: 2 } }),
  );
  const store = d.node('store', {
    label: 'Store',
    role: 'data',
    at: [8, 0],
    runtime: { kind: 'shards', count: 3 },
  });
  const after = d.node('after', { label: 'After', at: [-4, 0] });
  d.connect(hub, leaves);
  for (const leaf of leaves) d.connect(leaf, store);
  d.connect(hub, after);
  return { d, hub, leaves, store, after };
}

function play(model: Model, flowId: string, options?: { lowered?: boolean }) {
  const world = new TestWorld(model, options);
  let done = false;
  const run = new FlowRun(
    world,
    model.flows.find((f) => f.id === flowId)!,
    () => {
      done = true;
    },
  );
  run.start();
  world.run();
  return { world, done };
}

describe('flows', () => {
  it('walks back the way it came, one hop per respond', () => {
    const d = diagram({ title: 'Chain', subtitle: '' });
    const [a, b, c, e] = ['a', 'b', 'c', 'd'].map((id) => d.node(id, { label: id, at: [0, 0] }));
    d.connect(a, b);
    d.connect(b, c);
    d.connect(c, e);
    d.flow('there-and-back', a, (f) => f.send(b).send(c).send(e).respond().respond().respond());
    d.scene({ title: '', body: '', show: '*' });

    const { world, done } = play(d.build(), 'there-and-back');
    expect(world.route()).toEqual(['a->b', 'b->c', 'c->d', 'd->c', 'c->b', 'b->a']);
    expect(world.warnings).toEqual([]);
    expect(done).toBe(true);
  });

  it('gathers every branch into one before carrying on', () => {
    const { d, hub, leaves, after } = fanoutModel();
    d.flow('scatter', hub, (f) => f.fanout(leaves).gather(hub).send(after));
    d.scene({ title: '', body: '', show: '*' });

    const { world, done } = play(d.build(), 'scatter');
    expect(world.route().slice(0, 3).sort()).toEqual(['hub->x', 'hub->y', 'hub->z']);
    expect(world.route().slice(3, 6).sort()).toEqual(['x->hub', 'y->hub', 'z->hub']);
    // One hop onward, from the single token the gather produced.
    expect(world.route().filter((hop) => hop === 'hub->after')).toHaveLength(1);
    expect(done).toBe(true);
  });

  it('keeps going when a branch is dropped', () => {
    const { d, hub, leaves, after } = fanoutModel();
    d.flow('lossy', hub, (f) => f.fanout(leaves).drop('y').gather(hub).send(after));
    d.scene({ title: '', body: '', show: '*' });

    const { world, done } = play(d.build(), 'lossy');
    expect(world.events.filter((e) => e.type === 'drop').map((e) => e.node)).toEqual(['y']);
    expect(world.route()).toContain('x->hub');
    expect(world.route()).not.toContain('y->hub');
    expect(world.route().filter((hop) => hop === 'hub->after')).toHaveLength(1);
    expect(done).toBe(true);
  });

  it('finishes with a warning when a step has nowhere to go', () => {
    const d = diagram({ title: 'Stuck', subtitle: '' });
    const a = d.node('a', { label: 'a', at: [0, 0] });
    const b = d.node('b', { label: 'b', at: [4, 0] });
    d.connect(a, b);
    d.flow('stuck', a, (f) => f.send(b).send(b));
    d.scene({ title: '', body: '', show: '*' });

    const { world, done } = play(d.build(), 'stuck');
    expect(world.warnings).toHaveLength(1);
    expect(world.warnings[0]).toContain('is connected to b');
    expect(done).toBe(true);
  });

  it('sends several packets a gap apart and moves on after the last', () => {
    const d = diagram({ title: 'Pages', subtitle: '' });
    const a = d.node('a', { label: 'a', at: [0, 0] });
    const b = d.node('b', { label: 'b', at: [4, 0] });
    d.connect(a, b);
    d.flow('pages', a, (f) => f.send(b, { packets: 3, gap: 0.5, hold: 0 }));
    d.scene({ title: '', body: '', show: '*' });

    const { world } = play(d.build(), 'pages');
    const hop = world.hops()[0];
    expect(hop.packets).toBe(3);
    // One travel time, plus the gaps before the last packet left.
    expect(world.log.find((entry) => entry.event.type === 'arrive' && entry.event.node === 'b')!.at).toBe(2);
  });
});

describe('flows across runtime instances', () => {
  it('scatters to every shard and returns to the instance that asked', () => {
    const { d, hub, leaves, store } = fanoutModel();
    d.flow('read', hub, (f) => f.send(leaves[0]).send(store).respond().respond());
    d.scene({ title: '', body: '', show: '*' });

    const { world } = play(d.build(), 'read', { lowered: true });
    const [toLeaf, toStore, backToLeaf, backToHub] = world.hops();
    expect(toStore.toPods).toEqual([0, 1, 2]); // shards default to 'all'
    expect(backToLeaf.fromPods).toEqual([0, 1, 2]);
    expect(backToLeaf.toPods).toEqual(toLeaf.toPods); // the leaf replica that asked
    expect(backToHub.toPods).toEqual(toLeaf.fromPods); // the hub replica that started it
  });

  it('sends a keyed write to one shard, the same one each time', () => {
    const { d, hub, leaves, store } = fanoutModel();
    d.flow('write', hub, (f) => f.send(leaves[0]).send(store, { route: 'key' }).respond().send(store, { route: 'key' }));
    d.scene({ title: '', body: '', show: '*' });

    const { world } = play(d.build(), 'write', { lowered: true });
    const writes = world.hops().filter((h) => h.to === 'store');
    expect(writes[0].toPods).toHaveLength(1);
    expect(writes[1].toPods).toEqual(writes[0].toPods);
  });

  it('leaves instances out when the runtime layer is not showing', () => {
    const { d, hub, leaves } = fanoutModel();
    d.flow('flat', hub, (f) => f.send(leaves[0]));
    d.scene({ title: '', body: '', show: '*' });

    const { world } = play(d.build(), 'flat');
    expect(world.hops()[0].fromPods).toBeUndefined();
    expect(world.hops()[0].toPods).toBeUndefined();
  });
});
