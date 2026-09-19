# Flow deck

Animated architecture explainers in three.js. A diagram is stepped through as scenes, like slides. Packets flow between services to show requests, fanouts and responses. Leaning the camera back shows the runtime layer: beneath each logical service hangs a tower of the instances it actually runs as (replicas, shards, partitions), and the same flows play out across those instances.

The current content is a made-up online travel platform (`src/estate.ts`): inventory ingestion on one side, search on the other, read stores in the middle.

## Running it

```sh
npm install
npm run dev
```

Use ← → or click to step through scenes, or add `#<scene number>` to the URL. Pinch or ctrl+scroll to zoom, scroll or drag to pan, option+drag to orbit, and press `0` to reset the view.

## Writing a diagram

Diagrams are written with a TypeScript builder:

```ts
const d = diagram({ title: 'OTA platform', subtitle: '…' });

const router = d.node('router', { label: 'GraphQL router', role: 'edge', at: [15, 0],
  runtime: { kind: 'replicas', count: 12 } });
const subgraphs = d.set('subgraph', ['search', 'pricing'], {
  label: (k) => `${k} subgraph`, layout: column([10, 0], 2.3) });
d.connect(router, subgraphs);

d.flow('search', shoppers, (f) =>
  f.send(router).fanout(subgraphs).send('reads').respond().gather(router).respond());

d.scene({ title: 'A search', body: '…', show: ['api', 'reads'], reveal: 'onUse',
  runtime: [router], play: [{ flow: 'search', pause: 1.5 }] });

export const estate = d.build();
```

The builder produces a plain-data model (`src/engine/model.ts`), which a text format can later compile to. See `CLAUDE.md` for the architecture, the design decisions behind it, and what's next.
