import { gsap } from 'gsap';
import type { Director } from './director';
import type { Stage } from './stage';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
/** Pointer travel, in pixels, before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD = 4;

/** Safari's non-standard pinch event. */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/**
 * Trackpad and mouse navigation. Pinch (or ctrl + scroll) zooms at the pointer,
 * two-finger scroll or drag pans. Taking over the camera stops any scene camera move
 * until the view is reset or the scene changes.
 */
export function mountViewControls(stage: Stage, director: Director) {
  const app = document.getElementById('app')!;
  const surface = document.getElementById('stage')!;
  const reset = document.querySelector<HTMLButtonElement>('#nav .reset')!;
  const camera = stage.camera;

  const takeOver = () => {
    gsap.killTweensOf([camera, camera.position]);
    director.cameraFree = true;
    reset.hidden = false;
  };

  const pan = (dx: number, dy: number) => {
    const ppu = stage.pixelsPerUnit;
    camera.position.x += dx / ppu;
    camera.position.y -= dy / ppu;
  };

  // Keep the world point under the pointer fixed while zooming.
  const zoomAt = (clientX: number, clientY: number, zoom: number) => {
    const rect = surface.getBoundingClientRect();
    const sx = clientX - rect.left - stage.width / 2;
    const sy = clientY - rect.top - stage.height / 2;
    const before = stage.pixelsPerUnit;
    camera.zoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
    const after = stage.pixelsPerUnit;
    camera.position.x += sx / before - sx / after;
    camera.position.y -= sy / before - sy / after;
  };

  let gesturing = false;

  app.addEventListener(
    'wheel',
    (e) => {
      // Stop the browser zooming the page on pinch.
      e.preventDefault();
      if (gesturing) return;
      takeOver();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.height : 1;
      if (e.ctrlKey) {
        // Trackpad pinch arrives as ctrl + wheel. Clamp so a mouse wheel notch isn't a jump.
        const dy = Math.min(Math.max(e.deltaY * unit, -50), 50);
        zoomAt(e.clientX, e.clientY, camera.zoom * Math.exp(-dy * 0.01));
      } else {
        pan(e.deltaX * unit, e.deltaY * unit);
      }
    },
    { passive: false },
  );

  let gestureStartZoom = 1;
  app.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    gesturing = true;
    takeOver();
    gestureStartZoom = camera.zoom;
  });
  app.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const g = e as GestureEvent;
    zoomAt(g.clientX, g.clientY, gestureStartZoom * g.scale);
  });
  app.addEventListener('gestureend', (e) => {
    e.preventDefault();
    gesturing = false;
  });

  let press: { startX: number; startY: number; x: number; y: number } | null = null;
  let dragged = false;

  surface.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    press = { startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY };
    dragged = false;
    surface.setPointerCapture(e.pointerId);
  });

  surface.addEventListener('pointermove', (e) => {
    if (!press) return;
    if (!dragged) {
      if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) < DRAG_THRESHOLD) return;
      dragged = true;
      takeOver();
      surface.classList.add('is-dragging');
    }
    pan(press.x - e.clientX, press.y - e.clientY);
    press.x = e.clientX;
    press.y = e.clientY;
  });

  const release = () => {
    press = null;
    surface.classList.remove('is-dragging');
  };
  surface.addEventListener('pointerup', release);
  surface.addEventListener('pointercancel', release);

  // A drag shouldn't also count as a click that advances the scene.
  surface.addEventListener(
    'click',
    (e) => {
      if (!dragged) return;
      dragged = false;
      e.stopImmediatePropagation();
    },
    { capture: true },
  );

  const resetView = () => {
    director.reframe();
    reset.hidden = true;
  };
  reset.addEventListener('click', resetView);
  addEventListener('keydown', (e) => {
    if (e.key === '0' && !e.metaKey && !e.ctrlKey) resetView();
  });
  director.onChange(() => {
    reset.hidden = true;
  });
}
