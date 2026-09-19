import type { Diagram, SceneSpec } from './engine/types';

export const diagram: Diagram = {
  title: 'Checkout platform',
  subtitle: 'How an order moves through the system',
  nodes: [
    { id: 'shoppers', label: 'Shoppers', detail: 'Web and mobile apps', role: 'client', pos: [-10, 0] },
    { id: 'gateway', label: 'API gateway', detail: 'Routes /checkout', role: 'edge', pos: [-5.5, 0] },
    { id: 'auth', label: 'Auth', detail: 'Verifies the session', role: 'edge', pos: [-1, 3] },
    { id: 'orders', label: 'Orders', detail: 'Creates the order', role: 'service', pos: [-1, 0] },
    { id: 'pricing', label: 'Pricing', detail: 'Totals, tax, discounts', role: 'service', pos: [-1, -3] },
    { id: 'db', label: 'Orders DB', detail: 'Postgres', role: 'data', pos: [3.8, -3] },
    { id: 'bus', label: 'Event bus', detail: 'Kafka', role: 'async', pos: [3.8, 0] },
    { id: 'fulfilment', label: 'Fulfilment', detail: 'Reserves stock, books courier', role: 'async', pos: [9.4, 1.8], size: [3.6, 1.5] },
    { id: 'notify', label: 'Notifications', detail: 'Email and push receipt', role: 'async', pos: [9.4, -1.8], size: [3.6, 1.5] },
  ],
  edges: [
    { from: 'shoppers', to: 'gateway' },
    { from: 'gateway', to: 'auth' },
    { from: 'gateway', to: 'orders' },
    { from: 'orders', to: 'pricing' },
    { from: 'orders', to: 'db' },
    { from: 'orders', to: 'bus' },
    { from: 'bus', to: 'fulfilment' },
    { from: 'bus', to: 'notify' },
  ],
};

const syncPath = ['shoppers', 'gateway', 'auth', 'orders', 'pricing'];

export const scenes: SceneSpec[] = [
  {
    title: 'A checkout, start to finish',
    body: 'Follow one order from the moment a shopper taps Pay until the receipt lands in their inbox.',
    show: ['shoppers'],
    highlight: ['shoppers'],
    camera: ['shoppers', 'gateway'],
  },
  {
    title: 'Every request enters through the gateway',
    body: 'The gateway terminates TLS, applies rate limits, and routes `POST /checkout` to the right service.',
    show: ['shoppers', 'gateway'],
    flow: ['shoppers->gateway'],
    highlight: ['gateway', 'shoppers->gateway'],
  },
  {
    title: 'Auth checks who is asking',
    body: 'Before anything else, the session token is verified. Requests without a valid session stop here with a `401`.',
    show: ['shoppers', 'gateway', 'auth'],
    flow: ['shoppers->gateway', 'gateway->auth'],
    highlight: ['auth', 'gateway->auth'],
    focus: ['gateway', 'auth'],
  },
  {
    title: 'Orders builds the order',
    body: 'The order service asks Pricing for the final total, including tax and discounts, then prepares the order.',
    show: syncPath,
    flow: ['shoppers->gateway', 'gateway->orders', 'orders->pricing'],
    highlight: ['orders', 'gateway->orders', 'orders->pricing'],
    focus: ['gateway', 'orders', 'pricing'],
  },
  {
    title: 'The write happens before the reply',
    body: 'The shopper sees a confirmation only once the order is safely in Postgres. Everything so far takes about 300 ms.',
    show: [...syncPath, 'db'],
    flow: ['shoppers->gateway', 'gateway->orders', 'orders->db'],
    highlight: ['db', 'orders->db'],
    focus: ['orders', 'db'],
  },
  {
    title: 'Everything else happens later',
    body: 'Orders publishes `order.created` and moves on. Fulfilment and Notifications each pick up the event at their own pace.',
    show: '*',
    flow: ['orders->bus', 'bus->fulfilment', 'bus->notify'],
    highlight: ['bus', 'orders->bus'],
    focus: ['bus', 'fulfilment', 'notify', 'orders->bus'],
    camera: ['orders', 'bus', 'fulfilment', 'notify', 'db'],
  },
  {
    title: 'The whole picture',
    body: 'Synchronous on the left, asynchronous on the right. If the event bus slows down, shoppers can still check out.',
    show: '*',
    flow: '*',
  },
];
