import { column, diagram, type FlowBuilder } from './engine/builder';

/** A made-up OTA estate: inventory ingestion on the left, search on the right. */
const d = diagram({
  title: 'OTA platform',
  subtitle: 'How inventory gets in and searches get answered',
});

// Ingestion

const providerNames: Record<string, string> = {
  bedbank: 'Bedbank',
  chain: 'Chain CRS',
  flights: 'Flights GDS',
  cars: 'Car hire',
  activities: 'Activities',
  direct: 'Direct contracts',
};
const providerKeys = Object.keys(providerNames);

const providers = d.set('provider', providerKeys, {
  label: (k) => providerNames[k],
  detail: () => 'Pull API',
  role: 'external',
  size: [2.8, 0.95],
  layout: column([-25, 0], 1.3),
});

const fetchers = d.set('fetcher', providerKeys, {
  label: (k) => `${providerNames[k]} fetcher`,
  role: 'service',
  size: [3.3, 0.95],
  layout: column([-20.4, 0], 1.3),
});

const scheduler = d.node('scheduler', { label: 'Fetch scheduler', detail: 'Cron and backoff', at: [-15.5, 5.2] });
const raw = d.node('raw', { label: 'Raw inventory', detail: 'Object store', role: 'data', shape: 'db', at: [-15.5, 0] });
const partners = d.node('partners', {
  label: 'Push partners',
  detail: 'Airline and chain feeds',
  role: 'external',
  size: [2.8, 1.1],
  at: [-25, -6],
});
const push = d.node('push', { label: 'Push gateway', detail: 'Webhooks', role: 'edge', at: [-15.5, -6] });
const normaliser = d.node('normaliser', {
  label: 'Normaliser',
  detail: 'Maps to one schema',
  at: [-10.5, 0],
  runtime: { kind: 'replicas', count: 6 },
});
const changes = d.node('changes', {
  label: 'Inventory changes',
  detail: 'Kafka topic',
  role: 'async',
  shape: 'queue',
  at: [-5.8, 0],
  runtime: { kind: 'partitions', count: 24 },
});

// Projections and read stores

const projectorNames: Record<string, string> = {
  packages: 'Package builder',
  prices: 'Price projector',
  availability: 'Availability projector',
  content: 'Content projector',
};
const projectors = d.set('projector', Object.keys(projectorNames), {
  label: (k) => projectorNames[k],
  role: 'async',
  size: [3.4, 1.1],
  layout: column([0.2, 0], 2.3),
});

const index = d.node('index', {
  label: 'Package index',
  detail: 'In-memory',
  role: 'data',
  at: [5.4, 3.45],
  runtime: { kind: 'shards', count: 30 },
});
const rates = d.node('rates', { label: 'Rate cache', detail: 'Redis', role: 'data', shape: 'db', at: [5.4, 1.15] });
const inventory = d.node('inventory', {
  label: 'Inventory DB',
  detail: 'Cassandra',
  role: 'data',
  shape: 'db',
  at: [5.4, -1.15],
  runtime: { kind: 'shards', count: 12 },
});
const content = d.node('content', {
  label: 'Content store',
  detail: 'Descriptions, images',
  role: 'data',
  shape: 'db',
  at: [5.4, -3.45],
});
const stores = [index, rates, inventory, content];

// Search

const subgraphNames: Record<string, string> = {
  search: 'Search',
  pricing: 'Pricing',
  availability: 'Availability',
  content: 'Content',
};
const subgraphs = d.set('subgraph', Object.keys(subgraphNames), {
  label: (k) => `${subgraphNames[k]} subgraph`,
  size: [3.5, 1.1],
  layout: column([10.6, 0], 2.3),
});
const router = d.node('router', {
  label: 'GraphQL router',
  detail: 'Federated gateway',
  role: 'edge',
  at: [15.5, 0],
  runtime: { kind: 'replicas', count: 12 },
});
const shoppers = d.node('shoppers', { label: 'Shoppers', role: 'client', shape: 'actor', at: [19.6, 0] });

// Connections

d.connect(scheduler, fetchers);
d.connect(fetchers, providers);
d.connect(fetchers, raw);
d.connect(partners, push);
d.connect(push, normaliser);
d.connect(raw, normaliser);
d.connect(normaliser, changes);
d.connect(changes, projectors, { style: 'dashed' });
d.connect(projectors, stores);
d.connect(subgraphs, stores);
d.connect(router, subgraphs);
d.connect(shoppers, router);

d.group('sources', 'Providers', [providers, partners]);
d.group('ingestion', 'Ingestion', [scheduler, fetchers, raw, push, normaliser, changes]);
d.group('projection', 'Projections', projectors);
d.group('reads', 'Read stores', stores);
d.group('api', 'Search API', [router, subgraphs]);

// Flows

const intoTopic = (f: FlowBuilder) => f.send(raw).send(normaliser).send(changes);
const project = (f: FlowBuilder) => f.fanout(projectors, { stagger: 0.05 }).send('reads');

d.flow('fetch-one', scheduler, (f) =>
  intoTopic(f.send(fetchers.get('bedbank')).send(providers).respond({ packets: 4, gap: 0.1 })),
);

d.flow('fetch-one-projected', scheduler, (f) =>
  project(intoTopic(f.send(fetchers.get('bedbank')).send(providers).respond({ packets: 4, gap: 0.1 }))),
);

d.flow('refresh', scheduler, (f) =>
  project(
    intoTopic(
      f
        .fanout(fetchers, { stagger: 0.12 })
        .send(providers)
        .drop(providers.get('cars'))
        .respond({ packets: 3, gap: 0.1 }),
    ),
  ),
);

