import * as THREE from 'three';
import { SVGLoader } from 'text2stl/misc/threejs/SVGLoader';

export type Pt = { x: number; y: number };
export type SvgShapeData = { contour: Pt[]; holes: Pt[][] };
export type ParsedSvg = { shapes: SvgShapeData[]; width: number; height: number };

// Curve flattening resolution. SVG curves are flattened to polylines so the
// shapes can be freely scaled/positioned and used for boolean-style carving.
const CURVE_SEGMENTS = 24;

/**
 * Parse an SVG document into flattened polygon shapes, in model space:
 * Y is flipped (SVG is y-down) and the whole drawing is normalized so its
 * bounding box starts at the origin. Returns the shapes plus the original
 * (unscaled) width/height for fitting.
 */
export function parseSvgShapes(svgText: string): ParsedSvg {
  // SVGLoader is vendored untyped JS; cast its results to the THREE types.
  const loader = new SVGLoader();
  const data = loader.parse(svgText) as { paths: unknown[] };

  const raw: SvgShapeData[] = [];
  for (const path of data.paths) {
    const shapes = SVGLoader.createShapes(path) as THREE.Shape[];
    for (const shape of shapes) {
      raw.push({
        contour: shape.getPoints(CURVE_SEGMENTS).map((p) => ({ x: p.x, y: p.y })),
        holes: (shape.holes ?? []).map((hole) =>
          hole.getPoints(CURVE_SEGMENTS).map((p) => ({ x: p.x, y: p.y })),
        ),
      });
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of raw) {
    for (const p of shape.contour) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }

  if (!isFinite(minX)) {
    return { shapes: [], width: 0, height: 0 };
  }

  // Flip Y (SVG y-down -> model y-up) and shift the bounding box to the origin.
  const flip = (p: Pt): Pt => ({ x: p.x - minX, y: maxY - p.y });
  const shapes = raw.map((shape) => ({
    contour: shape.contour.map(flip),
    holes: shape.holes.map((hole) => hole.map(flip)),
  }));

  return { shapes, width: maxX - minX, height: maxY - minY };
}

/** Convert parsed SVG shapes to THREE.Shapes, scaled uniformly and translated. */
export function svgShapesToThree(
  parsed: ParsedSvg,
  scale: number,
  dx: number,
  dy: number,
): THREE.Shape[] {
  return parsed.shapes.map((data) => {
    const shape = new THREE.Shape();
    data.contour.forEach((p, i) => {
      const x = p.x * scale + dx;
      const y = p.y * scale + dy;
      if (i === 0) {
        shape.moveTo(x, y);
      } else {
        shape.lineTo(x, y);
      }
    });
    shape.closePath();

    shape.holes = data.holes.map((hole) => {
      const path = new THREE.Path();
      hole.forEach((p, i) => {
        const x = p.x * scale + dx;
        const y = p.y * scale + dy;
        if (i === 0) {
          path.moveTo(x, y);
        } else {
          path.lineTo(x, y);
        }
      });
      path.closePath();
      return path;
    });

    return shape;
  });
}

/**
 * Uniform scale (preserving aspect) that makes the text bounding box fit inside
 * the SVG bounding box plus margin. Returns 1 when the SVG has no size.
 */
export function svgAutoFitScale(
  parsed: ParsedSvg,
  textWidth: number,
  textHeight: number,
  marginX: number,
  marginY: number,
): number {
  if (parsed.width <= 0 || parsed.height <= 0) {
    return 1;
  }
  const scaleX = (textWidth + 2 * marginX) / parsed.width;
  const scaleY = (textHeight + 2 * marginY) / parsed.height;
  return Math.max(scaleX, scaleY);
}
