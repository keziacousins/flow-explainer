import * as THREE from 'three';
import { BloomEffect, EffectComposer, EffectPass, RenderPass } from 'postprocessing';
import { palette } from './palette';

/** World units visible vertically on the logical plane at zoom 1. */
export const VIEW_HEIGHT = 14;
/** Vertical field of view for perspective scenes. */
export const PERSPECTIVE_FOV = 30;
/** So narrow it's effectively a parallel (axonometric) projection, but still tweenable. */
export const PARALLEL_FOV = 3;
const MAX_TILT = 80;
const MAX_ZOOM = 1.7;

const tanHalf = (fov: number) => Math.tan(THREE.MathUtils.degToRad(fov / 2));
/** Camera distance that shows VIEW_HEIGHT units on the plane at zoom 1. */
const baseDistance = (fov: number) => VIEW_HEIGHT / 2 / tanHalf(fov);

type Ticker = (time: number, delta: number) => void;

/** Where the camera looks: a point on the logical plane (z = 0), zoom, and angles in degrees. */
export interface View {
  x: number;
  y: number;
  zoom: number;
  /** 0 looks straight down; larger values lean the camera back to see depth. */
  tilt: number;
  /** Rotation around the vertical axis. */
  turn: number;
  /** Vertical field of view. Narrowing it towards PARALLEL_FOV flattens perspective. */
  fov: number;
}

export type Framing = Pick<View, 'x' | 'y' | 'zoom'>;

