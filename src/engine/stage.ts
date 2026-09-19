import * as THREE from 'three';
import { BloomEffect, EffectComposer, EffectPass, RenderPass } from 'postprocessing';
import { palette } from './palette';

/** World units visible vertically at camera zoom 1. */
export const VIEW_HEIGHT = 14;

type Ticker = (time: number, delta: number) => void;

export interface Framing {
  x: number;
  y: number;
  zoom: number;
}

/** Renderer, orthographic camera, bloom and the frame loop. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  width = 0;
  height = 0;
  /** Fraction of the viewport height at the bottom that the caption covers. */
  captionReserve = 0.3;
  /** Fraction of the viewport height at the top kept clear for the deck title. */
  titleReserve = 0.1;

  private composer: EffectComposer;
  private tickers: Ticker[] = [];
  private resizeListeners: (() => void)[] = [];
  private start = performance.now();
  private last = this.start;
  private projected = new THREE.Vector3();

  constructor(
    private container: HTMLElement,
    private labelLayer: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      powerPreference: 'high-performance',
      antialias: false,
      stencil: false,
      depth: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(palette.bg);
    this.camera.position.z = 10;
    this.scene.add(makeGrid(this.renderer.getPixelRatio()));

    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: Math.min(4, this.renderer.capabilities.maxSamples),
    });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(
      new EffectPass(
        this.camera,
        // Only colours pushed above 1.0 (highlights, packets) bloom.
        new BloomEffect({
          mipmapBlur: true,
          luminanceThreshold: 1,
          luminanceSmoothing: 0.3,
          intensity: 1.4,
          radius: 0.72,
        }),
      ),
    );

    addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  onTick(fn: Ticker) {
    this.tickers.push(fn);
  }

  onResize(fn: () => void) {
    this.resizeListeners.push(fn);
  }

  get pixelsPerUnit() {
    return (this.height / VIEW_HEIGHT) * this.camera.zoom;
  }

  toScreen(x: number, y: number): [number, number] {
    const v = this.projected.set(x, y, 0).project(this.camera);
    return [((v.x + 1) / 2) * this.width, ((1 - v.y) / 2) * this.height];
  }

  /** Camera position and zoom that fit `box`, leaving room for the caption. */
  framing(box: THREE.Box2): Framing {
    const pad = 1.1;
    const size = box.getSize(new THREE.Vector2()).addScalar(pad * 2);
    const centre = box.getCenter(new THREE.Vector2());
    const aspect = this.width / this.height;
    const below = this.captionReserve;
    const above = this.titleReserve;
    const zoom = Math.min(
      (VIEW_HEIGHT * aspect) / size.x,
      (VIEW_HEIGHT * (1 - below - above)) / size.y,
      1.7,
    );
    // Centre the content in the band between the title and the caption.
    const visibleHeight = VIEW_HEIGHT / zoom;
    return { x: centre.x, y: centre.y - (visibleHeight * (below - above)) / 2, zoom };
  }

  private resize() {
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;
    const aspect = this.width / this.height;
    // On narrow screens the caption wraps to more lines and needs more room.
    this.captionReserve = this.width < 720 ? 0.42 : 0.3;
    this.camera.left = (-VIEW_HEIGHT * aspect) / 2;
    this.camera.right = (VIEW_HEIGHT * aspect) / 2;
    this.camera.top = VIEW_HEIGHT / 2;
    this.camera.bottom = -VIEW_HEIGHT / 2;
    this.camera.updateProjectionMatrix();
    this.composer.setSize(this.width, this.height);
    for (const fn of this.resizeListeners) fn();
  }

  private frame() {
    const now = performance.now();
    const delta = Math.min((now - this.last) / 1000, 0.1);
    const time = (now - this.start) / 1000;
    this.last = now;

    // Camera position and zoom change outside three.js (tweens, gestures). Refresh both
    // before tickers run, or HTML labels get positioned with last frame's camera.
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.labelLayer.style.setProperty('--ppu', this.pixelsPerUnit.toFixed(3));
    for (const fn of this.tickers) fn(time, delta);
    this.composer.render(delta);
  }
}

function makeGrid(pixelRatio: number) {
  const step = 0.5;
  const half = [60, 36];
  const positions: number[] = [];
  for (let x = -half[0]; x <= half[0]; x += step) {
    for (let y = -half[1]; y <= half[1]; y += step) positions.push(x, y, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: palette.grid,
    size: 1.6 * pixelRatio,
    sizeAttenuation: false,
    depthTest: false,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 0;
  return points;
}
