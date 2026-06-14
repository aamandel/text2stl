import Service from '@ember/service';
import * as THREE from 'three';
import { mergeBufferGeometries } from 'text2stl/misc/threejs/BufferGeometryUtils';
import config from 'text2stl/config/environment';
import {
  generateSupportShape,
  generateParagraphSupportShape,
} from 'text2stl/misc/support-shape-generation';
import { inject as service } from '@ember/service';
import extractEmoji from 'text2stl/misc/extract-emoji';
import { buildLineProfile, isLinePathEmpty, segmentBoundaries } from 'text2stl/misc/text-path';
import { svgShapesToThree, svgAutoFitScale } from 'text2stl/misc/svg-shape';

import type { SupportRect } from 'text2stl/misc/support-shape-generation';
import type { ParsedSvg } from 'text2stl/misc/svg-shape';

import type { LinePath, LineProfile, GlyphPathOrientation } from 'text2stl/misc/text-path';

import type HarfbuzzService from 'text2stl/services/harfbuzz';
import type FontManagerService from 'text2stl/services/font-manager';
import type { SVGPathSegment, HBFont, BufferContent } from 'harfbuzzjs/hbjs';
import type { FaceAndFont } from 'text2stl/services/font-manager';

const {
  APP: {
    textMakerDefault,
    threePreviewSettings: { meshParameters },
  },
} = config;

export type TextMakerAlignment = 'left' | 'center' | 'right';
export type TextMakerVerticalAlignment = 'default' | 'top' | 'bottom';
export type SupportShapeType = 'rectangle' | 'paragraph' | 'svg';

export type {
  LinePath,
  PathSegment,
  ArcPathSegment,
  WavePathSegment,
  GlyphPathOrientation,
} from 'text2stl/misc/text-path';

export type SupportPadding = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type Handle = {
  type: 'hole' | 'handle' | 'none';
  position: 'left' | 'top' | 'right' | 'bottom';
  size: number;
  size2: number;
  offsetX: number;
  offsetY: number;
};

export interface TextMakerParameters {
  text: string;
  size?: number;
  height?: number;
  spacing?: number;
  vSpacing?: number;
  // When true, the gap between each pair of lines is taken from `lineSpacings`
  // (falling back to `vSpacing` for any gap not explicitly set).
  customLineSpacing?: boolean;
  // Per-gap vertical spacing. Index `i` is the gap between line `i` and line `i + 1`.
  lineSpacings?: number[];
  // When true, each line may follow a custom path defined in `linePaths`.
  customTextPath?: boolean;
  // Per-line path definition (orientation + ordered curve segments), indexed by line.
  linePaths?: LinePath[];
  alignment?: TextMakerAlignment;
  vAlignment?: TextMakerVerticalAlignment;
  type?: ModelType;
  supportHeight?: number;
  supportPadding?: SupportPadding;
  supportBorderRadius?: number;
  handleSettings?: Handle;
  // Support outline: rounded rectangle (default), paragraph-fit, or custom SVG.
  supportShape?: SupportShapeType;
  // Custom-SVG sizing: uniform scale on top of the auto-fit, plus text offset within the shape.
  supportShapeScale?: number;
  supportShapeOffsetX?: number;
  supportShapeOffsetY?: number;
}

export enum ModelType {
  TextOnly = 1,
  TextWithSupport = 2,
  NegativeText = 3,
  VerticalTextWithSupport = 4,
}

type SingleGlyphDef = {
  paths: THREE.Path[];
  holes: THREE.Path[];
};

