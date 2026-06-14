import { module, test } from 'qunit';
import { setupTest } from 'ember-qunit';
import { parseSvgShapes, svgShapesToThree, svgAutoFitScale } from 'text2stl/misc/svg-shape';

const RECT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 H10 V20 H0 Z" /></svg>';

module('Unit | Misc | svg-shape', function (hooks) {
  setupTest(hooks);

  test('parseSvgShapes returns a normalized, Y-flipped shape', function (assert) {
    const parsed = parseSvgShapes(RECT_SVG);

    assert.strictEqual(parsed.shapes.length, 1, 'one shape parsed');
    assert.strictEqual(Math.round(parsed.width), 10, 'width matches the SVG');
    assert.strictEqual(Math.round(parsed.height), 20, 'height matches the SVG');

    // Normalized so the bounding box starts at the origin.
    let minX = Infinity;
    let minY = Infinity;
    for (const p of parsed.shapes[0].contour) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    }
    assert.strictEqual(Math.round(minX), 0, 'min x normalized to 0');
    assert.strictEqual(Math.round(minY), 0, 'min y normalized to 0');
  });

  test('svgAutoFitScale fits the text bbox inside the SVG bbox plus margin', function (assert) {
    const parsed = parseSvgShapes(RECT_SVG); // 10 x 20
    // text 30 x 40, margins 5 -> scaleX=(30+10)/10=4, scaleY=(40+10)/20=2.5 -> 4
    assert.strictEqual(svgAutoFitScale(parsed, 30, 40, 5, 5), 4, 'takes the larger ratio');
  });

  test('svgShapesToThree scales and translates the shapes', function (assert) {
    const parsed = parseSvgShapes(RECT_SVG); // 10 x 20
    const [shape] = svgShapesToThree(parsed, 2, 100, 0);

    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of shape.getPoints(2)) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    assert.strictEqual(Math.round(minX), 100, 'translated by dx');
    assert.strictEqual(Math.round(maxX), 120, 'scaled width 10*2 + dx');
    assert.strictEqual(Math.round(maxY), 40, 'scaled height 20*2');
  });
});
