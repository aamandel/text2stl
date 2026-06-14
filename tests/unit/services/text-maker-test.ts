import { module, test } from 'qunit';
import { setupTest } from 'ember-qunit';
import { Box3 } from 'three';
import mockFontManager from 'text2stl/tests/helpers/mock-font-manager';
import mockTextSettings from 'text2stl/tests/helpers/mock-text-maker-settings';
import { ModelType } from 'text2stl/services/text-maker';

import type TextMakerService from 'text2stl/services/text-maker';
import type FontManagerService from 'text2stl/services/font-manager';
import type HarfbuzzService from 'text2stl/services/harfbuzz';

module('Unit | Service | text-maker', function (hooks) {
  setupTest(hooks);

  hooks.beforeEach(async function () {
    mockFontManager(this.owner);
    await (this.owner.lookup('service:harfbuzz') as HarfbuzzService).loadWASM();
    await (this.owner.lookup('service:font-manager') as FontManagerService).loadEmojiFont();
  });

  // Regression: a space is an empty glyph whose bounding box has +∞ on its min
  // corner; mishandling it blew the mesh bounds up to ~1e16 and pushed the
  // preview off-screen.
  test('text containing spaces produces a sensibly-sized mesh', async function (assert) {
    const fontManager = this.owner.lookup('service:font-manager') as FontManagerService;
    const textMaker = this.owner.lookup('service:text-maker') as TextMakerService;
    const font = await fontManager.fetchFont('open_sans', 'regular');

    const model = mockTextSettings({
      text: 'a b c',
      type: ModelType.TextWithSupport,
      size: 45,
    });

    const box = new Box3().setFromObject(textMaker.generateMesh(model, font));
    const width = box.max.x - box.min.x;
    const height = box.max.y - box.min.y;

    const widthOk = Number.isFinite(width) && width > 0 && width < 10000;
    const heightOk = Number.isFinite(height) && height > 0 && height < 10000;
    assert.true(widthOk, `mesh width ${width} is finite and reasonable`);
    assert.true(heightOk, `mesh height ${height} is finite and reasonable`);
  });
});
