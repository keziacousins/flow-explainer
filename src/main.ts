// Plex for the HTML UI, self-hosted: the same faces the 3D labels use, with no
// third-party request. Weights are only the ones style.css asks for.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './style.css';
import { loadDeck } from './decks';
import { playDeck } from './engine/play';
import { showPicker } from './picker';

// `?deck=<id>` plays a deck (with `#<n>` for the scene); without it, show the picker.
const id = new URLSearchParams(location.search).get('deck');
const model = id ? await loadDeck(id) : undefined;
if (model) playDeck(model);
else showPicker(id ?? undefined);
