import * as THREE from 'three';
import { Text } from 'troika-three-text';
import mono from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff?url';
import regular from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff?url';
import medium from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff?url';

const FONTS = { regular, medium, mono };

export interface TextOptions {
  text: string;
  /** Height of capitals-ish, in world units. */
  size: number;
  font?: keyof typeof FONTS;
  color?: THREE.ColorRepresentation;
  anchorX?: Text['anchorX'];
  anchorY?: Text['anchorY'];
  renderOrder?: number;
}

/**
 * Text drawn in the scene as signed-distance-field glyphs: crisp at any zoom, hidden
 * behind solid shapes, and able to lie on or stand up from a surface.
 */
export function makeText(opts: TextOptions): Text {
  const t = new Text();
  t.text = opts.text;
  t.fontSize = opts.size;
  t.font = FONTS[opts.font ?? 'regular'];
  t.color = new THREE.Color(opts.color ?? '#DCE4F2');
  t.anchorX = opts.anchorX ?? 'left';
  t.anchorY = opts.anchorY ?? 'middle';
  t.renderOrder = opts.renderOrder ?? 5;
  // troika derives its glyph shader from this base material.
  t.material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  t.sync();
  return t;
}
