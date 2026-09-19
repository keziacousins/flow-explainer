import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { GroupModel } from './model';
import { smoothstep, type NodeView } from './node';
import { palette } from './palette';
import type { Stage } from './stage';

const PAD = 0.6;
/** Extra room above the members for the group's label. */
const LABEL_ROOM = 0.55;
const RADIUS = 0.35;

export interface GroupState {
  appear: number;
  dim: number;
}

/** A labelled outline around a set of nodes. */
export class GroupView {
  readonly state: GroupState = { appear: 0, dim: 0 };
  readonly group = new THREE.Group();
  private material: LineMaterial;
  private fillMaterial: THREE.MeshBasicMaterial;
  private label: HTMLElement;
  private corner: THREE.Vector2;
  private color = new THREE.Color(palette.line).lerp(new THREE.Color('#8C9BB8'), 0.25);

  constructor(
    readonly model: GroupModel,
    members: NodeView[],
    labelLayer: HTMLElement,
  ) {
    const box = new THREE.Box2();
    for (const m of members) box.union(m.bounds);
    box.min.subScalar(PAD);
    box.max.addScalar(PAD);
    box.max.y += LABEL_ROOM;
    this.corner = new THREE.Vector2(box.min.x, box.max.y);

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
    geometry.setPositions(shape.getSpacedPoints(200).flatMap((p) => [p.x, p.y, 0]));
    this.material = new LineMaterial({
      linewidth: 1,
      transparent: true,
      dashed: true,
      dashSize: 0.1,
      gapSize: 0.14,
      depthTest: false,
      depthWrite: false,
    });
    const line = new Line2(geometry, this.material);
    line.computeLineDistances();
    line.renderOrder = 0.5;

    // A faint wash so the grouped area reads as a region.
    this.fillMaterial = new THREE.MeshBasicMaterial({
      color: '#0E1628',
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape, 8), this.fillMaterial);
    fill.renderOrder = 0.4;
    this.group.add(fill, line);

    this.label = document.createElement('div');
    this.label.className = 'group-label';
    this.label.textContent = model.label;
    labelLayer.appendChild(this.label);
  }

  update(stage: Stage) {
    const { appear, dim } = this.state;
    const visible = appear > 0.001;
    this.group.visible = visible;
    this.label.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) return;

    const brightness = 1 - 0.6 * dim;
    this.material.color.copy(this.color).multiplyScalar(brightness);
    this.material.opacity = appear;
    this.fillMaterial.opacity = appear * 0.5 * brightness;

    const inset = stage.pixelsPerUnit * 0.3;
    this.label.style.transform = stage.labelTransform(
      this.corner.x,
      this.corner.y,
      0,
      `translate(${inset}px, ${inset * 0.7}px)`,
    );
    this.label.style.opacity = String(smoothstep(0.4, 1, appear) * brightness);
  }
}
