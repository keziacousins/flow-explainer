// The subset of troika-three-text used here; the package ships without types.
declare module 'troika-three-text' {
  import type { Color, Material, Mesh } from 'three';

  export class Text extends Mesh {
    text: string;
    font: string | null;
    fontSize: number;
    color: Color | string | number;
    fillOpacity: number;
    anchorX: number | 'left' | 'center' | 'right' | `${number}%`;
    anchorY: number | 'top' | 'top-baseline' | 'middle' | 'bottom-baseline' | 'bottom' | `${number}%`;
    letterSpacing: number;
    maxWidth: number;
    material: Material;
    sync(callback?: () => void): void;
    dispose(): void;
  }

  export function preloadFont(options: { font: string; characters?: string }, callback: () => void): void;
}
