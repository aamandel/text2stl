import * as THREE from 'three';
import { Handle } from 'text2stl/services/text-maker';

export type SupportRect = { left: number; right: number; bottom: number; top: number };

type Pt = { x: number; y: number };

const EPS = 1e-6;

// Remove consecutive duplicate and collinear points from a closed polygon ring.
function cleanPolygon(points: Pt[]): Pt[] {
  const deduped: Pt[] = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) {
      deduped.push(p);
    }
  }
  // Drop a closing duplicate of the first point.
  if (deduped.length > 1) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (Math.abs(first.x - last.x) <= EPS && Math.abs(first.y - last.y) <= EPS) {
      deduped.pop();
    }
  }

  // Remove collinear points (a vertex where the turn is ~0).
  const result: Pt[] = [];
  const n = deduped.length;
  for (let i = 0; i < n; i++) {
    const prev = deduped[(i - 1 + n) % n];
    const cur = deduped[i];
    const next = deduped[(i + 1) % n];
    const cross =
      (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (Math.abs(cross) > EPS) {
      result.push(cur);
    }
  }

  return result.length >= 3 ? result : deduped;
}

/**
 * Build a THREE.Shape from a polygon ring, rounding every corner. The same
 * quadratic-through-vertex construction is tangent to both adjacent edges
 * regardless of the turn direction: convex corners are cut inward, while
 * reflex/step corners (e.g. where a narrow last-line tab meets the wider body)
 * get a concave fillet that grows with the radius. The corner radius is capped
 * to half of the shorter adjacent edge so short edges never over-round and
 * neighbouring corners can't overlap.
 */
export function roundedPolygonShape(rawPoints: Pt[], radius: number): THREE.Shape {
  const pts = cleanPolygon(rawPoints);
  const shape = new THREE.Shape();
  const n = pts.length;
  if (n < 3) {
    return shape;
  }

  for (let i = 0; i < n; i++) {
    const v = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];

    const len1 = Math.hypot(v.x - prev.x, v.y - prev.y);
    const len2 = Math.hypot(next.x - v.x, next.y - v.y);
    const t = Math.min(radius, len1 / 2, len2 / 2);

    if (radius <= 0 || t <= EPS) {
      // Sharp corner.
      if (i === 0) {
        shape.moveTo(v.x, v.y);
      } else {
        shape.lineTo(v.x, v.y);
      }
      continue;
    }

    // Unit vectors from the vertex toward its neighbours.
    const u1x = (prev.x - v.x) / len1;
    const u1y = (prev.y - v.y) / len1;
    const u2x = (next.x - v.x) / len2;
    const u2y = (next.y - v.y) / len2;

    const t1 = { x: v.x + u1x * t, y: v.y + u1y * t };
    const t2 = { x: v.x + u2x * t, y: v.y + u2y * t };

    if (i === 0) {
      shape.moveTo(t1.x, t1.y);
    } else {
      shape.lineTo(t1.x, t1.y);
    }
    shape.quadraticCurveTo(v.x, v.y, t2.x, t2.y);
  }

  shape.closePath();
  return shape;
}

/**
 * Support outline that fits a paragraph: a vertical stack of adjacent rectangles
 * (each block[i].bottom === block[i+1].top), unioned into one outline with
 * convex corners rounded. With one block this is just a rounded rectangle.
 */
export function generateParagraphSupportShape(blocks: SupportRect[], radius: number): THREE.Shape {
  const ring: Pt[] = [];

  // Top edge of the first (topmost) block.
  ring.push({ x: blocks[0].left, y: blocks[0].top });
  ring.push({ x: blocks[0].right, y: blocks[0].top });

  // Right side, top to bottom (stepping between blocks).
  for (let i = 0; i < blocks.length; i++) {
    ring.push({ x: blocks[i].right, y: blocks[i].bottom });
    if (i + 1 < blocks.length) {
      ring.push({ x: blocks[i + 1].right, y: blocks[i + 1].top });
    }
  }

  // Bottom edge of the last block.
  ring.push({ x: blocks[blocks.length - 1].left, y: blocks[blocks.length - 1].bottom });

  // Left side, bottom to top.
  for (let i = blocks.length - 1; i >= 0; i--) {
    ring.push({ x: blocks[i].left, y: blocks[i].top });
    if (i - 1 >= 0) {
      ring.push({ x: blocks[i - 1].left, y: blocks[i - 1].bottom });
    }
  }

  return roundedPolygonShape(ring, radius);
}

