import { describe, expect, it } from 'vitest';
import { deckIds, loadDeck } from '../src/decks';

/**
 * Building a deck validates every reference in it, so simply loading each one catches
 * mistyped ids in scenes, flows and groups.
 */
describe('decks', () => {
  it('finds the decks', () => {
    expect(deckIds.length).toBeGreaterThan(0);
  });

  it.each(deckIds)('%s builds and has scenes', async (id) => {
    const model = (await loadDeck(id))!;
    expect(model.title).toBeTruthy();
    expect(model.scenes.length).toBeGreaterThan(0);
    expect(new Set(model.nodes.map((n) => n.id)).size).toBe(model.nodes.length);
    for (const scene of model.scenes) expect(scene.body).toBeTruthy();
  });
});