// Per-line placement info needed to draw the path preview & paragraph support.
type LineLayout = {
  lineIndex: number;
  oy: number; // baseline vertical offset of the line
  alignOffset: number; // horizontal shift applied by text alignment
  width: number; // horizontal extent of the line's text
  // Bounding box of the line's glyphs (x pre-alignment; y includes baseline & path).
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type MultipleGlyphDef = {
  glyphs: SingleGlyphDef[];
  bounds: {
    min: { x: number; y: number };
    max: { x: number; y: number };
  };
  linesLayout: LineLayout[];
};

type LineInfo = {
  // glyphs shape indexed by Glyph ID
  glyphs: Record<number, SVGPathSegment[]>;
  // Line composition ()
  buffer: BufferContent;
};

export default class TextMakerService extends Service {
  @service declare harfbuzz: HarfbuzzService;
  @service declare fontManager: FontManagerService;

  get emojiFont() {
    return this.fontManager.emojiFont;
  }

  private glyphToShapes(
    glyphPath: SVGPathSegment[],
    xOffset: number,
    yOffset: number,
    isCFFFont: boolean = false,
    rotation: number = 0,
  ): SingleGlyphDef {
    let paths: THREE.Path[] = [];
    const holes: THREE.Path[] = [];

    let path = new THREE.Path();

    // Following is only to manage "cff" font & detect hole shape
    const paths2D: Path2D[] = [];
    let path2D = new Path2D();

    // Transform a glyph-local point: rotate around the glyph origin (for text
    // following a path tangent) then translate to its place in the line.
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const tx = (px: number, py: number): [number, number] => [
      px * cos - py * sin + xOffset,
      px * sin + py * cos + yOffset,
    ];

    // https://github.com/opentypejs/opentype.js#path-commands
    for (let i = 0; i < glyphPath.length; i++) {
      const command = glyphPath[i];

      switch (command.type) {
        case 'M': {
          path = new THREE.Path();
          path2D = new Path2D();
          const [x, y] = tx(command.values[0], command.values[1]);
          path.moveTo(x, y);
          path2D.moveTo(x, y);
          break;
        }
        case 'Z':
          path.closePath();
          path2D.closePath();

          // With CCF font Detect path/hole can be done only at the end with all path...
          if (isCFFFont) {
            paths.push(path);
            paths2D.push(path2D);
          } else {
            if (THREE.ShapeUtils.isClockWise(path.getPoints())) {
              paths.push(path);
            } else {
              holes.push(path);
            }
          }

          break;
        case 'L': {
          const [x, y] = tx(command.values[0], command.values[1]);
          path.lineTo(x, y);
          path2D.lineTo(x, y);
          break;
        }
        case 'C': {
          const [x1, y1] = tx(command.values[0], command.values[1]);
          const [x2, y2] = tx(command.values[2], command.values[3]);
          const [x3, y3] = tx(command.values[4], command.values[5]);
          path.bezierCurveTo(x1, y1, x2, y2, x3, y3);
          path2D.bezierCurveTo(x1, y1, x2, y2, x3, y3);
          break;
        }
        case 'Q': {
          const [x1, y1] = tx(command.values[0], command.values[1]);
          const [x2, y2] = tx(command.values[2], command.values[3]);
          path.quadraticCurveTo(x1, y1, x2, y2);
          path2D.quadraticCurveTo(x1, y1, x2, y2);
          break;
        }
      }
    }

    // https://github.com/opentypejs/opentype.js/issues/347
    // if "cff" : subpath B contained by outermost subpath A is a cutout ...
    // if "truetype" : solid shapes are defined clockwise (CW) and holes are defined counterclockwise (CCW)
    if (isCFFFont) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      for (let i = 0; i < paths.length; i++) {
        path = paths[i];

        let isHole = false;
        for (const otherPath of paths2D.filter((_, idx) => idx !== i)) {
          // Iterate on path point & check if they are inside any existing paths
          isHole = path.getPoints().every(function (point) {
            return ctx?.isPointInPath(otherPath, point.x, point.y);
          });

          if (isHole) {
            break;
          }
        }

        if (isHole) {
          holes.push(path);
        }
      }

      paths = paths.filter((p) => holes.indexOf(p) === -1);
    }

    return {
      paths,
      holes,
    };
  }

  private glyphsDefToGeometry(depth: number, glyphsDef: MultipleGlyphDef): THREE.BufferGeometry {
    const geometries: THREE.ExtrudeGeometry[] = [];

    for (const glyphDef of glyphsDef.glyphs) {
      const shapes = glyphDef.paths.map(function (path) {
        const shape = new THREE.Shape();
        shape.add(path);
        shape.holes = glyphDef.holes;
        return shape;
      });

      const geometry = new THREE.ExtrudeGeometry(shapes, {
        depth,
        bevelEnabled: true,
        bevelThickness: 0,
        bevelSize: 0,
        bevelOffset: 0,
        bevelSegments: 0,
      });

      geometries.push(geometry);
    }

    return mergeBufferGeometries(geometries.flat());
  }

  private generateTextLineInfo(text: string, font: HBFont): LineInfo[] {
    const stringParts = extractEmoji(text);
    const lineInfo: LineInfo[] = [];

    for (const part of stringParts) {
      const buffer = this.harfbuzz.hb.createBuffer();
      buffer.addText(part.value);
      buffer.guessSegmentProperties();

      this.harfbuzz.hb.shape(part.type === 'text' ? font : this.emojiFont.font, buffer);
      const result = buffer.json();

      lineInfo.push({
        buffer: result,
        glyphs: result.reduce<Record<number, SVGPathSegment[]>>((acc, e) => {
          if (!acc[e.g]) {
            acc[e.g] = (part.type === 'text' ? font : this.emojiFont.font).glyphToJson(e.g);
          }

          return acc;
        }, {}),
      });
    }

    return lineInfo;
  }

  private getSVGPathSegmentsBoundingBox(path: SVGPathSegment[]) {
    const bound = {
      x1: Number.MAX_SAFE_INTEGER,
      x2: 0,
      y1: Number.MAX_SAFE_INTEGER,
      y2: 0,
    };

    for (const p of path) {
      const xCoords = p.values.filter((_v, idx) => !(idx % 2));
      const yCoords = p.values.filter((_v, idx) => idx % 2);

      for (const x of xCoords) {
        bound.x1 = Math.min(bound.x1, x);
        bound.x2 = Math.max(bound.x2, x);
      }
      for (const y of yCoords) {
        bound.y1 = Math.min(bound.y1, y);
        bound.y2 = Math.max(bound.y2, y);
      }
    }

    return bound;
  }

  private stringToGlyhpsDef(params: TextMakerParameters, font: FaceAndFont): MultipleGlyphDef {
    const text = params.text || textMakerDefault.text;
    const size =
      params.size !== undefined && params.size >= 0 ? params.size : textMakerDefault.size;
    const spacing = params.spacing !== undefined ? params.spacing : textMakerDefault.spacing;
    const vSpacing = params.vSpacing !== undefined ? params.vSpacing : textMakerDefault.vSpacing;
    const customLineSpacing = params.customLineSpacing ?? false;
    const lineSpacings = params.lineSpacings ?? [];
    // Vertical gap to add after line `lineIndex` (i.e. between it and the next line).
    // Falls back to the global vSpacing when per-line spacing is disabled or a gap is unset.
    const gapAfterLine = (lineIndex: number) =>
      customLineSpacing && lineSpacings[lineIndex] !== undefined
        ? lineSpacings[lineIndex]!
        : vSpacing;
    const customTextPath = params.customTextPath ?? false;
    const linePaths = params.linePaths ?? [];
    const alignment =
      params.alignment !== undefined ? params.alignment : textMakerDefault.alignment;
    const vAlignment =
      params.vAlignment !== undefined ? params.vAlignment : textMakerDefault.vAlignment;

    const glyphShapes: SingleGlyphDef[] = [];

    const linesWidth: number[] = []; // to handle horizontal alignment
    const linesBaselineOy: number[] = []; // baseline offset of each line (for path preview)
    const linesMinMaxY: { maxY: number; minY: number }[] = []; // to handle vertical alignment
    const linesGlyphInfos: Array<Array<{ height: number; maxY: number; minY: number }>> = []; // to handle vertical alignment (move each glyph according to line MinMaxY)

    // bounds of all text
    const bounds = {
      min: { x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER },
      max: { x: 0, y: 0 },
    };

    // Per-line bounding boxes (x pre-alignment; y includes baseline & path),
    // used to build the paragraph-fit support shape.
    type LineBox = { minX: number; maxX: number; minY: number; maxY: number };
    const linesBox: LineBox[] = [];
    const expandBox = (box: LineBox, px: number, py: number) => {
      box.minX = Math.min(box.minX, px);
      box.maxX = Math.max(box.maxX, px);
      box.minY = Math.min(box.minY, py);
      box.maxY = Math.max(box.maxY, py);
    };

    // https://harfbuzz.github.io/harfbuzz-hb-font.html (see hb_font_set_scale)
    font.font.setScale(size, size);
    this.emojiFont.font.setScale(size, size);

    const lines = text.split('\n').map((s) => s.trimEnd());
    let oy = 0; // Last x offset where to start drawing glyph

    // Generate info for each line of text
    const linesInfos = lines.map((text) => this.generateTextLineInfo(text, font.font));

    // Build the vertical path profile for each line (null when the line is straight).
    const lineProfiles: (LineProfile | null)[] = linesInfos.map((_, lineIndex) => {
      const linePath = customTextPath ? linePaths[lineIndex] : undefined;
      return linePath && !isLinePathEmpty(linePath) ? buildLineProfile(linePath.segments) : null;
    });
    const lineOrientations: GlyphPathOrientation[] = linesInfos.map(
      (_, lineIndex) => (customTextPath ? linePaths[lineIndex]?.orientation : undefined) ?? 'tangent',
    );

    // Vertical offset & glyph rotation contributed by the line's path at advance `s`.
    const pathAt = (lineIndex: number, s: number) => {
      const profile = lineProfiles[lineIndex];
      if (!profile) {
        return { y: 0, rotation: 0 };
      }
      const { y, angle } = profile.sample(s);
      return { y, rotation: lineOrientations[lineIndex] === 'tangent' ? angle : 0 };
    };

    // Rotate a glyph-local corner around its origin then translate, matching glyphToShapes.
    const transformCorner = (
      px: number,
      py: number,
      originX: number,
      originY: number,
      rotation: number,
    ) => {
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      return { x: px * cos - py * sin + originX, y: px * sin + py * cos + originY };
    };

    // Iterate a first time on all lines to calculate line width (text align)
    for (let lineIndex = 0; lineIndex < linesInfos.length; lineIndex++) {
      const lineParts = linesInfos[lineIndex];
      let ox = 0; // Last x offset where to start drawing glyph
      let lineMaxX = 0;
      const lineMinMaxY = { minY: Number.MAX_SAFE_INTEGER, maxY: -Number.MAX_SAFE_INTEGER };
      const lineGlyphInfos: { height: number; maxY: number; minY: number }[] = [];

      // `oy` here is this line's baseline (it is incremented at the end of the loop).
      linesBaselineOy.push(oy);

      const lineBox: LineBox = {
        minX: Number.MAX_SAFE_INTEGER,
        maxX: -Number.MAX_SAFE_INTEGER,
        minY: Number.MAX_SAFE_INTEGER,
        maxY: -Number.MAX_SAFE_INTEGER,
      };

      // Iterate through single line parts (text or emoji parts)
      for (const lineText of lineParts) {
        // Iterate through line "element" (single char or "complex element", see https://github.com/romgere/text2stl/issues/100)
        lineText.buffer.forEach((info) => {
          const x = ox + info.dx;
          const y = info.dy;

          const emptyGlyph = lineText.glyphs[info.g].length === 0;

          const glyphBounds = this.getSVGPathSegmentsBoundingBox(lineText.glyphs[info.g]);
          const glyphHeight = glyphBounds.y2 - glyphBounds.y1;

          const minY = emptyGlyph ? 0 : Math.min(glyphBounds.y1, glyphBounds.y2);
          const maxY = emptyGlyph ? 0 : Math.max(glyphBounds.y1, glyphBounds.y2);

          lineMinMaxY.maxY = Math.max(lineMinMaxY.maxY, maxY);
          lineMinMaxY.minY = Math.min(lineMinMaxY.minY, minY);

          lineGlyphInfos.push({
            height: glyphHeight,
            maxY,
            minY,
          });

          lineMaxX = x + glyphBounds.x2;

          const { y: pathY, rotation } = pathAt(lineIndex, x);

          if (emptyGlyph) {
            // Empty/whitespace glyphs have no outline: x1/y1 are +∞ here, so they
            // must only reach the min edge, and x2/y2 (= advance) the max edge.
            bounds.min.x = Math.min(bounds.min.x, x + glyphBounds.x1);
            bounds.min.y = Math.min(bounds.min.y, y - oy + pathY + glyphBounds.y1);
            bounds.max.x = Math.max(bounds.max.x, x + glyphBounds.x2);
            bounds.max.y = Math.max(bounds.max.y, y - oy + pathY + glyphBounds.y2);
            // For the per-line box, a space only marks its advance position.
            lineBox.minX = Math.min(lineBox.minX, x + glyphBounds.x2);
            lineBox.maxX = Math.max(lineBox.maxX, x + glyphBounds.x2);
          } else {
            // Account for the path offset & tangent rotation by transforming the
            // glyph's bounding-box corners, so the support plate fits curved text.
            const originY = y - oy + pathY;
            for (const [cx, cy] of [
              [glyphBounds.x1, glyphBounds.y1],
              [glyphBounds.x2, glyphBounds.y1],
              [glyphBounds.x1, glyphBounds.y2],
              [glyphBounds.x2, glyphBounds.y2],
            ]) {
              const p = transformCorner(cx, cy, x, originY, rotation);
              bounds.min.x = Math.min(bounds.min.x, p.x);
              bounds.min.y = Math.min(bounds.min.y, p.y);
              bounds.max.x = Math.max(bounds.max.x, p.x);
              bounds.max.y = Math.max(bounds.max.y, p.y);
              expandBox(lineBox, p.x, p.y);
            }
          }

          ox += spacing + info.ax;
        });
      }

      oy += size + gapAfterLine(lineIndex);

      // Keep this for each line to handle alignment
      linesWidth.push(lineMaxX);
      linesBox.push(lineBox);
      linesMinMaxY.push(lineMinMaxY);
      linesGlyphInfos.push(lineGlyphInfos);
    }

    const linesAlignOffset = linesWidth.map(() => 0);

    // Handle horizontal alignment (now we know all line size)
    if (alignment !== 'left') {
      const maxWidth = Math.max(...linesWidth);

      linesWidth.forEach(function (lineWidth, line) {
        if (lineWidth !== maxWidth) {
          const xOffset = (maxWidth - lineWidth) / (alignment === 'center' ? 2 : 1);
          linesAlignOffset[line] = xOffset;
        }
      });
    }

    oy = 0;
    // Iterate second time on line to actually "render" glyph (aligned according to info from previous iteration)
    // for (const lineIndex in lines) {
    for (const lineIndex in linesInfos) {
      const lineParts = linesInfos[lineIndex];
      let ox = 0; // Last x offset where to start drawing glyph
      let glyphIndex = 0;

      const li = Number(lineIndex);

      // Iterate through single line parts (text or emoji parts)
      for (const lineText of lineParts) {
        // Iterate on text char to generate a Geometry for each
        lineText.buffer.forEach((info) => {
          // Position along the line (before horizontal alignment) drives the path.
          const s = ox + info.dx;
          const x = s + linesAlignOffset[lineIndex];
          let y = info.dy;

          if (vAlignment !== 'default') {
            const lineMaxY = linesMinMaxY[lineIndex];
            const glyphInfo = linesGlyphInfos[lineIndex][glyphIndex];

            if (vAlignment === 'bottom' && lineMaxY.minY !== glyphInfo.minY) {
              y += lineMaxY.minY - glyphInfo.minY;
            } else if (vAlignment === 'top' && lineMaxY.maxY !== glyphInfo.maxY) {
              y += lineMaxY.maxY - glyphInfo.maxY;
            }
          }

          const { y: pathY, rotation } = pathAt(li, s);

          glyphShapes.push(
            this.glyphToShapes(
              lineText.glyphs[info.g],
              x, // x offset
              y - oy + pathY, // y offset
              font.opentype.outlinesFormat === 'cff',
              rotation,
            ),
          );
          ox += spacing + info.ax;
          glyphIndex++;
        });
      }

      oy += size + gapAfterLine(Number(lineIndex));
    }

    return {
      glyphs: glyphShapes,
      bounds,
      linesLayout: linesInfos.map((_, lineIndex) => ({
        lineIndex,
        oy: linesBaselineOy[lineIndex],
        alignOffset: linesAlignOffset[lineIndex],
        width: linesWidth[lineIndex],
        minX: linesBox[lineIndex].minX,
        maxX: linesBox[lineIndex].maxX,
        minY: linesBox[lineIndex].minY,
        maxY: linesBox[lineIndex].maxY,
      })),
    };
  }

  private translatePath(path: THREE.Path, x: number, y: number) {
    return new THREE.Path(
      path.getPoints().map((p) => {
        return new THREE.Vector2(p.x + x, p.y + y);
      }),
    );
  }

  // Two-block paragraph support: a wide box for all lines but the last, plus a
  // right-sized box for the last line, expressed in support coordinates.
  private buildParagraphBlocks(
    plyghsDef: MultipleGlyphDef,
    pad: SupportPadding,
    alignment: TextMakerAlignment,
  ): SupportRect[] {
    const { min, max } = plyghsDef.bounds;
    const mapX = (gx: number) => gx - min.x + pad.left;
    const mapY = (gy: number) => gy - min.y + pad.bottom;

    // Lines that actually contain glyphs, in top-to-bottom order.
    const lines = plyghsDef.linesLayout.filter((l) => l.maxX > l.minX);
    if (lines.length === 0) {
      return [
        {
          left: 0,
          right: max.x - min.x + pad.left + pad.right,
          bottom: 0,
          top: max.y - min.y + pad.top + pad.bottom,
        },
      ];
    }

    // A line's glyph-space rect (x includes its alignment shift).
    const glyphRect = (l: (typeof lines)[number]) => ({
      left: l.minX + l.alignOffset,
      right: l.maxX + l.alignOffset,
      top: l.maxY,
      bottom: l.minY,
    });

    const last = lines[lines.length - 1];
    const rest = lines.slice(0, -1);
    const lastRect = glyphRect(last);

    // Single line -> just a padded rectangle around it.
    if (rest.length === 0) {
      return [
        {
          left: mapX(lastRect.left) - pad.left,
          right: mapX(lastRect.right) + pad.right,
          top: mapY(lastRect.top) + pad.top,
          bottom: mapY(lastRect.bottom) - pad.bottom,
        },
      ];
    }

    // Union rect of all lines except the last.
    let rl = Infinity;
    let rr = -Infinity;
    let rt = -Infinity;
    let rb = Infinity;
    for (const l of rest) {
      const r = glyphRect(l);
      rl = Math.min(rl, r.left);
      rr = Math.max(rr, r.right);
      rt = Math.max(rt, r.top);
      rb = Math.min(rb, r.bottom);
    }

    // Split halfway through the gap between the rest and the last line.
    const split = (rb + lastRect.top) / 2;

    const blockA: SupportRect = {
      left: mapX(rl) - pad.left,
      right: mapX(rr) + pad.right,
      top: mapY(rt) + pad.top,
      bottom: mapY(split),
    };
    const blockB: SupportRect = {
      left: mapX(lastRect.left) - pad.left,
      right: mapX(lastRect.right) + pad.right,
      top: mapY(split),
      bottom: mapY(lastRect.bottom) - pad.bottom,
    };

    // On the aligned side the body and the last-line tab should share one
    // straight edge. Per-line glyph ink bounds vary (left/right side bearings),
    // so the two blocks' edges can differ by a hair and leave a tiny ledge where
    // the tab meets the body. Snap that side to a common coordinate.
    if (alignment === 'left') {
      blockA.left = blockB.left = Math.min(blockA.left, blockB.left);
    } else if (alignment === 'right') {
      blockA.right = blockB.right = Math.max(blockA.right, blockB.right);
    }

    return [blockA, blockB];
  }

  // Build the support outline(s) for the current shape type, plus the offset to
  // translate the text into support coordinates. Returns undefined for text-only.
  private buildSupport(
    params: TextMakerParameters,
    plyghsDef: MultipleGlyphDef,
    customShape?: ParsedSvg,
  ): { shapes: THREE.Shape[]; placement: { x: number; y: number } } | undefined {
    const type = params.type || ModelType.TextOnly;
    if (type === ModelType.TextOnly) {
      return undefined;
    }

    const { min, max } = plyghsDef.bounds;
    const size = { x: max.x - min.x, y: max.y - min.y };
    const pad =
      params.supportPadding !== undefined ? params.supportPadding : textMakerDefault.supportPadding;
    const radius =
      params.supportBorderRadius !== undefined
        ? params.supportBorderRadius
        : textMakerDefault.supportBorderRadius;

    // Custom shapes only apply to flat support types; vertical text keeps the rectangle.
    const shapeType =
      type === ModelType.TextWithSupport || type === ModelType.NegativeText
        ? params.supportShape ?? 'rectangle'
        : 'rectangle';

    if (shapeType === 'svg' && customShape && customShape.shapes.length) {
      const scale =
        svgAutoFitScale(customShape, size.x, size.y, pad.left, pad.bottom) *
        (params.supportShapeScale ?? 1);
      const shapes = svgShapesToThree(customShape, scale, 0, 0);
      const svgW = customShape.width * scale;
      const svgH = customShape.height * scale;
      return {
        shapes,
        placement: {
          x: (svgW - size.x) / 2 - min.x + (params.supportShapeOffsetX ?? 0),
          y: (svgH - size.y) / 2 - min.y + (params.supportShapeOffsetY ?? 0),
        },
      };
    }

    if (shapeType === 'paragraph') {
      const alignment =
        params.alignment !== undefined ? params.alignment : textMakerDefault.alignment;
      return {
        shapes: [
          generateParagraphSupportShape(
            this.buildParagraphBlocks(plyghsDef, pad, alignment),
            radius,
          ),
        ],
        placement: { x: -min.x + pad.left, y: -min.y + pad.bottom },
      };
    }

    // Rounded rectangle (default; also used for vertical text). Only this shape
    // carries handles/holes.
    const supportWidth = size.x + pad.left + pad.right;
    const supportHeight = size.y + pad.top + pad.bottom;
    return {
      shapes: [generateSupportShape(supportWidth, supportHeight, radius, params.handleSettings)],
      placement: { x: -min.x + pad.left, y: -min.y + pad.bottom },
    };
  }

  // Carve each glyph hole into the support shape whose bounding box contains it.
  private assignHolesToShapes(shapes: THREE.Shape[], holePaths: THREE.Path[]) {
    if (shapes.length <= 1) {
      shapes[0]?.holes.push(...holePaths);
      return;
    }

    const boxes = shapes.map((shape) => {
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const p of shape.getPoints()) {
        box.minX = Math.min(box.minX, p.x);
        box.minY = Math.min(box.minY, p.y);
        box.maxX = Math.max(box.maxX, p.x);
        box.maxY = Math.max(box.maxY, p.y);
      }
      return box;
    });

    for (const hole of holePaths) {
      const pts = hole.getPoints();
      let cx = 0;
      let cy = 0;
      for (const p of pts) {
        cx += p.x;
        cy += p.y;
      }
      cx /= pts.length || 1;
      cy /= pts.length || 1;

      let idx = boxes.findIndex((b) => cx >= b.minX && cx <= b.maxX && cy >= b.minY && cy <= b.maxY);
      if (idx < 0) {
        idx = 0;
      }
      shapes[idx].holes.push(hole);
    }
  }

  generateMesh(
    params: TextMakerParameters,
    font: FaceAndFont,
    customShape?: ParsedSvg,
  ): THREE.Mesh {
    const type = params.type || ModelType.TextOnly;

    const textDepth =
      params.height !== undefined && params.height >= 0 ? params.height : textMakerDefault.height;

    const vAlignment =
      params.vAlignment !== undefined ? params.vAlignment : textMakerDefault.vAlignment;

    const plyghsDef = this.stringToGlyhpsDef(params, font);

    let finalGeometry: THREE.BufferGeometry;

    const { min } = plyghsDef.bounds;
    const size = {
      x: plyghsDef.bounds.max.x - min.x,
      y: plyghsDef.bounds.max.y - min.y,
      z: textDepth,
    };

    // Support settings
    let supportDepth = params.supportHeight || textMakerDefault.supportHeight;
    const supportPadding =
      params.supportPadding !== undefined ? params.supportPadding : textMakerDefault.supportPadding;

    // Build the support outline(s) and the text placement for the chosen shape.
    const support = this.buildSupport(params, plyghsDef, customShape);
    const supportShapes = support?.shapes ?? [];
    const placement = support?.placement ?? { x: 0, y: 0 };

    const extrude = (shapes: THREE.Shape[], depth: number) =>
      new THREE.ExtrudeGeometry(shapes, {
        depth,
        bevelEnabled: true,
        bevelThickness: 0,
        bevelSize: 0,
        bevelOffset: 0,
        bevelSegments: 0,
      });

    if (type === ModelType.NegativeText) {
      // Ensure support height is equal or greater than text height
      if (supportDepth < size.z) {
        supportDepth += size.z - supportDepth;
      }

      let supportGeometry: THREE.ExtrudeBufferGeometry | undefined;

      if (supportDepth > textDepth) {
        // Solid base below the carving (extruded before holes are added).
        supportGeometry = extrude(supportShapes, supportDepth - textDepth);
      }

      // extract glyph path & move them into support coordinates
      const glyphsPaths = plyghsDef.glyphs
        .map((g) => g.paths)
        .flat()
        .map((p) => this.translatePath(p, placement.x, placement.y));
      const glyphsHolesPaths = plyghsDef.glyphs
        .map((g) => g.holes)
        .flat()
        .map((p) => this.translatePath(p, placement.x, placement.y));

      // Carve glyphs into the containing support shape(s) & extrude
      this.assignHolesToShapes(supportShapes, glyphsPaths);
      const negativeTextGeometry = extrude(supportShapes, textDepth);

      // Extrude glyph holes (letter counters) as solid geometry
      const glyphsHolesShapes = glyphsHolesPaths.map(function (path) {
        const s = new THREE.Shape();
        s.add(path);
        return s;
      });
      const negativeTextHoleGeometry = extrude(glyphsHolesShapes, textDepth);

      if (supportDepth > textDepth) {
        // Move negative text
        negativeTextGeometry.applyMatrix4(
          new THREE.Matrix4().makeTranslation(0, 0, supportDepth - textDepth),
        );
        negativeTextHoleGeometry.applyMatrix4(
          new THREE.Matrix4().makeTranslation(0, 0, supportDepth - textDepth),
        );
      }

      const geometries = [negativeTextGeometry, negativeTextHoleGeometry];
      if (supportGeometry) {
        geometries.push(supportGeometry);
      }

      finalGeometry = mergeBufferGeometries(geometries);
    } else {
      const textGeometry = this.glyphsDefToGeometry(textDepth, plyghsDef);

      if (type !== ModelType.TextOnly) {
        const supportGeometry = extrude(supportShapes, supportDepth);

        if (type === ModelType.VerticalTextWithSupport) {
          // Ensure bottom of the text is touching the support
          const verticalOffset = vAlignment === 'bottom' ? Math.min(0, plyghsDef.bounds.min.y) : 0;

          // Rotate & move text
          textGeometry.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
          textGeometry.applyMatrix4(
            new THREE.Matrix4().makeTranslation(
              supportPadding.left,
              supportPadding.bottom + size.z * 2,

              supportDepth - verticalOffset,
            ),
          );
        } else {
          // Move text into the support according to the shape's placement.
          textGeometry.applyMatrix4(
            new THREE.Matrix4().makeTranslation(placement.x, placement.y, supportDepth),
          );
        }

        finalGeometry = mergeBufferGeometries([supportGeometry, textGeometry]);
      } else {
        finalGeometry = textGeometry;
      }
    }

    return new THREE.Mesh(
      finalGeometry,
      new THREE.MeshLambertMaterial({
        ...meshParameters,
        side: THREE.DoubleSide,
      }),
    );
  }

  /**
   * Build a (non-exported) visualization of the per-line paths: the centerline
   * each line follows, dots at segment boundaries, and a faint straight
   * reference. Returned in the same coordinate space as the text mesh so the
   * caller can apply the mesh's transform and have them align.
   */
  generatePathPreview(
    params: TextMakerParameters,
    font: FaceAndFont,
    customShape?: ParsedSvg,
  ): THREE.Group | undefined {
    if (!params.customTextPath) {
      return undefined;
    }

    const type = params.type || ModelType.TextOnly;
    if (type === ModelType.VerticalTextWithSupport) {
      return undefined;
    }

    const linePaths = params.linePaths ?? [];
    if (!linePaths.some((linePath) => !isLinePathEmpty(linePath))) {
      return undefined;
    }

    const def = this.stringToGlyhpsDef(params, font);

    const size =
      params.size !== undefined && params.size >= 0 ? params.size : textMakerDefault.size;
    const textDepth =
      params.height !== undefined && params.height >= 0 ? params.height : textMakerDefault.height;
    let supportDepth = params.supportHeight || textMakerDefault.supportHeight;

    // Reuse the exact text placement generateMesh applies, so the preview sits
    // where the letters do for every support shape.
    const support = this.buildSupport(params, def, customShape);
    const offsetX = support?.placement.x ?? 0;
    const offsetY = support?.placement.y ?? 0;

    let pathZ = textDepth;
    if (type === ModelType.TextWithSupport) {
      pathZ = supportDepth + textDepth;
    } else if (type === ModelType.NegativeText) {
      if (supportDepth < textDepth) {
        supportDepth = textDepth;
      }
      pathZ = supportDepth;
    }
    // Float just above the surface so the guides don't z-fight with the text.
    pathZ += Math.max(0.5, size * 0.01);

    const group = new THREE.Group();
    const centerMaterial = new THREE.LineBasicMaterial({
      color: 0x1f78ff,
      depthTest: false,
      transparent: true,
    });
    const referenceMaterial = new THREE.LineBasicMaterial({
      color: 0x8895a7,
      depthTest: false,
      transparent: true,
      opacity: 0.5,
    });
    const markerMaterial = new THREE.MeshBasicMaterial({
      color: 0x1f78ff,
      depthTest: false,
      transparent: true,
    });
    const markerRadius = Math.max(0.6, size * 0.03);
    const markerGeometry = new THREE.SphereGeometry(markerRadius, 8, 8);

    for (const layout of def.linesLayout) {
      const linePath = linePaths[layout.lineIndex];
      if (isLinePathEmpty(linePath)) {
        continue;
      }

      const profile = buildLineProfile(linePath!.segments);
      const boundaries = segmentBoundaries(linePath!.segments);
      const sEnd = Math.max(layout.width, boundaries[boundaries.length - 1] ?? 0);
      if (sEnd <= 0) {
        continue;
      }

      const baseY = -layout.oy + offsetY;
      const x0 = layout.alignOffset + offsetX;

      // Centerline
      const step = Math.max(1, sEnd / 200);
      const centerPoints: THREE.Vector3[] = [];
      for (let s = 0; s <= sEnd + 1e-6; s += step) {
        const ss = Math.min(s, sEnd);
        centerPoints.push(new THREE.Vector3(x0 + ss, baseY + profile.sample(ss).y, pathZ));
      }
      group.add(
        new THREE.Line(new THREE.BufferGeometry().setFromPoints(centerPoints), centerMaterial),
      );

      // Straight baseline reference
      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x0, baseY, pathZ),
            new THREE.Vector3(x0 + sEnd, baseY, pathZ),
          ]),
          referenceMaterial,
        ),
      );

      // Segment boundary markers
      for (const boundary of boundaries) {
        if (boundary <= 0 || boundary > sEnd + 1e-6) {
          continue;
        }
        const marker = new THREE.Mesh(markerGeometry, markerMaterial);
        marker.position.set(x0 + boundary, baseY + profile.sample(boundary).y, pathZ);
        group.add(marker);
      }
    }

    // Always draw the guides on top of the text.
    group.renderOrder = 999;
    group.traverse((o) => {
      o.renderOrder = 999;
    });

    return group;
  }
}

declare module '@ember/service' {
  interface Registry {
    'text-maker': TextMakerService;
  }
}
