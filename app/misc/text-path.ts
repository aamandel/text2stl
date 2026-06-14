/**
 * Custom text path ("curved text").
 *
 * A line of text can follow a vertical *height profile* built from an ordered
 * list of curve segments. Glyphs keep their normal horizontal advances (so font
 * kerning / spacing is preserved); the profile only changes each glyph's
 * vertical offset and, optionally, its rotation.
 *
 * Every segment is integrated as a constant-curvature (circular-arc) piece that
 * carries the running slope forward, so consecutive segments always join
 * smoothly (tangent-continuous). A "wave" is realized as a smooth oscillation of
 * that slope. Past the last segment the profile continues straight in the
 * ending direction.
 */

export type GlyphPathOrientation = 'tangent' | 'upright';

export interface ArcPathSegment {
  type: 'arc';
  // Horizontal span of the segment (mm).
  width: number;
  // Signed circle radius (mm): positive curves up, negative curves down,
  // 0 keeps the segment straight.
  radius: number;
}

export interface WavePathSegment {
  type: 'wave';
  // Peak vertical deviation (mm).
  amplitude: number;
  // Length of one full wave (mm).
  wavelength: number;
  // Number of full waves (may be fractional).
  cycles: number;
}

export type PathSegment = ArcPathSegment | WavePathSegment;

export interface LinePath {
  orientation: GlyphPathOrientation;
  segments: PathSegment[];
}

interface ProfilePoint {
  x: number;
  y: number;
  angle: number;
}

export interface LineProfile {
  // Vertical offset & slope angle (radians) at horizontal position `s` (mm from
  // the start of the line). Positions past the end extrapolate straight.
  sample(s: number): { y: number; angle: number };
  // True when any segment had to be clamped to stay single-valued.
  clamped: boolean;
}

// Steepest slope we allow so the height profile stays a single-valued function
// of x (and the integration keeps advancing horizontally). ~80°.
const MAX_SLOPE = (80 * Math.PI) / 180;

// Arc-length integration step (mm). Small enough for smooth curves while
// keeping the sample count bounded.
const STEP = 0.5;

// Safety cap on integration steps per line to avoid pathological loops.
const MAX_STEPS = 200000;

/**
 * Build a sampleable vertical profile for a single line from its segments.
 * Returns a flat profile (no offset) when there are no segments.
 */
export function buildLineProfile(segments: PathSegment[], step: number = STEP): LineProfile {
  const points: ProfilePoint[] = [{ x: 0, y: 0, angle: 0 }];
  let x = 0;
  let y = 0;
  let theta = 0;
  let clamped = false;
  let steps = 0;

  // Advance one arc-length step, setting the slope to `nextTheta` (clamped).
  const advance = (nextTheta: number) => {
    theta = nextTheta;
    if (theta > MAX_SLOPE) {
      theta = MAX_SLOPE;
      clamped = true;
    } else if (theta < -MAX_SLOPE) {
      theta = -MAX_SLOPE;
      clamped = true;
    }
    x += Math.cos(theta) * step;
    y += Math.sin(theta) * step;
    points.push({ x, y, angle: theta });
    steps++;
  };

  for (const segment of segments) {
    if (segment.type === 'arc') {
      const width = segment.width;
      if (!(width > 0)) {
        continue;
      }
      const targetX = x + width;
      const curvature = segment.radius !== 0 ? 1 / segment.radius : 0;

      while (x < targetX - 1e-9 && steps < MAX_STEPS) {
        advance(theta + curvature * step);
      }
    } else {
      const wavelength = segment.wavelength > 0 ? segment.wavelength : 0;
      const span = Math.max(0, segment.cycles) * wavelength;
      if (span <= 0) {
        continue;
      }
      // A true sinusoid riding on the incoming slope, so the baseline rises and
      // dips around it (a real wave). Position stays continuous at the join;
      // the wave enters/leaves at its natural slope.
      const startX = x;
      const startY = y;
      const baseSlope = Math.tan(theta);
      const amplitude = segment.amplitude;
      const omega = (2 * Math.PI) / wavelength;
      let dx = 0;

      while (dx < span - 1e-9 && steps < MAX_STEPS) {
        dx = Math.min(span, dx + step);
        x = startX + dx;
        y = startY + baseSlope * dx + amplitude * Math.sin(omega * dx);

        let angle = Math.atan(baseSlope + amplitude * omega * Math.cos(omega * dx));
        if (angle > MAX_SLOPE) {
          angle = MAX_SLOPE;
          clamped = true;
        } else if (angle < -MAX_SLOPE) {
          angle = -MAX_SLOPE;
          clamped = true;
        }
        theta = angle;

        points.push({ x, y, angle: theta });
        steps++;
      }
    }
  }

  return {
    clamped,
    sample(s: number) {
      const last = points[points.length - 1]!;

      if (s <= 0) {
        // Before the line start: extrapolate straight backwards along the first
        // sample's (flat) direction.
        const first = points[0]!;
        return { y: first.y + s * Math.tan(first.angle), angle: first.angle };
      }

      if (s >= last.x) {
        // Past the last segment: continue straight at the ending direction.
        return { y: last.y + (s - last.x) * Math.tan(last.angle), angle: last.angle };
      }

      // Binary search for the bracketing samples (points are sorted by x).
      let lo = 0;
      let hi = points.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (points[mid]!.x <= s) {
          lo = mid;
        } else {
          hi = mid;
        }
      }

      const a = points[lo]!;
      const b = points[hi]!;
      const span = b.x - a.x;
      const f = span > 1e-9 ? (s - a.x) / span : 0;

      return {
        y: a.y + (b.y - a.y) * f,
        angle: a.angle + (b.angle - a.angle) * f,
      };
    },
  };
}

/** A line path with no drawable segments renders as a straight line. */
export function isLinePathEmpty(path: LinePath | undefined): boolean {
  return !path || !path.segments || path.segments.length === 0;
}

/** Horizontal span (mm) a single segment covers along the line. */
export function segmentSpan(segment: PathSegment): number {
  if (segment.type === 'arc') {
    return segment.width > 0 ? segment.width : 0;
  }
  return segment.wavelength > 0 ? Math.max(0, segment.cycles) * segment.wavelength : 0;
}

/**
 * Cumulative horizontal end positions (mm) of each segment, i.e. where one
 * segment hands off to the next. Used to mark segment boundaries on the curve.
 */
export function segmentBoundaries(segments: PathSegment[]): number[] {
  const boundaries: number[] = [];
  let x = 0;
  for (const segment of segments) {
    x += segmentSpan(segment);
    boundaries.push(x);
  }
  return boundaries;
}