/** Renderer, perspective camera, bloom and the frame loop. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(PERSPECTIVE_FOV, 1, 0.5, 2000);
  /** The camera is driven from this; tween it rather than the camera itself. */
  readonly view: View = { x: 0, y: 0, zoom: 1, tilt: 0, turn: 0, fov: PERSPECTIVE_FOV };
  readonly grid: THREE.Points;
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
  private forward = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

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
    // Fog applies to the dot grid alone (everything else sets `fog: false`), so the grid
    // fades into the distance instead of aliasing into a moiré haze in tilted views.
    this.scene.fog = new THREE.Fog(palette.bg, 1, 100);
    this.grid = makeGrid(this.renderer.getPixelRatio());
    this.scene.add(this.grid);

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

  /** Pixels per world unit on the logical plane at the point the camera looks at. */
  get pixelsPerUnit() {
    return (this.height / VIEW_HEIGHT) * this.view.zoom;
  }

  toScreen(x: number, y: number, z = 0): [number, number] {
    const v = this.projected.set(x, y, z).project(this.camera);
    return [((v.x + 1) / 2) * this.width, ((1 - v.y) / 2) * this.height];
  }

  /** The point on the logical plane under a screen position. */
  groundAt(clientX: number, clientY: number): THREE.Vector3 {
    const rect = this.container.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / this.width) * 2 - 1,
      -((clientY - rect.top) / this.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.ground, hit) ?? hit.set(this.view.x, this.view.y, 0);
  }

  /** Move the view so the plane point at screen offset (dx, dy) from the centre comes to the centre. */
  panBy(dx: number, dy: number) {
    const rect = this.container.getBoundingClientRect();
    const cx = rect.left + this.width / 2;
    const cy = rect.top + this.height / 2;
    const a = this.groundAt(cx, cy);
    const b = this.groundAt(cx + dx, cy + dy);
    this.view.x += b.x - a.x;
    this.view.y += b.y - a.y;
  }

  /** Change zoom, keeping the point on the plane under the pointer fixed. */
  zoomAt(clientX: number, clientY: number, zoom: number) {
    const before = this.groundAt(clientX, clientY);
    this.view.zoom = zoom;
    this.applyView();
    const after = this.groundAt(clientX, clientY);
    this.view.x += before.x - after.x;
    this.view.y += before.y - after.y;
  }

  orbitBy(dTilt: number, dTurn: number) {
    this.view.tilt = THREE.MathUtils.clamp(this.view.tilt + dTilt, 0, MAX_TILT);
    this.view.turn += dTurn;
  }

  /**
   * View that fits `points` for the given angles, keeping them between the title and
   * the caption. Perspective makes this non-linear, so it refines a few times.
   */
  framing(points: THREE.Vector3[], tilt: number, turn: number, fov: number): Framing {
    const { right, up, dir, forward } = basis(tilt, turn);
    const aspect = this.width / this.height;
    const tanV = tanHalf(fov);
    const base = baseDistance(fov);
    const tanH = tanV * aspect;
    const pad = 0.08;
    // The band of the screen available, in normalised device coordinates.
    const bottom = -1 + 2 * this.captionReserve;
    const top = 1 - 2 * this.titleReserve;
    const cos = Math.cos(THREE.MathUtils.degToRad(tilt));

    const target = new THREE.Vector3();
    for (const p of points) target.add(p);
    target.divideScalar(Math.max(points.length, 1)).setZ(0);
    // Start far enough back that everything is well in front of the camera.
    let radius = 0;
    for (const p of points) radius = Math.max(radius, p.distanceTo(target));
    let distance = Math.max(base, (radius * 1.5) / Math.min(tanV, tanH));
    const v = new THREE.Vector3();

    for (let pass = 0; pass < 10; pass++) {
      const eye = target.clone().addScaledVector(dir, -distance);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of points) {
        v.subVectors(p, eye);
        const depth = Math.max(v.dot(dir), 0.1);
        const nx = v.dot(right) / (depth * tanH);
        const ny = v.dot(up) / (depth * tanV);
        minX = Math.min(minX, nx);
        maxX = Math.max(maxX, nx);
        minY = Math.min(minY, ny);
        maxY = Math.max(maxY, ny);
      }
      // Scale distance so the content fills the band, then slide to centre it there.
      const fill = Math.max((maxX - minX) / (2 - 2 * pad), (maxY - minY) / ((top - bottom) * (1 - pad)));
      distance = Math.max(distance * fill, base / MAX_ZOOM);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2 - (top + bottom) / 2;
      target.addScaledVector(right, cx * tanH * distance);
      target.addScaledVector(forward, (cy * tanV * distance) / Math.max(cos, 0.2));
    }
    return { x: target.x, y: target.y, zoom: base / distance };
  }

  private get distance() {
    return baseDistance(this.view.fov) / this.view.zoom;
  }

  private applyView() {
    const { x, y, tilt, turn, fov } = this.view;
    const camera = this.camera;
    const distance = this.distance;
    camera.fov = fov;
    // Keep depth precision proportional: a narrow field of view puts the camera far away.
    camera.near = distance * 0.1;
    camera.far = distance * 3 + 200;
    camera.updateProjectionMatrix();
    camera.rotation.set(THREE.MathUtils.degToRad(tilt), 0, THREE.MathUtils.degToRad(turn), 'ZXY');
    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    camera.position.set(x, y, 0).addScaledVector(this.forward, -distance);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = distance * 0.55;
    fog.far = distance * 1.45;
    camera.updateMatrixWorld();
  }

  private resize() {
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;
    // On narrow screens the caption wraps to more lines and needs more room.
    this.captionReserve = this.width < 720 ? 0.4 : 0.27;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.composer.setSize(this.width, this.height);
    for (const fn of this.resizeListeners) fn();
  }

  private frame() {
    const now = performance.now();
    const delta = Math.min((now - this.last) / 1000, 0.1);
    const time = (now - this.start) / 1000;
    this.last = now;

    // The view changes outside three.js (tweens, gestures). Apply it before tickers
    // run, or HTML labels get positioned with last frame's camera.
    this.applyView();
    this.labelLayer.style.setProperty('--ppu', this.pixelsPerUnit.toFixed(3));
    for (const fn of this.tickers) fn(time, delta);
    this.composer.render(delta);
  }
}

/** Camera axes for the given angles, and the direction on the plane that points "up" the screen. */
export function basis(tilt: number, turn: number) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(tilt), 0, THREE.MathUtils.degToRad(turn), 'ZXY'),
  );
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const forward = new THREE.Vector3(up.x, up.y, 0).normalize();
  return { right, up, dir, forward };
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
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: true,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 0;
  return points;
}