export function generateSupportShape(
  width: number,
  height: number,
  radius: number,
  handleSettings: Handle | undefined,
): THREE.Shape {
  // Limit min/max radius
  const maxRadius = Math.min(width / 2, height / 2);
  if (radius > maxRadius) {
    radius = maxRadius;
  } else if (radius < 0) {
    radius = 0;
  }

  // Compute some handle settings
  const maxHandleSize =
    handleSettings?.position === 'bottom' || handleSettings?.position === 'top'
      ? width - 2 * radius
      : height - 2 * radius;
  const hasHandle = handleSettings?.type === 'handle';
  const handleSize = Math.min(handleSettings?.size ?? 0, maxHandleSize);
  const handleMaxOffset =
    handleSettings?.position === 'bottom' || handleSettings?.position === 'top'
      ? (width - 2 * radius - handleSize) / 2
      : (height - 2 * radius - handleSize) / 2;
  const handleOffset =
    handleSettings?.offsetX && handleSettings?.offsetX > 0
      ? Math.min(handleSettings?.offsetX ?? 0, handleMaxOffset)
      : Math.max(handleSettings?.offsetX ?? 0, -handleMaxOffset);

  let handleWidth = handleSettings?.size2 ?? 0;
  if (handleWidth < 1) {
    handleWidth = 1;
  } else if (handleWidth > handleSize / 2 - 1) {
    handleWidth = handleSize / 2 - 1;
  }

  let hole: THREE.Path | undefined;

  const supportShape = new THREE.Shape();
  supportShape.moveTo(radius, 0);
  if (hasHandle && handleSettings?.position === 'bottom') {
    const handleStartX =
      width - radius - handleSize - handleOffset - (maxHandleSize - handleSize) / 2;
    supportShape.lineTo(handleStartX, 0);
    supportShape.ellipse(
      handleSize / 2,
      0,
      handleSize / 2,
      handleSize / 2,
      Math.PI * 2,
      Math.PI,
      false,
      Math.PI,
    );

    const holeRadius = (handleSize - handleWidth * 2) / 2;
    hole = new THREE.Path();
    hole.moveTo(handleStartX + handleWidth, 0);
    hole.lineTo(handleStartX + handleSize - handleWidth, 0);
    hole.ellipse(-holeRadius, 0, holeRadius, holeRadius, Math.PI * 2, Math.PI, false, Math.PI);
    hole.closePath();
  }

  supportShape.lineTo(width - radius, 0);

  if (radius) {
    supportShape.ellipse(0, radius, radius, radius, Math.PI / 2, Math.PI, false, Math.PI);
  }

  if (hasHandle && handleSettings?.position === 'right') {
    const handleStartY = radius + handleOffset + (maxHandleSize - handleSize) / 2;
    supportShape.lineTo(width, handleStartY);
    supportShape.ellipse(
      0,
      handleSize / 2,
      handleSize / 2,
      handleSize / 2,
      Math.PI / 2,
      (3 * Math.PI) / 2,
      false,
      Math.PI,
    );

    const holeRadius = (handleSize - handleWidth * 2) / 2;
    hole = new THREE.Path();
    hole.moveTo(width, handleStartY + handleWidth);
    hole.lineTo(width, handleStartY + handleSize - handleWidth);
    hole.ellipse(
      0,
      -holeRadius,
      holeRadius,
      holeRadius,
      Math.PI / 2,
      (3 * Math.PI) / 2,
      false,
      Math.PI,
    );
    hole.closePath();
  }

  supportShape.lineTo(width, height - radius);

  if (radius) {
    supportShape.ellipse(-radius, 0, radius, radius, Math.PI, Math.PI * 1.5, false, Math.PI);
  }

  if (hasHandle && handleSettings?.position === 'top') {
    const handleStartX = radius + handleSize + handleOffset + (maxHandleSize - handleSize) / 2;
    supportShape.lineTo(handleStartX, height);
    supportShape.ellipse(
      -handleSize / 2,
      0,
      handleSize / 2,
      handleSize / 2,
      Math.PI,
      Math.PI * 2,
      false,
      Math.PI,
    );

    const holeRadius = (handleSize - handleWidth * 2) / 2;
    hole = new THREE.Path();
    hole.moveTo(handleStartX - handleWidth, height);
    hole.lineTo(handleStartX - handleSize + handleWidth, height);
    hole.ellipse(holeRadius, 0, holeRadius, holeRadius, Math.PI, Math.PI * 2, false, Math.PI);
    hole.closePath();
  }

  supportShape.lineTo(radius, height);

  if (radius) {
    supportShape.ellipse(0, -radius, radius, radius, Math.PI * 1.5, 0, false, Math.PI);
  }

  if (hasHandle && handleSettings?.position === 'left') {
    const handleStartY = radius + handleOffset + handleSize + (maxHandleSize - handleSize) / 2;
    supportShape.lineTo(0, handleStartY);
    supportShape.ellipse(
      0,
      -handleSize / 2,
      handleSize / 2,
      handleSize / 2,
      (3 * Math.PI) / 2,
      Math.PI / 2,
      false,
      Math.PI,
    );

    const holeRadius = (handleSize - handleWidth * 2) / 2;
    hole = new THREE.Path();
    hole.moveTo(0, handleStartY - handleWidth);
    hole.lineTo(0, handleStartY - handleSize + handleWidth);
    hole.ellipse(
      0,
      holeRadius,
      holeRadius,
      holeRadius,
      (3 * Math.PI) / 2,
      Math.PI / 2,
      false,
      Math.PI,
    );
    hole.closePath();
  }

  supportShape.lineTo(0, radius);

  if (radius) {
    supportShape.ellipse(radius, 0, radius, radius, 0, Math.PI / 2, false, Math.PI);
  }

  // Generate hole if needed
  if (handleSettings?.type && handleSettings.type === 'hole') {
    hole = generateHoleShape(width, height, handleSettings);
  }

  if (hole) {
    supportShape.holes.push(hole);
  }

  return supportShape;
}

