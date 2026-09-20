import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Text } from 'troika-three-text';
import type { GroupModel } from './model';
import { smoothstep, type NodeView } from './node';
import { palette } from './palette';
import type { Stage } from './stage';
import { makeText } from './text';

const PAD = 0.6;
/** Extra room above the members for the group's label. */
const LABEL_ROOM = 0.55;
const RADIUS = 0.35;
const LABEL_SIZE = 0.22;

export interface GroupState {
  appear: number;
  dim: number;
}

/**
 * A region around a set of nodes. Flat, it's a dashed outline; seen in 3D it becomes a
 * tinted patch of the sheet with its name printed on it, since outlines floating in
 * perspective read as clutter.
 */
export class GroupView {
  readonly state: GroupState = { appear: 0, dim: 0 };
  readonly group = new THREE.Group();
  private material: LineMaterial;
  private fillMaterial: THREE.MeshBasicMaterial;
  private label: Text;
  private color = new THREE.Color(palette.line).lerp(new THREE.Color('#8C9BB8'), 0.25);
  private flatFill = new THREE.Color('#0E1628');
  private raisedFill = new THREE.Color('#16213A');

  constructor(
    readonly model: GroupModel,
    members: NodeView[],
  ) {
    const box = new THREE.Box2();
    for (const m of members) box.union(m.bounds);
    box.min.subScalar(PAD);
    box.max.addScalar(PAD);
    box.max.y += LABEL_ROOM;

    const w = box.max.x - box.min.x;
    const h = box.max.y - box.min.y;
    const shape = new THREE.Shape();
    const x = box.min.x;
    const y = box.min.y;
    const r = RADIUS;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r);
    shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h);
    shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);

    const geometry = new LineGeometry();
    geometry.setPositions(shape.getSpacedPoints(200).flatMap((p) => [p.x, p.y, 0.002]));
    this.material = new LineMaterial({
      linewidth: 1,
      transparent: true,
      dashed: true,
      dashSize: 0.1,
      gapSize: 0.14,
      depthWrite: false,
      fog: false,
    });
    const line = new Line2(geometry, this.material);
    line.computeLineDistances();
    line.renderOrder = 0.5;

    this.fillMaterial = new THREE.MeshBasicMaterial({ color: this.flatFill, transparent: true, depthWrite: false, fog: false });
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape, 8), this.fillMaterial);
    fill.position.z = 0.001;
    fill.renderOrder = 0.4;

    this.label = makeText({
      text: model.label,
      size: LABEL_SIZE,
      font: 'medium',
      color: '#7C8BA5',
      anchorX: 'left',
      anchorY: 'top',
      renderOrder: 0.6,
    });
    this.label.position.set(box.min.x + 0.3, box.max.y - 0.22, 0.004);
    this.group.add(fill, line, this.label);
  }

  /** `fog` is how much the sheet hides what's beneath; the patch thins out with it. */
  update(stage: Stage, fog: number) {
    const { appear, dim } = this.state;
    const visible = appear > 0.001;
    this.group.visible = visible;
    if (!visible) return;

    const lean = smoothstep(5, 35, stage.view.tilt);
    const brightness = 1 - 0.6 * dim;
    this.material.color.copy(this.color).multiplyScalar(brightness);
    this.material.opacity = appear * (1 - lean);
    this.fillMaterial.color.copy(this.flatFill).lerp(this.raisedFill, lean);
    this.fillMaterial.opacity = appear * (0.5 + 0.4 * lean) * (0.25 + 0.75 * fog) * brightness;
    this.label.fillOpacity = smoothstep(0.4, 1, appear) * brightness;
    this.label.visible = stage.pixelsPerUnit * LABEL_SIZE >= 4;
  }
}
