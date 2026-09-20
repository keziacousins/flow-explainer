import { deckIds, loadDeck } from './decks';
import type { Model } from './engine/model';

/** The page shown without `?deck=`: every deck, with enough to tell them apart. */
export async function showPicker(missing?: string) {
  document.body.classList.add('is-picker');
  document.title = 'Decks';
  const root = document.getElementById('picker')!;
  root.hidden = false;

  const heading = document.createElement('h1');
  heading.textContent = 'Decks';
  root.append(heading);

  if (missing) {
    const note = document.createElement('p');
    note.className = 'picker-note';
    note.textContent = `There's no deck called “${missing}”. Pick one below.`;
    root.append(note);
  }

  const list = document.createElement('ul');
  root.append(list);
  const decks = await Promise.all(deckIds.map(async (id) => ({ id, model: (await loadDeck(id))! })));
  for (const { id, model } of decks) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `?deck=${encodeURIComponent(id)}`;
    const name = document.createElement('span');
    name.className = 'picker-name';
    name.textContent = model.title;
    const sub = document.createElement('span');
    sub.className = 'picker-sub';
    sub.textContent = model.subtitle;
    const meta = document.createElement('span');
    meta.className = 'picker-meta';
    meta.textContent = summary(model);
    link.append(name, sub, meta);
    item.append(link);
    list.append(item);
  }
}

function summary(model: Model) {
  const outside = new Set(['external', 'client']);
  const services = model.nodes.filter((n) => !outside.has(n.role));
  const instances = services.reduce((sum, n) => sum + (n.runtime?.count ?? 1), 0);
  const scenes = model.scenes.length;
  return `${scenes} ${scenes === 1 ? 'scene' : 'scenes'}, ${services.length} services, ${instances.toLocaleString()} instances`;
}