const query = (id: string, parts: string[]) =>
  d.flow(id, shoppers, (f) =>
    f
      .send(router)
      .fanout(parts.map((p) => subgraphs.get(p)), { stagger: 0.04 })
      .send('reads')
      .respond()
      .gather(router, { kind: 'response' })
      .send(shoppers, { kind: 'response' }),
  );
query('hotel-search', ['search', 'pricing', 'availability']);
query('hotel-page', ['content', 'pricing', 'availability']);

// Scenes

const ambient = [
  { from: fetchers, to: providers, rate: 0.35 },
  { from: providers, to: fetchers, rate: 0.35, kind: 'response' as const },
  { from: partners, to: push, rate: 0.7, burst: 3, jitter: 0.8 },
  { from: [raw, push], to: normaliser, rate: 0.7 },
  { from: normaliser, to: changes, rate: 1.1 },
  { from: changes, to: projectors, rate: 0.7 },
  { from: projectors, to: 'reads', rate: 0.7 },
  { from: shoppers, to: router, rate: 1.4 },
  { from: router, to: subgraphs, rate: 0.9 },
  { from: subgraphs, to: 'reads', rate: 0.9 },
];

d.scene({
  title: 'Two halves of one estate',
  body: 'Inventory arrives from providers on the left. Shoppers search from the right. The read stores in the middle are where the two meet.',
  show: '*',
  groups: '*',
  streams: ambient,
});

d.scene({
  title: 'Fetching one provider',
  body: 'The scheduler asks the bedbank fetcher for fresh rates. The fetcher pulls them a page at a time, saves the raw response, and hands it to the normaliser.',
  show: ['sources', 'ingestion'],
  groups: ['sources', 'ingestion'],
  highlight: [fetchers.get('bedbank')],
  play: [{ flow: 'fetch-one' }],
});

d.scene({
  title: 'One change, four projections',
  body: 'Normalised changes land on a Kafka topic with 24 partitions. Four projectors each read every change and build their own store, shaped for the queries that will use it.',
  show: ['sources', 'ingestion', 'projection', 'reads'],
  camera: [normaliser, changes, 'projection', 'reads'],
  groups: ['projection', 'reads'],
  highlight: [changes],
  focus: [normaliser, changes, 'projection', 'reads'],
  reveal: 'onUse',
  play: [{ flow: 'fetch-one-projected', pause: 1.5 }],
});

d.scene({
  title: 'A full refresh',
  body: 'A full refresh fans out to every fetcher at once. Car hire times out, so its work is dropped until the next run. The other five carry on through the pipeline.',
  show: ['sources', 'ingestion', 'projection', 'reads'],
  groups: ['sources', 'ingestion', 'projection', 'reads'],
  highlight: [scheduler],
  reveal: 'onUse',
  play: [{ flow: 'refresh', pause: 2.5 }],
});

d.scene({
  title: 'Pushed, not pulled',
  body: 'Some partners push changes to us instead of waiting to be asked. Their traffic arrives in bursts, while fetchers poll on a steady schedule.',
  show: ['sources', 'ingestion'],
  camera: ['sources', raw, push, normaliser],
  groups: ['sources', 'ingestion'],
  highlight: [push],
  streams: [
    { from: partners, to: push, rate: 1.2, burst: 4, jitter: 0.9 },
    { from: push, to: normaliser, rate: 2, jitter: 0.6 },
    { from: fetchers, to: providers, rate: 0.3, jitter: 0.03 },
    { from: providers, to: fetchers, rate: 0.3, jitter: 0.03, kind: 'response' },
  ],
});

d.scene({
  title: 'A hotel search',
  body: 'The GraphQL router splits one search into three subgraph calls: search, pricing and availability. It waits for all three before it answers.',
  show: ['api', 'reads', shoppers],
  groups: ['api', 'reads'],
  highlight: [router],
  reveal: 'onUse',
  play: [{ flow: 'hotel-search', pause: 1.5 }],
});

d.scene({
  title: 'A different query, different systems',
  body: 'Opening a hotel page asks for content instead of search results. Same router, but a different set of subgraphs and stores.',
  show: ['api', 'reads', shoppers],
  groups: ['api', 'reads'],
  highlight: [subgraphs.get('content')],
  reveal: 'onUse',
  play: [{ flow: 'hotel-page', pause: 1.5 }],
});

d.scene({
  title: 'Every search reads the index',
  body: 'Every search reads the package index. It is one box on this diagram, but it runs as 30 shards, and every query touches all of them. That is the next layer down.',
  show: ['api', 'reads', shoppers],
  groups: ['api', 'reads'],
  highlight: [index],
  focus: [index, subgraphs.get('search'), router, shoppers],
  streams: [
    { from: shoppers, to: router, rate: 3, jitter: 0.6 },
    { from: router, to: subgraphs.get('search'), rate: 3, jitter: 0.6 },
    { from: subgraphs.get('search'), to: index, rate: 3, jitter: 0.6 },
    { from: index, to: subgraphs.get('search'), rate: 3, jitter: 0.6, kind: 'response' },
  ],
});

d.scene({
  title: 'The whole estate',
  body: 'Both halves at once: background traffic everywhere, with a refresh and two kinds of search running through it.',
  show: '*',
  groups: '*',
  streams: ambient.map((s) => ({ ...s, rate: s.rate * 0.6 })),
  play: [
    { flow: 'refresh', pause: 3 },
    { flow: 'hotel-search', delay: 1, pause: 1.2 },
    { flow: 'hotel-page', delay: 2.5, pause: 2 },
  ],
});

export const estate = d.build();
