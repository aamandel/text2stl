import Component from '@glimmer/component';
import { action } from '@ember/object';
import { ModelType } from 'text2stl/services/text-maker';

import type TextMakerSettings from 'text2stl/models/text-maker-settings';
import type { CalciteInputNumber } from '@esri/calcite-components/dist/components/calcite-input-number';
import type { CalciteRadioButtonGroup } from '@esri/calcite-components/dist/components/calcite-radio-button-group';
import type { CalciteInputText } from '@esri/calcite-components/dist/components/calcite-input-text';
import type { CalciteSegmentedControl } from '@esri/calcite-components/dist/components/calcite-segmented-control';

import type { TextMakerAlignment, TextMakerVerticalAlignment } from 'text2stl/services/text-maker';
import type {
  LinePath,
  PathSegment,
  ArcPathSegment,
  WavePathSegment,
  GlyphPathOrientation,
} from 'text2stl/services/text-maker';

type SegmentType = PathSegment['type'];

// Sensible starting values (mm) for a freshly added segment, tuned for the
// default text size.
const DEFAULT_ARC_SEGMENT: ArcPathSegment = { type: 'arc', width: 30, radius: 80 };
const DEFAULT_WAVE_SEGMENT: WavePathSegment = {
  type: 'wave',
  amplitude: 6,
  wavelength: 50,
  cycles: 1,
};

function defaultSegment(type: SegmentType): PathSegment {
  return type === 'wave' ? { ...DEFAULT_WAVE_SEGMENT } : { ...DEFAULT_ARC_SEGMENT };
}

interface TextFormTextSettingsArgs {
  model: TextMakerSettings;
}

export default class TextFormTextSettings extends Component<TextFormTextSettingsArgs> {
  get enableMultiline() {
    return this.args.model.type !== ModelType.VerticalTextWithSupport;
  }

  get textIsMultiLine() {
    return this.lineCount > 1;
  }

  get lineCount() {
    return this.args.model.text.split('\n').length;
  }

  // One entry per gap between two consecutive lines (N lines => N - 1 gaps).
  // `value` falls back to the global vSpacing for any gap not explicitly set,
  // keeping the list in sync when lines are added or removed.
  get lineGaps() {
    const gapCount = Math.max(0, this.lineCount - 1);
    const { lineSpacings, vSpacing } = this.args.model;
    const fallback = vSpacing ?? 0;

    return Array.from({ length: gapCount }, (_, index) => ({
      index,
      from: index + 1,
      to: index + 2,
      value: lineSpacings[index] ?? fallback,
    }));
  }

  alignmentOptions: TextMakerAlignment[] = ['left', 'center', 'right'];
  vAlignmentOptions: TextMakerVerticalAlignment[] = ['default', 'top', 'bottom'];
  orientationOptions: GlyphPathOrientation[] = ['tangent', 'upright'];
  segmentTypes: SegmentType[] = ['arc', 'wave'];

  // Custom paths apply to flat layouts only, not the rotated vertical-text type.
  get pathSupported() {
    return this.args.model.type !== ModelType.VerticalTextWithSupport;
  }

  // One path entry per line, normalized to the current line count so the UI
  // stays in sync as lines are added or removed. Each segment is annotated with
  // its index and (for arcs) whether its radius is too small for its width and
  // will be clamped.
  get linePathRows() {
    return this.normalizedLinePaths().map((linePath, index) => ({
      index,
      label: index + 1,
      orientation: linePath.orientation,
      segmentCount: linePath.segments.length,
      segments: linePath.segments.map((segment, segmentIndex) => ({
        ...segment,
        index: segmentIndex,
        clamped:
          segment.type === 'arc' &&
          segment.radius !== 0 &&
          Math.abs(segment.radius) < segment.width,
      })),
    }));
  }

  // Build a line-count-length array of line paths, filling gaps with straight
  // (segment-less) defaults. Cloned so callers can mutate then reassign.
  private normalizedLinePaths(): LinePath[] {
    const { linePaths } = this.args.model;

    return Array.from({ length: this.lineCount }, (_, index) => {
      const linePath = linePaths[index];
      return {
        orientation: linePath?.orientation ?? 'tangent',
        segments: (linePath?.segments ?? []).map((segment) => ({ ...segment })),
      };
    });
  }

