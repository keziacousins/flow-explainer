import { diagram, grid } from '../../engine/builder';
import { makeRandom } from '../../engine/random';
import type { Role, Runtime, Shape } from '../../engine/model';

/**
 * A generated estate at roughly the real one's scale (about 300 services and 3,000
 * instances) for finding performance and crowding problems before real data arrives.
 * Seeded, so it's the same on every load.
 */
const random = makeRandom(20260919);
const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
const pickFrom = <T>(items: T[]) => items[Math.floor(random() * items.length)];

const DOMAINS = [
  'Search', 'Pricing', 'Inventory', 'Content',
  'Booking', 'Payments', 'Customers', 'Loyalty',
  'Messaging', 'Analytics', 'Supply', 'Partners',
];
const PER_DOMAIN = 25;
const COLUMNS = 5;
const PITCH: [number, number] = [4.2, 2.1];
const DOMAIN_SPACING: [number, number] = [26, 15];

const d = diagram({
  title: 'Synthetic estate',
  subtitle: 'About 300 services and 3,000 instances, generated to test scale',
});

interface Domain {
  id: string;
  gateway: string;
  services: string[];
  stores: string[];
  queue: string;
}

const domains: Domain[] = DOMAINS.map((name, n) => {
  const id = name.toLowerCase();
  const centre: [number, number] = [((n % 4) - 1.5) * DOMAIN_SPACING[0], (1 - Math.floor(n / 4)) * DOMAIN_SPACING[1]];
  const positions = grid(centre, COLUMNS, PITCH)(PER_DOMAIN);

  // Each domain: a gateway, two stores, a queue, and services for the rest.
  const kinds: { role: Role; shape: Shape; label: string; runtime: Runtime }[] = positions.map((_, i) => {
    if (i === 0) return { role: 'edge', shape: 'box', label: `${name} gateway`, runtime: { kind: 'replicas', count: between(8, 16) } };
    if (i === 12) return { role: 'async', shape: 'queue', label: `${name} events`, runtime: { kind: 'partitions', count: between(16, 32) } };
    if (i === 23 || i === 24) {
      return { role: 'data', shape: 'db', label: `${name} store ${i - 22}`, runtime: { kind: 'shards', count: between(16, 48) } };
    }
    const count = random() < 0.12 ? between(12, 24) : between(2, 11);
    return { role: 'service', shape: 'box', label: `${name} ${String(i).padStart(2, '0')}`, runtime: { kind: 'replicas', count } };
  });

  const ids = kinds.map((k, i) =>
    d.node(`${id}-${i}`, {
      label: k.label,
      role: k.role,
      shape: k.shape,
      at: positions[i],
      size: k.shape === 'db' ? [3.4, 1.4] : [3.4, 1.1],
      runtime: k.runtime,
    }),
  );
  return {
    id,
    gateway: ids[0],
    services: ids.filter((_, i) => i !== 0 && i !== 12 && i < 23),
    stores: [ids[23], ids[24]],
    queue: ids[12],
  };
});

const users = d.node('users', { label: 'Users', role: 'client', shape: 'actor', at: [-2.2 * DOMAIN_SPACING[0], DOMAIN_SPACING[1]] });
const edges = new Set<string>();
const link = (a: string, b: string) => {
  if (a === b || edges.has(`${a}>${b}`) || edges.has(`${b}>${a}`)) return;
  edges.add(`${a}>${b}`);
  d.connect(a, b);
};

for (const dom of domains) {
  // A known path for the flow: gateway to its first four services, each of which reads the first store.
  const front = dom.services.slice(0, 4);
  for (const s of front) {
    link(dom.gateway, s);
    link(s, dom.stores[0]);
  }
  // Then a looser web inside the domain.
  dom.services.forEach((s, i) => {
    const later = dom.services.slice(i + 1);
    for (let k = 0; k < between(1, 2) && later.length; k++) link(s, pickFrom(later));
    if (random() < 0.3) link(s, pickFrom(dom.stores));
    if (random() < 0.2) link(s, dom.queue);
  });
}
// Gateways call a couple of other domains, and a scattering of services reach across too.
for (const dom of domains) {
  for (let k = 0; k < 2; k++) link(dom.gateway, pickFrom(domains.filter((o) => o !== dom)).gateway);
}
for (let k = 0; k < 40; k++) {
  const [a, b] = [pickFrom(domains), pickFrom(domains)];
  if (a !== b) link(pickFrom(a.services), pickFrom(b.services));
}
link(users, domains[0].gateway);

for (const dom of domains) {
  d.group(`${dom.id}-domain`, DOMAINS[domains.indexOf(dom)], [dom.gateway, ...dom.services, ...dom.stores, dom.queue]);
}

const search = domains[0];
d.flow('search', users, (f) =>
  f
    .send(search.gateway)
    .fanout(search.services.slice(0, 4), { stagger: 0.05 })
    .send(search.stores[0])
    .respond()
    .gather(search.gateway, { kind: 'response' })
    .respond(),
);

d.scene({
  title: 'Three hundred services',
  body: 'Twelve domains of 25 services each, with background traffic on every connection.',
  show: '*',
  groups: '*',
  streams: [{ from: '*', to: '*', rate: 0.12 }],
});

d.scene({
  title: 'One domain',
  body: 'A search fans out to four services inside the Search domain, each reading the same store, then gathers back at the gateway.',
  show: '*',
  groups: '*',
  camera: 'search-domain',
  focus: 'search-domain',
  highlight: [search.gateway],
  play: [{ flow: 'search', pause: 1 }],
});

d.scene({
  title: 'Three thousand instances',
  body: 'The whole estate, one layer down.',
  show: '*',
  groups: '*',
  runtime: '*',
  fog: 0.3,
  projection: 'parallel',
  streams: [{ from: '*', to: '*', rate: 0.05 }],
});

export default d.build();