export function generateHoleShape(
  width: number,
  height: number,
  handleSettings: Handle,
): THREE.Path {
  const hole = new THREE.Path();

  const { offsetX, offsetY, position } = handleSettings;
  let { size: holeSize } = handleSettings;
  holeSize = Math.max(1, holeSize);

  let holeX = 0;
  let holeY = 0;

  switch (position) {
    case 'top':
      holeX = width / 2;
      holeY = height - holeSize / 2 - 1;
      break;
    case 'bottom':
      holeX = width / 2;
      holeY = holeSize / 2 - 1;
      break;
    case 'left':
      holeX = holeSize / 2 + 1;
      holeY = height / 2;
      break;
    case 'right':
      holeX = width - holeSize / 2 - 1;
      holeY = height / 2;
      break;
  }

  holeX += offsetX;
  holeY += offsetY;

  const maxY = height - holeSize / 2 - 1;
  const minY = holeSize / 2 + 1;

  const maxX = width - holeSize / 2 - 1;
  const minX = holeSize / 2 + 1;

  hole.moveTo(Math.max(Math.min(holeX, maxX), minX), Math.max(Math.min(holeY, maxY), minY));
  hole.ellipse(0, 0, holeSize / 2, holeSize / 2, Math.PI, 3 * Math.PI, false, Math.PI);
  hole.closePath();

  return hole;
}
