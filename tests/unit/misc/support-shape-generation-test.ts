import { module, test } from 'qunit';
import { setupTest } from 'ember-qunit';
import {
  generateParagraphSupportShape,
  roundedPolygonShape,
} from 'text2stl/misc/support-shape-generation';
import type * as THREE from 'three';

function points(shape: THREE.Shape) {
  return shape.getPoints(8);
}

function bbox(shape: THREE.Shape) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points(shape)) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function area(shape: THREE.Shape) {
  const pts = points(shape);
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

module('Unit | Misc | support-shape-generation', function (hooks) {
  setupTest(hooks);

  test('a single block is a rectangle spanning its extent', function (assert) {
    const shape = generateParagraphSupportShape(
      [{ left: 10, right: 110, bottom: 0, top: 50 }],
      0,
    );
    const b = bbox(shape);
    assert.strictEqual(Math.round(b.minX), 10, 'left');
    assert.strictEqual(Math.round(b.maxX), 110, 'right');
    assert.strictEqual(Math.round(b.minY), 0, 'bottom');
    assert.strictEqual(Math.round(b.maxY), 50, 'top');
  });

  test('two blocks crop the corner beside the short last line', function (assert) {
    // Wide top block + narrower (left-aligned) bottom block.
    const shape = generateParagraphSupportShape(
      [
        { left: 0, right: 100, bottom: 25, top: 60 },
        { left: 0, right: 40, bottom: 0, top: 25 },
      ],
      0,
    );

    const b = bbox(shape);
    assert.strictEqual(Math.round(b.minX), 0, 'union left');
    assert.strictEqual(Math.round(b.maxX), 100, 'union right (from wide block)');
    assert.strictEqual(Math.round(b.minY), 0, 'union bottom');
    assert.strictEqual(Math.round(b.maxY), 60, 'union top');

    // The bottom-right corner is cropped, so the area is less than the full
    // bounding rectangle (100 x 60 = 6000) by roughly the missing corner
    // (60 wide x 25 tall = 1500).
    const a = area(shape);
    assert.true(a < 5200, `area ${a} is well below the full rectangle`);
    assert.true(a > 4000, `area ${a} is close to the cropped union`);
  });

  test('rounding keeps the bounding box but softens convex corners', function (assert) {
    const square = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const sharp = roundedPolygonShape(square, 0);
    const rounded = roundedPolygonShape(square, 20);

    const sb = bbox(sharp);
    const rb = bbox(rounded);
    // Bounding box is unchanged by rounding.
    assert.strictEqual(Math.round(rb.minX), Math.round(sb.minX), 'left preserved');
    assert.strictEqual(Math.round(rb.maxX), Math.round(sb.maxX), 'right preserved');

    // Rounding removes the exact corner point (0,0) and shrinks the area.
    const hasExactCorner = points(rounded).some((p) => Math.abs(p.x) < 0.5 && Math.abs(p.y) < 0.5);
    assert.false(hasExactCorner, 'the sharp corner point is gone');
    assert.true(area(rounded) < area(sharp), 'rounded area is smaller');
  });
});
