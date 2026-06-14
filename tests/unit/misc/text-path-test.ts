import { module, test } from 'qunit';
import { setupTest } from 'ember-qunit';
import { buildLineProfile, isLinePathEmpty, segmentBoundaries } from 'text2stl/misc/text-path';
import type { PathSegment } from 'text2stl/misc/text-path';

module('Unit | Misc | text-path', function (hooks) {
  setupTest(hooks);

  test('an empty segment list produces a flat profile', function (assert) {
    const profile = buildLineProfile([]);

    for (const s of [0, 10, 50, 200]) {
      const { y, angle } = profile.sample(s);
      assert.strictEqual(y, 0, `y is flat at s=${s}`);
      assert.strictEqual(angle, 0, `angle is flat at s=${s}`);
    }
    assert.false(profile.clamped, 'nothing is clamped');
  });

  test('a single arc rises and is smooth (no jump in slope)', function (assert) {
    // Upward arc (positive radius) over 40mm.
    const profile = buildLineProfile([{ type: 'arc', width: 40, radius: 100 }]);

    assert.true(profile.sample(20).y > 0, 'the baseline rises within the arc');
    assert.true(profile.sample(20).angle > 0, 'the slope tilts upward within the arc');

    // Sample densely and confirm the slope never jumps abruptly (C1 continuity).
    let prev = profile.sample(0).angle;
    for (let s = 1; s <= 40; s += 1) {
      const angle = profile.sample(s).angle;
      assert.true(Math.abs(angle - prev) < 0.1, `slope is continuous near s=${s}`);
      prev = angle;
    }
  });

  test('consecutive segments join smoothly (tangent-continuous)', function (assert) {
    // "Large up curve continues into a small down curve".
    const segments: PathSegment[] = [
      { type: 'arc', width: 40, radius: 120 },
      { type: 'arc', width: 20, radius: -60 },
    ];
    const profile = buildLineProfile(segments);

    // The slope on either side of the 40mm join should match closely.
    const before = profile.sample(39.5).angle;
    const after = profile.sample(40.5).angle;
    assert.true(Math.abs(after - before) < 0.05, 'no kink at the segment boundary');
  });

  test('letters past the last segment continue straight at the ending direction', function (assert) {
    const profile = buildLineProfile([{ type: 'arc', width: 30, radius: 100 }]);

    // All samples below are past the (~30mm) end, so they are extrapolated.
    const a = profile.sample(40);
    const b = profile.sample(60);
    const c = profile.sample(80);

    // The slope is constant across the tail...
    assert.true(Math.abs(a.angle - b.angle) < 1e-9, 'tail slope is constant');
    assert.true(Math.abs(b.angle - c.angle) < 1e-9, 'tail slope is constant further out');
    assert.true(a.angle > 0, 'tail keeps the upward ending slope');
    // ...and the rise per unit length is constant (a straight line).
    const slope1 = (b.y - a.y) / (60 - 40);
    const slope2 = (c.y - b.y) / (80 - 60);
    assert.true(Math.abs(slope1 - slope2) < 1e-6, 'tail is straight');
  });

  test('a very small radius for a wide arc is clamped', function (assert) {
    // 100mm span with a 5mm radius cannot be drawn as a height profile.
    const profile = buildLineProfile([{ type: 'arc', width: 100, radius: 5 }]);
    assert.true(profile.clamped, 'the arc is clamped to stay single-valued');
  });

  test('a wave oscillates above and below the baseline', function (assert) {
    const profile = buildLineProfile([
      { type: 'wave', amplitude: 10, wavelength: 40, cycles: 2 },
    ]);

    let min = Infinity;
    let max = -Infinity;
    for (let s = 0; s <= 80; s += 1) {
      const { y } = profile.sample(s);
      min = Math.min(min, y);
      max = Math.max(max, y);
    }

    assert.true(max > 1, 'rises above the baseline');
    assert.true(min < -1, 'dips below the baseline');
  });

  test('segmentBoundaries returns the cumulative horizontal span of each segment', function (assert) {
    const segments: PathSegment[] = [
      { type: 'arc', width: 30, radius: 100 },
      { type: 'wave', amplitude: 5, wavelength: 20, cycles: 2 }, // span = 40
      { type: 'arc', width: 10, radius: -50 },
    ];

    assert.deepEqual(segmentBoundaries(segments), [30, 70, 80], 'cumulative ends are correct');
    assert.deepEqual(segmentBoundaries([]), [], 'no segments -> no boundaries');
  });

  test('isLinePathEmpty', function (assert) {
    assert.true(isLinePathEmpty(undefined), 'undefined is empty');
    assert.true(isLinePathEmpty({ orientation: 'tangent', segments: [] }), 'no segments is empty');
    assert.false(
      isLinePathEmpty({ orientation: 'tangent', segments: [{ type: 'arc', width: 10, radius: 50 }] }),
      'with a segment is not empty',
    );
  });
});
