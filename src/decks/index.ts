import type { Model } from '../engine/model';

/**
 * Every deck is a folder here with an `index.ts` whose default export is a built Model.
 * They're discovered automatically and loaded only when opened.
 */
const modules = import.meta.glob<{ default: Model }>('./*/index.ts');

/**
 * Decks that aren't ours to publish live in `src/decks-private/`, which is ignored by
 * git. The glob resolves to nothing when that folder is absent, so a clone of the
 * public repository builds with the public decks alone.
 */
const privateModules = import.meta.glob<{ default: Model }>('../decks-private/*/index.ts');

const byId = new Map<string, () => Promise<{ default: Model }>>([
  ...Object.entries(modules).map(([path, load]) => [path.split('/')[1], load] as const),
  ...Object.entries(privateModules).map(([path, load]) => [path.split('/')[2], load] as const),
]);

export const deckIds = [...byId.keys()].sort();

export async function loadDeck(id: string): Promise<Model | undefined> {
  const load = byId.get(id);
  return load ? (await load()).default : undefined;
}
