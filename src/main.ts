import './style.css';
import { loadDeck } from './decks';
import { playDeck } from './engine/play';
import { showPicker } from './picker';

// `?deck=<id>` plays a deck (with `#<n>` for the scene); without it, show the picker.
const id = new URLSearchParams(location.search).get('deck');
const model = id ? await loadDeck(id) : undefined;
if (model) playDeck(model);
else showPicker(id ?? undefined);
