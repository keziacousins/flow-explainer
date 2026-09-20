import type { Model } from '../engine/model';

/**
 * Every deck is a folder here with an `index.ts` whose default export is a built Model.
 * They're discovered automatically and loaded only when opened.
 */
const modules = import.meta.glob<{ default: Model }>('./*/index.ts');

export const deckIds = Object.keys(modules)
  .map((path) => path.split('/')[1])
  .sort();

export async function loadDeck(id: string): Promise<Model | undefined> {
  const load = modules[`./${id}/index.ts`];
  return load ? (await load()).default : undefined;
}