  @action
  setNumber(props: 'size' | 'height' | 'spacing' | 'vSpacing', e: CustomEvent) {
    const v = parseFloat((e.target as CalciteInputNumber).value);
    this.args.model[props] = isNaN(v) ? undefined : v;
  }

  @action
  setAlignment(e: CustomEvent) {
    const v = (e.target as CalciteRadioButtonGroup).selectedItem.value as TextMakerAlignment;
    this.args.model.alignment = v;
  }

  @action
  setVAlignment(e: CustomEvent) {
    const v = (e.target as CalciteRadioButtonGroup).selectedItem
      .value as TextMakerVerticalAlignment;
    this.args.model.vAlignment = v;
  }

  @action
  changeText(e: CustomEvent) {
    this.args.model.text = (e.target as CalciteInputText).value;
  }

  @action
  toggleCustomLineSpacing() {
    const enabled = !this.args.model.customLineSpacing;
    this.args.model.customLineSpacing = enabled;

    // Seed every gap with the current global value the first time it's enabled,
    // so the per-line inputs start from a sensible baseline.
    if (enabled) {
      this.args.model.lineSpacings = this.lineGaps.map((gap) => gap.value);
    }
  }

  @action
  setLineGap(index: number, e: CustomEvent) {
    const v = parseFloat((e.target as CalciteInputNumber).value);
    const fallback = this.args.model.vSpacing ?? 0;

    // Rebuild a fully-populated array of the right length so a reassignment
    // (not a mutation) triggers tracking and the preview re-renders.
    const lineSpacings = this.lineGaps.map((gap) => gap.value);
    lineSpacings[index] = isNaN(v) ? fallback : v;
    this.args.model.lineSpacings = lineSpacings;
  }

  @action
  toggleCustomTextPath() {
    const enabled = !this.args.model.customTextPath;
    this.args.model.customTextPath = enabled;

    // Materialize a concrete per-line entry the first time it's enabled.
    if (enabled) {
      this.args.model.linePaths = this.normalizedLinePaths();
    }
  }

  @action
  toggleShowPathPreview() {
    this.args.model.showPathPreview = !this.args.model.showPathPreview;
  }

  // Apply a mutation to one line's path and reassign the array (reassignment,
  // not mutation, is what triggers tracking and re-renders the preview).
  private updateLinePath(lineIndex: number, mutate: (linePath: LinePath) => void) {
    const linePaths = this.normalizedLinePaths();
    const linePath = linePaths[lineIndex];
    if (linePath) {
      mutate(linePath);
    }
    this.args.model.linePaths = linePaths;
  }

  @action
  setLineOrientation(lineIndex: number, e: CustomEvent) {
    const orientation = (e.target as CalciteSegmentedControl).value as GlyphPathOrientation;
    this.updateLinePath(lineIndex, (linePath) => {
      linePath.orientation = orientation;
    });
  }

  @action
  addSegment(lineIndex: number) {
    this.updateLinePath(lineIndex, (linePath) => {
      linePath.segments = [...linePath.segments, defaultSegment('arc')];
    });
  }

  @action
  removeSegment(lineIndex: number, segmentIndex: number) {
    this.updateLinePath(lineIndex, (linePath) => {
      linePath.segments = linePath.segments.filter((_, i) => i !== segmentIndex);
    });
  }

  @action
  setSegmentType(lineIndex: number, segmentIndex: number, e: CustomEvent) {
    const type = (e.target as CalciteSegmentedControl).value as SegmentType;
    this.updateLinePath(lineIndex, (linePath) => {
      const current = linePath.segments[segmentIndex];
      if (current && current.type !== type) {
        // Switching type resets to that type's defaults (the params differ).
        linePath.segments = linePath.segments.map((segment, i) =>
          i === segmentIndex ? defaultSegment(type) : segment,
        );
      }
    });
  }

  @action
  setSegmentNumber(
    lineIndex: number,
    segmentIndex: number,
    prop: 'width' | 'radius' | 'amplitude' | 'wavelength' | 'cycles',
    e: CustomEvent,
  ) {
    const value = parseFloat((e.target as CalciteInputNumber).value);
    this.updateLinePath(lineIndex, (linePath) => {
      const segment = linePath.segments[segmentIndex];
      if (segment && prop in segment) {
        (segment as unknown as Record<string, number>)[prop] = isNaN(value) ? 0 : value;
      }
    });
  }
}
