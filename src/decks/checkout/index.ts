import { diagram } from '../../engine/builder';

/**
 * The smallest useful deck: four services, one flow, a flat scene and a runtime scene.
 * Start here when writing a new one.
 */
const d = diagram({
  title: 'Checkout',
  subtitle: 'A minimal example deck',
});

const shoppers = d.node('shoppers', { label: 'Shoppers', role: 'client', shape: 'actor', at: [-9, 0] });
const gateway = d.node('gateway', {
  label: 'API gateway',
  role: 'edge',
  at: [-4.5, 0],
  runtime: { kind: 'replicas', count: 4 },
});
const orders = d.node('orders', {
  label: 'Orders',
  detail: 'Creates the order',
  at: [0, 0],
  runtime: { kind: 'replicas', count: 6 },
  info: { about: 'Validates the basket, prices it and writes the order.' },
});
const db = d.node('db', {
  label: 'Orders DB',
  detail: 'Postgres',
  role: 'data',
  shape: 'db',
  at: [4.5, 0],
  runtime: { kind: 'shards', count: 8, route: 'key' },
});

d.connect(shoppers, gateway);
d.connect(gateway, orders);
d.connect(orders, db);

d.flow('checkout', shoppers, (f) => f.send(gateway).send(orders).send(db).respond().respond().respond());

d.scene({
  title: 'A checkout',
  body: 'A shopper checks out. The request passes through the gateway to Orders, which writes to the database and answers back along the same path.',
  show: '*',
  play: [{ flow: 'checkout', pause: 1 }],
});

d.scene({
  title: 'What it runs as',
  body: 'The same checkout, one layer down. Each request lands on one gateway replica and one Orders replica, and writes to the one database shard that owns the order.',
  show: '*',
  runtime: '*',
  highlight: [db],
  play: [{ flow: 'checkout', pause: 1 }],
});

export default d.build();
